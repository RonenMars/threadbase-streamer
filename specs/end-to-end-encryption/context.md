# End-to-end encryption — Context

**Date:** 2026-08-14
**Status:** Approved for implementation 2026-08-14 — see [plan.md](./plan.md), tracked in [threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590) and [threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698).
**Scope:** tb-streamer + tb-mobile
**Seed:** [understanding.md](./understanding.md) — user-approved requirements, authoritative.

Every claim about current behaviour below carries a `file.ts:line` citation against the source, not the docs.
Where a doc and the source disagree, the source is quoted and the drift is recorded in [Open questions](#open-questions).

---

## 1. The problem

A Threadbase session is a live terminal attached to an AI agent with write access to a developer's working tree.
The bytes on that wire are the contents of source files, the agent's reasoning, shell commands and their output, credentials that happen to be printed, and the user's prompts.
The bytes at rest are the same material, indexed for search.

Today all of it is protected by exactly two things: a transport the operator does not control end to end, and one bearer credential.
Neither is a bad control.
Both are single points of total compromise, and the deployment shape the project actively recommends — a Cloudflare Named Tunnel — inserts a third party that holds plaintext by design.

The feature closes the gap between "the traffic is encrypted" and "the traffic is encrypted *to the streamer*".

---

## 2. Current state

### 2.1 Transport

There is no application-layer encryption anywhere.

- WebSocket frames are `JSON.stringify(message)` on the raw socket — `src/ws-hub.ts:50`, `:76`, `:92`.
  The message union carries the full payload in the clear: `terminal_output.data`, `terminal_replay.lines`, `conversation_event.line`, `user_message.text`, `permission.prompt` (`src/types.ts:218-315`).
- REST bodies and responses are plain JSON written straight to the Node `ServerResponse` (`src/api/app.ts:41-42`, and every `routes/*.ts` returning the `ALREADY_HANDLED` sentinel).
- The listener is plain HTTP. The CLI's own banner prints `http://localhost:<port>` and `ws://localhost:<port>/ws` (`cli/index.ts:355-360`), and mobile derives its socket URL by string-replacing the scheme: `url.replace(/^http/, 'ws')` (`tb-mobile/services/ws-client.ts:122`).
  An `http://` server URL therefore yields a `ws://` socket — no TLS at all on the LAN path.
- `validatePublicUrl` requires `https://` for anything non-local (`src/auth.ts:307-325`), but that governs only the *advertised* public URL. It does not constrain what the client actually connects to: mobile's own `assertHttpServerUrl` accepts `http:` and `https:` alike (`tb-mobile/services/pair-exchange.ts:90-92`).

### 2.2 Authentication and authorization

One shared bearer credential, plus a per-device credential that exists but is not yet used by the client.

- The API key is `tb_` + 16 random bytes hex (`src/auth.ts:25-27`), compared in constant time (`src/auth.ts:29-34`).
- It is accepted as `Authorization: Bearer <key>` **or** as `?key=<key>` in the query string, because the WebSocket client cannot set headers (`src/api/middleware/auth.middleware.ts:54-57`).
- Device identity shipped: `authenticate()` resolves a device token first, falling back to the shared key as a `legacy` principal (`src/api/middleware/auth.middleware.ts:71-86`), with capabilities scoped per device (`src/services/security/capabilities.ts:11-18`, `:84-125`).
- **The narrower credential is not in use.** Mobile stores the `deviceToken` at pairing (`tb-mobile/stores/servers.ts:163-165`) and deletes it on removal (`:201`), but never reads it back — every request still sends the shared key (`tb-mobile/services/api-client.ts:200`, `:324`, `:381`, `:521`), and the socket URL is built from the same value (`tb-mobile/services/ws-client.ts:122`).
  So in practice one credential still grants full authority to every paired device, which is the condition [the device-identity design](../../docs/architecture/2026-07-24-device-identity-and-capabilities.md) set out to end.
- The shared key is persisted in `~/.threadbase/server.yaml` as a plaintext line (`src/auth.ts:47`).

### 2.3 Pairing

The QR is the only out-of-band channel, and it authenticates the client to the server but not the server to the client.

- The QR payload is `threadbase://pair?url=<url>&token=<pt_...>&exp=<unix-seconds>` (`cli/index.ts:709`).
  It carries **no server key material**.
- The pair token is `pt_` + 16 random bytes hex, single-use, 180-second TTL, and there is exactly one live token at a time — minting a new one discards the old (`src/pair-store.ts:26`, `:30`, `:42-51`, `:53-63`).
- `POST /api/pair/exchange` is unauthenticated by design (`src/api/middleware/auth.middleware.ts:23`), rate-limited per IP (`src/server.ts:1762-1766`), and returns the API key sealed to the client's X25519 public key with a **server-side ephemeral sender keypair** (`src/seal.ts:24-32`, called at `src/server.ts:1791`).
- The client generates its keypair at exchange time and opens the box with whatever `ephemeralPublicKey` the response carried (`tb-mobile/services/pair-exchange.ts:114-115`, `:175-183`).
  Nothing in that flow lets the client verify *which* server answered.
- The response may also relocate the client: `resolvedUrl = body.publicUrl ?? trimmedUrl` (`tb-mobile/services/pair-exchange.ts:188`), validated only as http-or-https (`:83-93`).

### 2.4 Authorization inside the WebSocket

The socket is authenticated once, at upgrade, and not again.

- `/ws` requires `history:read` (`src/services/security/capabilities.ts:120`) and the middleware runs on `*` (`src/api/app.ts:121`), so the upgrade is gated.
- After that, `handleWsOpen` unicasts the **entire session list** to the socket (`src/server-wiring.ts:597-598`), and `subscribe_session` accepts **any** session id with no per-session check, replaying up to 200 lines of that session's terminal buffer plus its input history (`src/server-wiring.ts:616-630`).
  With one shared credential this is not currently an escalation — every holder already sees everything — but it means the socket has no principal-scoped boundary to inherit once credentials stop being uniform.
- Mobile sends `{ type: 'auth', token }` as its first frame (`tb-mobile/services/ws-client.ts:179`). **The server has no handler for it** — `handleWsMessage` only recognises `register`, `subscribe_session`, and `hold_session` (`src/server-wiring.ts:607-671`), and unknown types fall through the `try` block silently.
  The effect is that the long-term credential is transmitted a second time, in a frame nothing reads.

### 2.5 At rest

Everything the streamer keeps is plaintext on disk.

- `cache.db` holds conversation content directly: `conversation_meta` stores `title`, `first_message`, `last_message`, `preview` (`src/conversation-cache.ts:178-193`), and `conversation_tail.messages_json` stores the last N messages verbatim (`:198-203`).
  A byte-offset index into the source JSONLs sits alongside it (`src/db/migrations/009_create_offset_index.sql`).
- `runtime.db` holds `managed_sessions`, including `session_name` derived from the user's first message and the full `cmdline` of each agent process (`src/db/runtime-migrations/001_create_managed_sessions.sql`).
- `devices` stores only the SHA-256 of each device token (`src/db/migrations/011_create_devices.sql`), which is the one place credential-at-rest is already handled correctly.
- SQLite runs in WAL mode, so `-wal` and `-shm` sidecars hold recent writes; the CLI's `clear-cache` deletes all three explicitly (`cli/index.ts:437`), which is the clearest statement that all three carry data.
- Uploads are written into the user's own project tree at `<projectPath>/.threadbase-uploads/<sessionId>/` (`src/uploads.ts:6`, `:60`), unencrypted, up to 25 MB each (`:7`).
- Logs are pino JSON to `~/.threadbase/logs/` under a supervisor (`src/logger.ts:39-41`). Redaction covers exactly three request headers (`src/logger.ts:10-13`).
  Query values are dropped from the request log unless numeric (`src/api/app.ts:53-57`), which is what keeps `?key=` out of it — that is a deliberate control and must survive any change to the envelope.

### 2.6 Ingress

The recommended production ingress terminates TLS at a third party.

- The documented Named Tunnel maps `https://tb-pc.example.com` → `http://127.0.0.1:8766` (`docs/guides/remote-access/cloudflare.md:109-113`).
  `cloudflared` decrypts the client's TLS at the Cloudflare edge and re-encrypts to the connector; the last hop into the streamer is plain HTTP on loopback.
- Cloudflare Access is the outer ring, the streamer's Bearer check the inner one (`docs/guides/remote-access/cloudflare.md:139`).
  Access authenticates; it does not keep Cloudflare out of the plaintext.
- Quick-tunnels cannot carry Access at all (`docs/guides/remote-access/cloudflare.md:141-147`), so on that path the Bearer token is the only gate — and it crosses the edge in the clear-to-Cloudflare sense on every request, including in the `?key=` query string on the WebSocket upgrade.

---

## 3. Why TLS alone is insufficient

Four distinct reasons, in descending order of how much they matter here.

**1. TLS is terminated by someone who is not an endpoint.**
The project's own recommended deployment routes through Cloudflare (`docs/guides/remote-access/cloudflare.md:74`, `:170-178`).
At the edge, terminal output, conversation text, prompts, file contents, and the `Authorization: Bearer` header are all plaintext to Cloudflare.
This is not a Cloudflare criticism — it is what a reverse proxy is — but it means "we use HTTPS" describes the link, not the conversation.
Anything that can compel or compromise the edge, and any misconfiguration of the tunnel's own ingress rules, reaches the content.

**2. On the LAN there is frequently no TLS at all.**
`ws-client.ts:122` turns `http://` into `ws://`.
The direct-LAN case that `understanding.md` explicitly names is, today, cleartext on the local network, protected only by the bearer token in a query string.

**3. A bearer credential is not a channel binding.**
The API key authenticates *a request*, not *a peer*, and it is replayable by anyone who obtains it.
It appears in a query string (`auth.middleware.ts:56`), which is the position most likely to be captured by an intermediary's logs — and mobile additionally puts it in a WebSocket frame that no server reads (`ws-client.ts:179`).
Encryption keyed to a peer identity is a different property from authorization keyed to a secret string, and only the former survives the secret leaking through a log.

**4. TLS protects nothing at rest.**
Section 2.5 is entirely outside TLS's scope.
A `cache.db` copied off a backup, a synced folder, or a stolen laptop yields conversation titles, previews, and message tails with no credential required.

---

## 4. What E2EE here does and does not mean

This is the sentence most likely to be misread, so it is stated first and plainly.

**The streamer is an endpoint.**
Encryption runs from the paired mobile device to the streamer *process*, and the streamer decrypts, because it must: it drives a PTY, scrapes a rendered terminal, and writes a searchable index.
The agent processes and the model provider are likewise plaintext endpoints and remain so (per `understanding.md`).

So the guarantee is: **no intermediary between the phone and the streamer process holds plaintext** — not Cloudflare, not a TLS-terminating proxy, not a LAN observer, not anything reading the streamer's own request logs.
It is **not** the Signal property, where the server is a relay that never sees content.
Calling it "end-to-end" is accurate only against that definition of the ends, and every user-facing string should say which ends.

---

## 5. Scope

### In scope

| Area | What |
|---|---|
| Transport | Authenticated encryption of REST bodies/responses and all WebSocket payloads, independent of TLS. Covers `https://` via tunnel and plain `http://`/`ws://` on the LAN equally. |
| Pairing | Server authentication at pairing, so the client learns *which* streamer it is talking to; key agreement that binds the transport keys to that identity and to the device record. |
| Key lifecycle | Derivation, per-connection forward secrecy, rotation, and revocation that composes with the existing `devices.revoked_at` (`src/db/migrations/011_create_devices.sql`). |
| At rest | `cache.db`, `runtime.db`, their WAL/SHM sidecars, cache backups, and uploads. |
| Logs | Ensuring the envelope does not put plaintext into the request log, and that the existing `summarizeQuery` protection (`src/api/app.ts:53-57`) is preserved. |
| Negotiation | Capability discovery, the `--no-e2ee` startup opt-out, and downgrade prevention for pairings both sides can do E2EE on. |
| Compatibility | Released mobile builds that predate E2EE keep working, without that path becoming the downgrade. |

### Out of scope

| Area | Why |
|---|---|
| Provider-owned histories (`~/.claude/*.jsonl`, `~/.codex/`) | Not ours to write. They are the authoritative copy the cache is rebuilt from, and encrypting our copy does not change theirs. Covered only by full-disk encryption or provider coordination, per `understanding.md`. |
| Defending against a compromised streamer host | An attacker executing as the streamer user has the keys, the PTYs, and the plaintext by definition. E2EE raises the cost of a compromised *path* and a stolen *disk*, not a compromised host. Stated as a limit, never as a gap to be closed later. |
| Hiding metadata from the ingress | Request paths, sizes, and timing stay visible. Making them opaque means abandoning the hard-coded path contract (`docs/compatibility/tb-mobile.md:9-18`) for a parallel router. Accepted residual, named in the design. |
| Multi-user / multi-tenant separation | Devices belong to one operator (`docs/architecture/2026-07-24-device-identity-and-capabilities.md:56`). Unchanged. |
| The Postgres path | Dormant — only `session_uploads` plus reserved tables. SQLite is the primary persistence layer. |
| Menubar and other localhost clients | `/api/logs` is already localhost-only (`src/api/middleware/auth.middleware.ts:20`) and the menubar polls `/healthz`. Loopback traffic is out of the threat model this feature addresses. |

---

## 6. Constraints the design must respect

1. **`tb-mobile` cannot be force-updated.** Every field name, path, status string, and WS event type in `docs/compatibility/tb-mobile.md` is load-bearing. Additive changes only.
2. **`Authorization: Bearer` and `/ws?key=` must both keep working** (`docs/compatibility/tb-mobile.md:88`), and the `tb_<32-hex>` key format is used for prefix detection in pairing logic (`:90`, and `tb-mobile/services/pair-exchange.ts:38-44`).
3. **Changing the NaCl box format or the pair key exchange is explicitly flagged risky** (`docs/compatibility/tb-mobile.md:115`) — so the existing sealed-API-key response must survive alongside anything new.
4. **`server.yaml` is regex-parsed, one line per key** (`src/auth.ts:142-173`). Any new setting is one line, and a malformed line must cost the setting, not the boot.
5. **Feature flags resolve at boot only** (`src/feature-flags.ts` registry; precedence documented in `CLAUDE.md`). A kill switch is available; hot reload is not.
6. **`better-sqlite3` is synchronous and every statement is timed** (`src/db/query-timing.ts`, threshold `THREADBASE_DB_SLOW_QUERY_MS`, default 35 ms). Any at-rest change must be measured against the existing p50 0.03 ms / p99 0.87 ms baseline rather than assumed cheap.

---

## Open questions

Doc-versus-source drift and unresolved facts found while writing this.
None of these were resolved by assumption.

1. **`capabilities.ts` documents fail-closed; the middleware falls through.**
   The docstring says an unmapped route "DENIES in that case rather than allowing" (`src/services/security/capabilities.ts:78-82`), but `authMiddleware` calls `next()` for `required === null` with a comment explaining why (`src/api/middleware/auth.middleware.ts:96-104`).
   The middleware's reasoning is sound (a 403 on an unknown path leaks its existence) and a test is said to enforce full classification, but the two comments contradict each other and the docstring is the one a reader will trust. Which is intended?

2. **The device token is minted, stored, and never used.**
   `tb-mobile/stores/servers.ts:163-165` writes it; nothing reads it back; every request sends the shared key (`services/api-client.ts:200`).
   Was client adoption deferred, and does E2EE depend on it landing first? The design assumes it does not, and treats the device row as the identity anchor regardless of which credential is presented.

3. **Mobile's `{ type: 'auth', token }` WS frame has no server handler.**
   `tb-mobile/services/ws-client.ts:179` vs `src/server-wiring.ts:607-671`.
   Was there once a handler, or has the client always sent a frame nothing reads? Either way it transmits the long-term credential redundantly and should be removed on the mobile side rather than implemented on the server side.

4. **`loadOrCreateApiKey` creates `server.yaml` without a file mode.**
   `src/auth.ts:47` calls `writeFileSync(configFile(), ..., "utf-8")` with no `mode`, so the *first* creation lands at the process umask (typically 0644).
   Every subsequent write goes through `setConfigValue`/`setApiKey`, which do use `mode: 0o600` and `chmodSync` (`src/auth.ts:170-171`, `:354-355`).
   So a server that never rotates its key keeps a world-readable file holding it. Flagged, not fixed — this review does not change code.

5. **`docs/architecture/2026-07-24-device-identity-and-capabilities.md` cites `src/server.ts:1524-1559` and `:1561` for the pairing handlers.**
   They are now at `src/server.ts:1755-1837` and `:1839` after the server split. The doc is stale on line numbers only; the described behaviour still matches.

6. **The `2026-05-02` WS-push design is silent on subscription authorization** and the implementation has none (`src/server-wiring.ts:616-630`).
   Was that a considered decision under the single-credential model, or an omission that per-device capabilities were expected to close?

7. **Which conversation queries actually persist on the phone.**
   `services/query-client.ts:197-202` puts the `conversation` root on the persist allow-list while the comment above `shouldPersistQuery` says full message bodies are not persisted (`:206-207`).
   The detail screens opt out explicitly (`app/conversation/[id].tsx:164`, `:321`), so the intent holds today — but any *new* query under that root persists to AsyncStorage by default. Is the allow-list or the comment the intended contract?
