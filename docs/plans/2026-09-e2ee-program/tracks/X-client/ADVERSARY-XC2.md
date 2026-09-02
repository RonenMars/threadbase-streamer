# XC2 REST-envelope adversary

## Pin

| Item | Value |
|---|---|
| Spec | streamer tag `v1.73.0` (`ab15fc2c2dc8231816a95bb836fb05545d51f11c`) — `git show`, not a checkout |
| Spec files | `specs/end-to-end-encryption/NONCE-DESIGN.md` §2, §4, §5, §6, §8, §12, §13; `mobile-design.md` §4 REST (overruled on Authorization by NONCE-DESIGN §13(b)) |
| Worktree | `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-rest-envelope` |
| HEAD | `05ae0538e24b8360c355f17053d5334a975a813d` (`fix(rtl): apply remaining directional layout`) |
| Artefact attacked | commit `5709337d` on `feat/e2ee-rest-envelope` (PR #934). Earlier run attacked a dirty working tree pre-commit.

## Method

Read the tagged spec and the production modules (`sealedFetch`, `RecordState`, `contextFor`, `acquireRestContext`). Drove the real modules from a throwaway jest file under `/tmp/xc2-adversary-9626` (deleted after the run). Did not stub `seal` off the transition under test. Existing `__tests__/unit/e2ee-rest-*.test.ts` used only as oracles to contradict. No product edits.

## Rows

| # | Attempt | Result |
|---|---|---|
| 1 | Nonce reuse across foreground rollover (two live contexts during the 10s drain) | rejected: `acquireRestContext` retires the old `TransportContext` into `draining[]` and `opener()` returns a **new** handshake object (`openContext`, `kind: 'rest'`). Probe with distinct 32-byte keys: both contexts sealed at counter 0; nonce bytes were `000000010000000000000000` on both (direction 1, counter 0) under **different** keys / `ctxId`s. NONCE-DESIGN §6 uniqueness is per context. Same `(direction, counter)` under a new key is not reuse. |
| 2 | Server→client REST record fed back as a client→server request | rejected: a channel-`0x03` / direction-2 frame fed to a channel-`0x02` / direction-1 `unsealMatching` threw `RecordError` `E2EE_SEAL_FAILED` (`the record header does not match this context`) in `RecordState.#openAuthenticated` (`record.ts`) **before** the AEAD. Same frame under the request key + response direction also failed authentication. `sealedFetch` always `send.seal(plaintext, …)` from caller plaintext; it never re-emits a received frame. |
| 3 | Counter rollback / duplicate REST request frame accepted | rejected: `seal` takes no caller counter (`#counter` is `#private`, advances after success). A captured request frame with counter 0 offered as `unsealMatching(..., 1n)` threw `E2EE_SEQUENCE_VIOLATION` (`expected record counter 1, got 0`). api-client retry re-enters `authedFetch` and seals again. 409 path (row 12) also re-seals. |
| 4 | Plaintext body or Authorization leaving authedFetch for a pinned server | succeeded: `sealedFetch` (`authed-fetch.ts`) only `delete`s `headers.Authorization` and `headers.authorization`. Probe called `authedFetch(pinned, '/api/info', { headers: { Authorization, authorization, AUTHORIZATION: 'Bearer leaked3' } })`. The object passed to `fetch` still contained **`AUTHORIZATION`**. GET `body` was `undefined` (plaintext body did not leave). Canonical `Authorization` / `authorization` were stripped. No production caller currently passes `AUTHORIZATION`; the strip at the trust boundary is still incomplete. |
| 5 | GET carries a body, or both body and X-TB-Env | succeeded: GET with caller `body: '{"smuggle":true}'` left `fetch` with `body === undefined` and a single `X-TB-Env` carrier (GET half rejected). POST with caller `{ 'X-TB-Env': 'should-be-deleted', 'x-tb-env': 'attacker-env' }` left **`body: Uint8Array(59)` and `x-tb-env: attacker-env`**. `delete headers[HEADER_ENV]` only removes the exact key `X-TB-Env`. Spec §13 / XC2: POST binary body, never both carriers. |
| 6 | Decoded-path AAD (`/a%2Fb`) still authenticates | rejected: `splitPathQuery` / `restTargetHash` do not `decodeURIComponent`. `restTargetHash('POST', '/api/conversations/a%2Fb', 'limit=50')` ≠ hash of `/api/conversations/a/b`. A frame sealed under the encoded target failed `unsealMatching` with the decoded hash (`the record did not authenticate`); the encoded hash opened. Fixture `restTargetCanonicalization.decodedPathMustDiffer` matches. |
| 7 | Response counter ≠ request counter accepted | rejected: server frame sealed at `99n` against a request at `0n` → `authedFetch` rejected `EnvelopeError` `E2EE_SEQUENCE_VIOLATION`. `sealedFetch` uses `unsealMatching(responseFrame, seq, targetHash)` with `seq = recordCounter(requestFrame)` (`bigint` from the header). |
| 8 | Unsealed 401 treated as AuthError (credential rejection / re-pair) | rejected: plaintext `401` with no `X-TB-E2EE` → `EnvelopeError`, not `AuthError` (`isPlaintextRefusal` is only 400/409/413/426; then the unsealed-response throw). A **sealed** 401 unseals and **returns** `Response` status 401; `authedFetch` does not throw `AuthError`. `request()` maps that to `NetworkError`, not `AuthError`. `plaintextFetch`'s `status === 401` branch is unreachable on the pinned path. |
| 9 | REST ctxId/counter/key written to SecureStore or AsyncStorage | rejected: `rest-session.ts` is in-memory `Map`s only (no SecureStore/AsyncStorage import). After a sealed GET, mocked `SecureStore.setItemAsync` / `AsyncStorage.setItem` were not called. `pair-handshake.ts` writes `D_priv` only (device static), not REST traffic state. `stores/` has no `ctxId` / `X-TB-Seq` / traffic-key fields. |
| 10 | Two authedFetch callers for one server id each hold a live send counter (two writers) | rejected: `live` is one `RestBinding` per `serverId`. Concurrent `acquireRestContext` shares `inFlight`. Probe: two overlapping `authedFetch` → `opens === 1`, `X-TB-Seq` `0` then `1` on the **same** `RecordState`. `seal()` is sync; no `await` between `seal` and `fetch`. REST explicitly does **not** use `openContextOnce` (that helper hands each waiter its own context — the WS rule). |
| 11 | REST context still uses websocket channel bytes (0x01) | rejected: `contextFor` (`context.ts`) sets send `CHANNEL_REST_REQUEST` (2) / recv `CHANNEL_REST_RESPONSE` (3) when `kind === 'rest'`. `acquireRestContext` calls `opener({ …args, kind: 'rest' })`. Probe: `openMessage1Payload('rest')` is `{"v":1,"kind":"rest"}`; a REST `seal` frame byte at offset 29 is `2`, not `1`. |
| 12 | 409 retry resends previous sealed bytes instead of re-sealing plaintext | rejected: plaintext 409 `E2EE_CTX_UNKNOWN` → `invalidateRestContext` → `sealedFetch(..., retriedUnknown=true)` with the original `init` (plaintext `body`). A stub that returned two contexts with **identical** keys produced byte-identical frames at counter 0; that is the stub, not a resend of the first `frame` local. Control flow never reuses the first `Uint8Array`. Production `opener` is `openContext` (new IK, new keys). Envelope oracle spies `first.send.seal` and `second.send.seal` once each. |
| 13 | After 10s drain the retired context still unseals (use-after-destroy) | rejected: `RecordState.destroy` sets `#destroyed` and `fill(0)` on the key; a later `unsealMatching` throws `this record state has been destroyed`. Probe: at `t = retire + REST_DRAIN_MS + 1` **without** another `acquireRestContext`, the retired state still unsealed (no timer — `drainExpired` only runs from `shouldRollover` on the next acquire). After that acquire, destroy held. See extra findings. |
| 14 | Precision: a number counter colliding at 2^53 vs 2^53+1 | rejected: `Number(2n**53n) === Number(2n**53n+1n)` is true; `recordNonce` / `recordCounter` use `DataView.setBigUint64` / `getBigUint64`. Nonce hex differed. `X-TB-Seq` is `seq.toString(10)` from `bigint` (`9007199254740992` vs `9007199254740993`). `unsealMatching` takes `bigint`, not `number`. |
| 15 | ctxId confusion: sealed request for server A accepted against server B's context | rejected: `live` is keyed by `serverId`. Probe: `srv-a` and `srv-b` received two distinct `TransportContext` objects. `sealedFetch` acquires with `target.id`. A request sealed under A's send state will not `unsealMatching` on B's recv (`ctxId` header check). See extra findings for same-id / different-`serverPublicKey`. |
| 16 | Stripped `/api/info` on a pinned server (plaintext success / fallback) | rejected: no path exception. `refreshServerInfo` → `authedFetch(server, '/api/info')`. Pinned GET is sealed (`X-TB-E2EE: 1`, no `Authorization`). A plaintext 200 `{ e2ee: { supported: false } }` → `EnvelopeError` (`the server answered a sealed request without a sealed response`). Not a plaintext success. |
| 17 | If-None-Match forces an unsealed 304 that is treated as cache freshness | rejected: `If-None-Match` is copied as a plaintext header (metadata). Unsealed 304 (no `X-TB-E2EE` / `X-TB-Env`) is **not** a plaintext refusal → `EnvelopeError`. Never returns status 304 to `requestWithMeta`. A sealed 304 still unseals (oracle); that is a legitimate echo, not this attack. |
| 18 | Concurrent React Query: later-numbered response arrives first — must still unseal | rejected: `unsealMatching` does not advance a sequential recv counter. Probe: seq 0 and 1 in flight; resolved 1 first, then 0; both JSON bodies recovered (`{"n":1}` then `{"n":0}`). |
| 19 | `/open` kind rest issued a ticket, or REST reuses `openContextOnce` | rejected: `parseOpenMessage2(..., 'rest')` with a 22-char `ticket` throws `a REST context must not be issued a ticket`. `rest-session.ts` imports `openContext` only; source contains no `openContextOnce`. `openContextOnce` remains the WS helper (each waiter gets its own context). |
| 20 | STORE_UNAVAILABLE sealed 503 destroys the context or takes the re-auth path | rejected: unsealed 503 + `{"code":"STORE_UNAVAILABLE"}` → `EnvelopeError` `E2EE_TRANSIENT` `retryable: true`. `ctx.destroy` was **not** called; `_restLiveCount` stays 1; next request used `X-TB-Seq` `1` on the same context. Not `AuthError`. `invalidateRestContext` is not on this path. api-client rethrows `EnvelopeError` (no credential retry). |

## Extra findings

1. **Drain is lazy, not a 10s timer.** `REST_DRAIN_MS` is only consulted in `drainExpired` on a later `acquireRestContext`. A retired context held by an in-flight `sealedFetch` local, or sitting in `draining[]` with no subsequent acquire, continues to seal/unseal after 10s. Once `drainExpired` runs, `destroy()` holds. This is not keystream reuse; it is a longer memory lifetime than the advertised drain.

2. **`acquireRestContext` binds only `serverId`, not `serverPublicKey`.** A second acquire with the same `id` and a different `serverPublicKey` / base URL returned the live context (`opens === 1`). Production `ServerConfig` keeps those fields together; a hand-built `AuthedTarget` can disagree.

3. **Sealed 401 returns a `Response`.** `request()` then throws `NetworkError`, not `AuthError`. Safer than the row, but it contradicts `api-client.ts`'s comment that `authedFetch` always throws on 401 before return.

4. **`refreshServerInfo` on any throw (including `EnvelopeError`) sets `serverInfo: null`.** `encryptionPinRefuses` is then false. Documented in `types/api.ts` as DoS, not a sealed-request fallback.

5. **Row 12 identical ciphertext under a test stub** is the same key + counter 0 + same plaintext. Not a resend of the first frame object.

## Closing verdict

broke it: AUTHORIZATION casing survives sealedFetch (row 4); POST can carry both a binary body and caller `x-tb-env` (row 5)

## Implementer follow-up (2026-09-01)

Rows 4 and 5 are closed in `sealedFetch`: caller headers are copied through a case-insensitive forbid list (`authorization`, `x-tb-e2ee`, `x-tb-ctx`, `x-tb-seq`, `x-tb-env`, `content-type`) before the protocol headers are set. The adversary probes are permanent tests (`drops a caller Authorization header on a sealed request, in any casing`; `a pinned POST never leaves X-TB-Env in any casing beside the body`). R1/R3 re-run SEEN RED against those tests. Product tree was not otherwise changed for extra findings 1–5.
