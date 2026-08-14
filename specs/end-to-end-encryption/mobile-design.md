# End-to-end encryption — Mobile design

**Date:** 2026-08-14
**Status:** Approved for implementation 2026-08-14 — see [plan.md](./plan.md), tracked in [threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590) and [threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698).
**Scope:** tb-mobile. The server half is [design.md](./design.md).
**Seed:** [understanding.md](./understanding.md) (authoritative) · **Current state:** [context.md](./context.md)

Citations to mobile source are relative to `../tb-mobile`; citations to streamer source are relative to this repo.
Every section that changes existing behaviour states what the behaviour is **today**, with a `file.ts:line` citation, first.
Decisions `understanding.md` left open are marked **[Assumption]** and carried into [dilemmas.md](./dilemmas.md).

---

## 1. The client's half of the trust model

The mobile app is one of the two endpoints. It holds:

- its **device static key** `D_priv` — the thing that makes it *this* device rather than any holder of a string;
- the **server identity key** `S_pub` it pinned at pairing, which is what lets it detect an impostor server;
- per-context traffic keys, in memory only;
- the legacy shared API key and the device token, both already in SecureStore (`stores/servers.ts:162-165`).

The app renders plaintext terminal output. It is not, and cannot be, protected against a compromised phone. Everything below is about the *path* and the *phone's disk*, not about the phone's RAM.

---

## 2. Cryptographic dependency

**Today:** `tweetnacl` + `tweetnacl-util`, used only at pairing (`services/pair-exchange.ts:1-2`, `:114-115`, `:175-183`), plus `expo-secure-store` behind `services/secure-store.ts:1`.

**Becomes:** the app needs X25519 (already have), ChaCha20-Poly1305 with AAD, HKDF-SHA256, and a Noise `IK` implementation — none of which `tweetnacl` provides. `tweetnacl.secretbox` is XSalsa20-Poly1305 with no AAD input, so it cannot bind the plaintext header the envelope depends on (design.md §3.3).

**[Assumption] `@stablelib/*` — pure TypeScript, no native module.**
`@stablelib/chacha20poly1305`, `@stablelib/hkdf`, `@stablelib/sha256`, `@stablelib/x25519`.

Why pure JS rather than a native binding (`react-native-libsodium`, `react-native-quick-crypto`):

- The app already ships a `web` platform target (`CLAUDE.md`, "Web Platform"), where a native module has no implementation and the existing pattern is a `.web.ts` shim (`services/secure-store.web.ts`). A JS crypto library works on all three targets with one code path.
- A native module means `pod install`, a `Podfile.lock` change, and the four path-dependent checksums the repo has a whole script to manage (`CLAUDE.md`, "Native Dependencies After Package Changes"). That is real, recurring cost.
- Throughput is the counter-argument and it must be measured, not waved at: terminal output is the hot path, and `terminal_output` frames arrive per PTY chunk. If pure-JS ChaCha20 cannot keep up on a mid-range Android device, the decision flips. See dilemmas.md D-3 — this is the assumption most likely to be overturned by a measurement.

The Noise handshake itself is ~200 lines over those primitives, or a vetted `noise-protocol` package. Handshake cost is once per connection and is not the throughput concern.

---

## 3. Pairing

### 3.1 Today

Three entry points, all converging on the same two functions:

- **QR scan** → `parsePairUri` → `exchangeToken` (`services/pair-exchange.ts:57-81`, `:101-206`).
- **Deep link** — `app/pair.tsx:74` rebuilds a `threadbase://` URI from route params and runs it through the same `parsePairUri`, so a **tapped link** reaches pairing without a camera ever being involved.
- **Manual paste** — `classifyPairCredential` sorts a pasted string into `pair-uri` / `pair-token` / `api-key` (`services/pair-exchange.ts:38-44`); the `api-key` branch bypasses the exchange entirely.

`exchangeToken` generates a fresh `nacl.box` keypair (`:114`), POSTs `{ token, clientPublicKey, deviceName?, readOnly? }`, and opens the sealed box with whatever `ephemeralPublicKey` came back (`:175-183`).
Nothing authenticates the responder.
The result is handed to `addServer`, which writes the API key and device token to SecureStore (`stores/servers.ts:162-165`).

Two details that matter more than they look:

- `assertHttpServerUrl` accepts `http:` as well as `https:` (`services/pair-exchange.ts:90-92`), so a LAN pairing is cleartext.
- `resolvedUrl = body.publicUrl ?? trimmedUrl` (`:188`) — the **server's response decides the URL the app will use from then on**, validated only as http-or-https. Whoever answers the exchange can permanently relocate the client.

### 3.2 Becomes

`parsePairUri` gains two optional fields, and `exchangeToken` gains a handshake:

```ts
export interface PairUri {
  url: string
  token: string
  exp?: number
  serverPublicKey?: string   // `spk` — base64url X25519, 32 bytes
  e2eeVersion?: number       // `v`
}
```

- Absent `spk` ⇒ pre-E2EE server ⇒ today's path exactly, no behaviour change.
- Present `spk` ⇒ run `Noise_IKpsk1_25519_ChaChaPoly_SHA256` with `S_pub = spk` and the pair token as PSK, carried in the additive `e2ee` field of the same request/response (design.md §2.4).
- **A malformed or wrong-length `spk` is a hard error, not a fallback to plaintext.** A downgrade must never be reachable by corrupting one QR parameter.

`ExchangeResult` gains `serverPublicKey`, `deviceStaticKey`, and `e2eeRequired`, and `addServer` persists the first and third to SecureStore beside the existing credentials (`stores/servers.ts:162-165`). `D_priv` goes to SecureStore under its own key and is never returned to a caller.

**The `publicUrl` relocation is closed as a side effect, and deliberately.** Under E2EE, `body.publicUrl` arrives inside the authenticated handshake payload, so only the server holding `S_priv` can set it. For a non-E2EE server the current behaviour is unchanged — but it is now the *only* path with that property, which is a reason to prefer the E2EE path rather than a new risk.

### 3.3 The deep-link and paste paths

`app/pair.tsx:74` means a `threadbase://pair?...` link in a message, an email, or a web page reaches `parsePairUri` with no camera and no user-visible server identity.
That is not new and this design does not remove it — but under E2EE it changes character: a link *without* `spk` can only ever produce an unpinned, plaintext pairing, and a link *with* an attacker's `spk` pairs the user to the attacker's server, which is what the attacker wanted anyway.

The mitigation is not cryptographic, it is a confirmation step: **for a deep link or a pasted credential — never for a camera scan — show the server's identity fingerprint and machine name and require an explicit confirm before `addServer` runs.**
A camera scan is exempt because pointing a camera at a screen *is* the out-of-band channel; a tapped link has no such channel and must borrow the user's attention instead.

The `api-key` paste branch (`services/pair-exchange.ts:43`) produces a server record with no device row and no static key, so it can never be pinned. It stays as the manual escape hatch and is labelled as such in the UI.

---

## 4. Transport

### 4.1 REST

**Today:** `services/api-client.ts` sends `Authorization: Bearer ${server.apiKey}` on every call (`:200`, `:324`, `:381`, `:521`) — the **shared** key, not the device token, which is written at pairing and never read back (`stores/servers.ts:163-165`, `:201`).

**Becomes:** one place changes. Every request already funnels through the same header block in `api-client.ts`, so the envelope wraps there:

1. Ensure a transport context exists for this server (open one lazily, per §4.3).
2. Seal the request body; set `X-TB-E2EE: 1`, `X-TB-Ctx`, `X-TB-Seq`.
3. Unseal the response body before it reaches the existing JSON parsing.

The `Authorization` header stays — it is required by the compatibility contract (`docs/compatibility/tb-mobile.md:88`) and it is what carries the principal. It becomes the **device token** rather than the shared key on E2EE pairings, which finally puts the C5 credential to work.

Everything downstream — React Query, ETag handling (`services/etag-store.ts`), pagination, error mapping — sees exactly the same JSON it sees today. That is the design goal: encryption is a transport concern and must not reach the data layer.

`X-TB-Seq` uses the sliding-window rule (design.md §3.4) precisely because React Query issues concurrent requests; a strict counter would fail on the app's normal behaviour.

### 4.2 WebSocket

**Today:** `connect()` builds `url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?key=' + encodeURIComponent(apiKey)` (`services/ws-client.ts:122`), then on open sends `{ type: 'auth', token: this.apiKey }` followed by `{ type: 'register', clientId }` (`:179-182`).

Two facts about that:

- An `http://` server URL yields a **`ws://`** socket. The LAN path has no TLS at all.
- **The server has no handler for `auth`** — `handleWsMessage` recognises only `register`, `subscribe_session`, and `hold_session` (`src/server-wiring.ts:607-671`), and unknown types fall through silently. The frame transmits the long-term credential for nothing.

**Becomes:**

- `{ type: 'auth', token }` is **deleted**. Not implemented server-side — deleted. It is a credential transmission with no reader.
- The URL becomes `/ws?ticket=<t>`, where the ticket came from the encrypted `/api/e2ee/open` response and is single-use with a 30-second TTL (design.md §3.5). The long-term credential leaves the URL entirely.
- Frames are sealed and unsealed at the `WSClient` boundary — one place, since `socket.onmessage` (`:185`) and `send()` are the only two crossings. Listener registration, the message union, and every `client.on('session_ready', ...)` call site are untouched.
- **Strict counter, no window** (design.md §3.4): a WebSocket is ordered and gap-free, so any counter that is not `expected` is a protocol violation. The client closes and reconnects rather than tolerating it.

`ws://` on a LAN stops being a plaintext exposure once the payloads are sealed, which is the specific case `understanding.md` calls out. The URL scheme does not change — TLS was never the mechanism here.

### 4.3 Context lifecycle on a mobile client

This is where a phone differs from a browser, and where a naive port of the server design would misbehave.

| Event | What happens |
|---|---|
| App foreground | Ensure a context; **rekey** if one already exists and is older than the foreground threshold. |
| App background | Keep the context. Do **not** tear it down — the socket dies on backgrounding anyway (that is the signal the streamer's push suppression relies on, `CLAUDE.md` "Waiting-for-input push"), and re-handshaking on every foreground would add a round trip to the app's slowest moment. |
| Socket reconnect (the existing backoff in `ws-client.ts`) | Reuse the context if unexpired; fetch a **fresh ticket** — tickets are single-use. |
| Context expired or rejected | One transparent re-handshake, then surface the error. Never silently fall back to plaintext. |
| Streamer restarted | Context is gone server-side; the client's first sealed request gets a context-unknown error and re-handshakes once. |
| Server pinned, handshake fails | **Hard, visible failure.** This is the anti-downgrade half that actually matters — a MITM's cheapest attack is to answer as an old server. |

The 2 s HTTP fallback for `terminal_replay` (`docs/architecture/2026-05-02-sessions-ws-push.md:132`, implemented in `hooks/useTerminalStream.ts`) still applies. It falls back to a *different transport*, not to plaintext — the HTTP path is sealed too.

---

## 5. At rest on the phone

### 5.1 Today

| Store | Backing | What is in it |
|---|---|---|
| SecureStore (Keychain / Keystore) | `services/secure-store.ts:1` | Server list and URLs (`stores/servers.ts:109`), API key per server (`:162`), device token per server (`:164`), session names (`stores/sessionNames.ts:35`), drafts (`stores/drafts.ts:27`) |
| AsyncStorage | plain files, **not** encrypted | Settings, view prefs, quick access, the React Query persist cache (`services/query-client.ts:186-190`), the ETag cache (`services/etag-store.ts:3`) |
| localStorage (web only) | `services/secure-store.web.ts` | Everything SecureStore holds, in the clear — the file's own comment says web has no secure enclave |

The React Query persist allow-list is `session`, `conversation`, `project`, `serverInfo` (`services/query-client.ts:197-202`). The comment above `shouldPersistQuery` says full message bodies are not persisted (`:206-207`), and the detail screens do opt out explicitly (`app/conversation/[id].tsx:164`, `:321`) — so the intent holds today. But the `conversation` root is on the allow-list, so any **new** query under it persists by default. That is a latent divergence between the comment and the list (context.md Open question 7).

### 5.2 Becomes

Three changes, smallest first:

1. **`D_priv` goes to SecureStore**, under a per-server key alongside the existing credentials, with `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`. `THIS_DEVICE_ONLY` matters: the default Keychain class syncs to iCloud and restores to a new device, which would make "revoke this lost phone" incomplete. It also intentionally means a device restore requires re-pairing — the correct trade for a key that is a device's identity.
2. **The persist allow-list flips from allow-root to allow-query.** `shouldPersistQuery` (`services/query-client.ts:213-218`) currently persists anything whose root is in the set unless it opts out with `meta: { persist: false }`. Invert it: persist only what opts **in** with `meta: { persist: true }`. Same four roots in practice, but a new conversation query then defaults to *not* persisted, which is what the comment already claims.
3. **`persistBuster` bumps** (`services/query-client.ts:195`) so existing plaintext cache entries are dropped rather than read back.

**Not doing: encrypting AsyncStorage wholesale.** It would mean an encrypted key-value shim under React Query's persister, a key in SecureStore, and a migration — to protect data that, after change 2, is conversation *titles and previews* rather than bodies. On a device with a passcode, iOS and Android already encrypt app data at rest. The honest statement is that this is protection against a *jailbroken or rooted* device, which SecureStore also does not fully survive. Recorded as dilemmas.md D-5 rather than silently skipped.

**Web is explicitly weaker and must say so.** `secure-store.web.ts` puts keys in `localStorage`, readable by any script that achieves XSS on the origin. The web target should either refuse E2EE pairing outright or display a persistent "keys are not hardware-protected on web" banner. It must not silently claim the same guarantee as the native apps.

---

## 6. Capability discovery and downgrade prevention

**Today:** `/api/info` is fetched and parsed for `push`, `claudeFlags`, `featureFlags`, `projectSummary`; an absent field means "unknown, hide the affordance" (`docs/compatibility/tb-mobile.md:96`).

**Becomes:** `e2ee` is read the same way — but with one rule that separates it from every other capability flag.

**`/api/info` is advisory. The pinned bit is authoritative.**

`/api/info` on a not-yet-encrypted connection is attacker-modifiable, so it can be used to *enable* E2EE and never to *disable* it:

```
pinned && server says e2ee unsupported   →  HARD FAILURE. Never connect.
pinned && handshake fails                →  HARD FAILURE. Never fall back.
pinned && server says supported          →  E2EE, as expected.
not pinned && supported                  →  offer to re-pair for encryption.
not pinned && unsupported                →  today's plaintext path, unchanged.
```

The pinned bit lives in SecureStore beside the server record, never in AsyncStorage — AsyncStorage is exactly where an attacker with file access would go to clear it.

### 6.1 The pin is set two ways, not one

Pinning on first successful encrypted connection leaves one case uncovered, and it is the case an attacker picks: a server that has **never** been seen encrypted has no pinned bit to contradict, so a stripped `/api/info` on the very first connection is believed. That is trust-on-first-use, and §3.2's QR key only closes it on the QR path.

So the pin is also **user-settable, ahead of any connection** — a per-server "Require encryption" control (§7). The user knows out of band that their own streamer does E2EE; that knowledge is not on the wire, so it is not the attacker's to modify.

- **Auto-set** on the first successful encrypted connection. Most people will never open the settings screen, and a protection that only exists once someone ticks a box protects almost nobody.
- **User-set** before the first connection, which is what beats first-connection TOFU on the deep-link and paste paths.

Both write the same bit and produce the same hard failure. The control is phrased as a demand — "Require encryption for this server" — and never as a description like "this server is E2EE": a description invites a wrong answer that silently does nothing, while a demand states what happens when the server disagrees.

Clearing it is a deliberate act with a plain-language confirmation naming what is lost. It is legitimate — an operator who has genuinely run `--no-e2ee` needs it — but it is the one control that turns encryption off, so it must never be a stray tap. This does not contradict "no *connect anyway* button" above: the failure screen still has no downgrade affordance. The user has to leave the connection attempt, open that server's settings, and clear the requirement knowing what it means.

**What this does not defend against.** A pin says "this connection must be encrypted", not "this must be *my* server". Repoint the app at a different machine and "require encryption" is satisfied by that machine's encryption. The QR carrying the server's static public key (§3.2) is what binds the identity; the two together are what make either one meaningful.

The hard-failure message has to be specific enough to be actionable and honest enough not to over-claim: name the server, say that it previously supported encryption and now does not, and offer two paths — *retry* and *forget this server and re-pair* — with no "connect anyway" button. A "connect anyway" affordance is the downgrade, wearing a consent dialog.

---

## 7. User-visible surface

Minimal by intent. Encryption that demands attention is encryption people turn off.

- **Pairing** — one line confirming the connection is encrypted, plus the server's identity fingerprint. On the QR path it is confirmation; on the deep-link and paste paths it is the confirmation gate from §3.3.
- **Settings → server** — an encryption row: state, protocol version, fingerprint, and paired-at date, all read-only, plus the one control on this surface: **Require encryption for this server** (§6.1). It backs the pinned bit in SecureStore, is set automatically on the first successful encrypted connection, and can be set by the user beforehand. Lives on the server record in `stores/servers.ts` beside the device token, surfaced in `components/ServerEditModal.tsx`. Clearing it takes a confirmation naming what is lost.
- **Paired devices** (`app/paired-devices.tsx`, backed by `services/devices.ts`) — mark which devices are E2EE-pinned. This is where a user who suspects a photographed QR goes to find the extra device, so it must show `createdAt` prominently.
- **The hard-failure screen** from §6.
- **Nothing else.** No per-session indicator, no badge on the terminal. The one control is the requirement toggle above; the `--no-e2ee` opt-out itself stays a server-operator decision with no mobile control (design.md §6.4) — the toggle governs what *this device* accepts, not what the server does.

Wording constraint, from design.md §1.2: every string says **which** ends. "Encrypted from this device to your computer" is true. "Only you can read your conversations" is false — the streamer, the agent, and the model provider all read them.

---

## 8. Backward compatibility

The app must keep working against every streamer version, and older app versions must keep working against a new streamer.

| Combination | Behaviour |
|---|---|
| New app + old streamer | No `spk` in the QR, no `e2ee` in `/api/info` ⇒ today's plaintext path, unchanged. Never pinned, so never a hard failure. |
| Old app + new streamer | Ignores `spk`/`v` in the QR (`parsePairUri` reads named params, `services/pair-exchange.ts:70-80`), ignores `e2ee` in the exchange response and in `/api/info`, uses the still-present sealed API key. Server does not pin it. Unchanged. |
| New app + new streamer, `--no-e2ee` | `/api/info` reports `enabled: false` with a reason. An unpinned app pairs plaintext with a warning. A pinned app gets `426` and the hard-failure screen — correct, and the reason the server prints a boot warning naming the pinned-device count. |
| New app + new streamer, normal | Full path. |
| Any app + streamer at stage 3 | An unpinned client gets `426 E2EE_REQUIRED`. Old apps cannot render that; they will show a generic error. This is why stage 3 is an explicit product decision with a minimum app version (design.md §7). |

Nothing in `docs/compatibility/tb-mobile.md` is renamed, removed, or retyped by this design.

---

## 9. Test plan

| Requirement | Test |
|---|---|
| Server authentication | A handshake whose responder key differs from the QR's `spk` fails; the app shows the impostor-server error, not a generic network error. |
| Old QR | A QR without `spk` pairs exactly as today. |
| Malformed `spk` | Rejected as an error; never a silent plaintext pairing. |
| Deep-link gate | A `threadbase://pair` deep link shows the confirmation step; a camera scan does not. |
| Envelope | Every `api-client` call and every `ws-client` frame is sealed; a unit test asserts no plaintext body leaves either module on a pinned server. |
| WS ordering | A duplicated or out-of-order frame closes and reconnects rather than being accepted. |
| REST concurrency | Concurrent React Query requests with out-of-order arrival all succeed. |
| Downgrade | A pinned server answering `e2ee.supported: false` produces the hard-failure screen with no "connect anyway" path. |
| Key storage | `D_priv` is in SecureStore with `THIS_DEVICE_ONLY`, never in AsyncStorage, never logged, never in a Sentry breadcrumb. |
| Persist inversion | A query with no `meta.persist` does not reach AsyncStorage; `persistBuster` drops the old cache. |
| Rekey | Foreground after the threshold rekeys; counters reset only as part of it. |
| Revocation | A revoked device's live socket closes without the app retrying into a loop. |
| Web target | Web either refuses E2EE pairing or shows the weaker-storage banner. |
| No regression | The full existing suite passes: unit, integration, and the Maestro mock suite (`npm run test:e2e:mock`) — all three, per the repo's own guidance that `test:unit` alone is a false green. |

---

## 10. Known limits

- **A compromised phone defeats this.** The app renders plaintext; jailbreak/root reaches it.
- **Pure-JS ChaCha20 throughput on the terminal stream is unproven.** The single most likely reason this design changes (dilemmas.md D-3).
- **Web is materially weaker** — `localStorage`, no enclave (`services/secure-store.web.ts`).
- **The deep-link pairing path remains reachable** and is mitigated by a confirmation step, which is a human control, not a cryptographic one.
- **The `api-key` paste path can never be pinned**, by construction — there is no exchange and no device row.
- **Metadata is visible to the ingress** (design.md §3.2). The app cannot fix that.
