# tb-streamer — STRIDE security design review: end-to-end encryption

**Date:** 2026-08-14
**Subject:** [specs/end-to-end-encryption/](../../specs/end-to-end-encryption/) — `context.md`, `design.md`, `dilemmas.md`
**Scope:** the streamer's half of the mobile ↔ streamer boundary. The client half is `tb-mobile/docs/security/2026-08-14-mobile-review.md`.
**Process:** `agent-skills:security-and-hardening` — Threat Model First (boundaries → assets → STRIDE per boundary → abuse cases), with `security-scanning`'s `stride-analysis-patterns`, `attack-tree-construction`, `threat-mitigation-mapping`, `security-requirement-extraction`, and the STRIDE-GPT category framework.
**DREAD:** the rubric supplied for this review — 1–10 on Damage, Reproducibility, Exploitability, Affected users, Discoverability; ranked by sum.

This reviews a design the same session authored, so it is written adversarially.
A threat the design mitigates is still in the table, with the mitigation named.
A gap the design leaves is in the table marked **GAP** and in Open questions — not quietly patched.

---

## 1. System context

The streamer is a Node/TypeScript server on a developer's own machine.
It spawns Claude Code and Codex CLI processes in a PTY (`src/pty-manager.ts`, `src/codex-pty-runner.ts`), broadcasts their terminal output over a WebSocket (`src/ws-hub.ts`), serves a REST API (`src/api/app.ts`), and maintains a SQLite index of conversation history (`src/conversation-cache.ts`).

The remote control is a released iOS/Android React Native app that cannot be force-updated (`docs/compatibility/tb-mobile.md:3`).

Two ingress paths, both in scope:

- **Public** — a Cloudflare Named Tunnel mapping `https://<host>` to `http://127.0.0.1:8766` (`docs/guides/remote-access/cloudflare.md:109-113`), optionally behind Cloudflare Access. TLS terminates at the Cloudflare edge.
- **Direct LAN** — plain `http://` and `ws://`, because mobile derives the socket URL by string-replacing the scheme (`tb-mobile/services/ws-client.ts:122`). No TLS at all.

The agent processes the streamer drives can be configured with `bypassPermissions` or `dontAsk` (`src/claude-flags.ts`), which the repo's own documentation describes as turning every session into unattended arbitrary code execution, with no spend cap (`CLAUDE.md`, "CLI flags vs. `server.yaml`" → Security).
That is the impact ceiling for anything that reaches session input.

The proposed design adds a Noise `IKpsk1` handshake keyed by a server identity key carried in the pairing QR, a ChaCha20-Poly1305 record layer with counter nonces, and page-level encryption of the two SQLite databases.

---

## 2. Assets

Ranked by what an attacker gains, not by how the code is organised.

| # | Asset | Where it lives today | Why it matters |
|---|---|---|---|
| A1 | **Live session input** | `POST /api/sessions/:id/input`; `sendKeys` into the PTY | Writing to it is arbitrary code execution on the developer's machine when a bypass permission mode is set. The highest-value asset in the system, and it is a *write* target, not a read target. |
| A2 | **The shared API key** | `~/.threadbase/server.yaml` (`src/auth.ts:36-49`); sealed to every pairing client (`src/server.ts:1791`) | Carries `admin` (`src/services/security/capabilities.ts:63-69`) — rotate the key, revoke devices, change Claude flags. Grants A1. |
| A3 | **Terminal output stream** | `terminal_output`, `terminal_replay` over `/ws` (`src/types.ts:223`, `:275`) | Source code, shell output, env vars, anything a tool prints. Continuous and high volume. |
| A4 | **Conversation history at rest** | `conversation_meta.first_message` / `last_message` / `preview`, `conversation_tail.messages_json` (`src/conversation-cache.ts:178-203`) | Verbatim message content, searchable, in one portable file. |
| A5 | **Server identity private key** (new) | `~/.threadbase/keys/server-identity.key` (design §2.2) | Holding it allows impersonating the streamer to a pinned device. |
| A6 | **At-rest database key** (new) | `~/.threadbase/keys/db.key` (design §5.3) | Decrypts A4. |
| A7 | **Device tokens** | SHA-256 only (`src/db/migrations/011_create_devices.sql`) | Already handled correctly. Listed to confirm the design does not regress it. |
| A8 | **Pair tokens** | In memory, one at a time, 180 s (`src/pair-store.ts:26`, `:30`) | Short-lived, but a live one converts to A2. |
| A9 | **Session registry** | `managed_sessions` — `session_name`, `cmdline`, `project_path` (`src/db/runtime-migrations/001_create_managed_sessions.sql`) | Not rebuildable. Reveals what the developer works on. |
| A10 | **Uploads** | `<projectPath>/.threadbase-uploads/<sessionId>/` (`src/uploads.ts:60`) | User-supplied files, in the user's git working tree, unbounded retention. |
| A11 | **Routing metadata** | Request paths, sizes, timing | Not protected by the design (§3.2). Reveals which sessions are active and when. |

---

## 3. Trust boundaries

```
                     ┌─ TB-1 ─────────────────────────────────┐
   Mobile app  ══════╪══ public internet ══► Cloudflare edge ═╪══► cloudflared ──┐
   (endpoint)        │   (TLS, terminated AT the edge)         │                  │
                     └─────────────────────────────────────────┘                  │
                                                                                  │ TB-2
                     ┌─ TB-3 ─────────────────────┐                    plain HTTP │
   Mobile app  ══════╪══ LAN, http:// + ws:// ════╪════════════════════ loopback ─┤
   (endpoint)        │   no TLS at all             │                              │
                     └─────────────────────────────┘                              ▼
                                                                        ┌──────────────────┐
   QR on screen ─── TB-4: optical, out-of-band ──► Mobile camera         │  Streamer proc.  │
                                                                        │   (endpoint)     │
   Other local user / process ─── TB-5: host filesystem ────────────────►│                  │
                                                                        └────────┬─────────┘
                                                                         TB-6    │  TB-7
                                                                 PTY / agent ◄───┤───► SQLite,
                                                                 (plaintext,     │     logs, uploads
                                                                  trusted)       │     (host disk)
```

| ID | Boundary | Untrusted side | Today |
|---|---|---|---|
| **TB-1** | Mobile ↔ Cloudflare edge ↔ connector | Everything between the two endpoints | Plaintext to Cloudflare. The design's primary target. |
| **TB-2** | connector → `127.0.0.1:8766` | Loopback | Plain HTTP. Any local process can also reach the port. |
| **TB-3** | Mobile ↔ streamer over LAN | The local network | Fully cleartext, credential in the query string. |
| **TB-4** | QR → camera (or deep link → app) | Anyone who can see the screen, or send a link | Token only, no server key. The design adds `spk` here. |
| **TB-5** | Host filesystem | Other users / processes on the box | `server.yaml`, `cache.db`, `runtime.db`, logs, uploads — all plaintext. |
| **TB-6** | Streamer ↔ agent process | Trusted by definition | Out of scope; the agent *is* the workload. |
| **TB-7** | Streamer ↔ its own disk | Backups, sync folders, stolen media | Plaintext. The design's second target. |

**The boundary the design does not move:** TB-6. The streamer decrypts because it drives a PTY and scrapes a rendered screen. Every user-facing string must say which ends (design §1.2).

---

## 4. STRIDE threats

`Mit` = mitigated by the design (section cited) · `GAP` = the design leaves it open · `RES` = accepted residual, named in the design.

| ID | Cat | Threat | Affected component | Assumption relied on | Status |
|---|---|---|---|---|---|
| **TB-S-01** | E | A photographed QR, redeemed inside the 180 s window, returns the **shared admin key** — the attacker can then revoke the owner's devices and rotate the key, locking them out of their own machine | `handlePairExchange` seals `this.apiKey` (`src/server.ts:1791`); `legacyPrincipal()` grants `admin` (`src/services/security/capabilities.ts:63-69`) | That stage 2 lands and the E2EE path stops returning the shared key. Until then, that the QR is never in view of a camera or a screen-share | **GAP until stage 2** (design §6.4, §7) |
| **TB-S-02** | T→E | On-path injection of input into a live session; with `bypassPermissions` this is arbitrary code execution on the dev machine | `/ws`, `POST /api/sessions/:id/input`; TB-1 and TB-3 | That AEAD + AAD are implemented correctly and the unseal middleware cannot be bypassed | **Mit** (design §3.3, §3.6) |
| **TB-S-03** | I | Cloudflare edge (or any TLS-terminating proxy) holds terminal output, conversation content, prompts, and the bearer token in plaintext | Tunnel ingress, `docs/guides/remote-access/cloudflare.md:109-113` | That the record layer covers *all* WS payloads and REST bodies, not a subset | **Mit for content, RES for metadata** (design §3.2) |
| **TB-S-04** | E | `hold_session` over the WebSocket has **no capability check** — any socket that passed the `history:read` gate can SIGINT and dispose any session by id | `src/server-wiring.ts:669-671` vs `src/services/security/capabilities.ts:120` | None. This is unguarded today | **GAP** — pre-existing, not introduced or closed by the design |
| **TB-S-05** | I | `subscribe_session` accepts any session id with no per-session or per-project scoping, replaying 200 lines plus input history | `src/server-wiring.ts:616-630` | That every principal is entitled to every session — true under one shared key, false once read-only devices are actually issued | **GAP** — pre-existing |
| **TB-S-06** | E | An unclassified route falls through to its handler rather than denying, contradicting the fail-closed docstring | `src/api/middleware/auth.middleware.ts:96-104` vs `src/services/security/capabilities.ts:78-82` | That a test asserts every mounted `/api` route is classified. The guarantee lives in a test, not in the runtime | **GAP** — pre-existing |
| **TB-S-07** | I | A copied `cache.db` / `runtime.db` — from a backup, a sync folder, a support bundle, or stolen media — yields verbatim conversation content | `src/conversation-cache.ts:178-203`; `src/db/runtime-migrations/001_create_managed_sessions.sql` | That the key file is never in the same backup as the database | **Mit** (design §5.2), residual per dilemma D-6 |
| **TB-S-08** | D | `POST /api/e2ee/open` is public and performs X25519 + AEAD **before** any authentication, with no rate limit specified. `better-sqlite3` is synchronous, so a stalled event loop stalls everything | design §3.5. Contrast `/api/pair/exchange`, which rate-limits (`src/server.ts:1763`) and consumes the token (`:1783`) *before* sealing (`:1791`) | None — the design simply does not say | **GAP — introduced by the design** |
| **TB-S-09** | D | Unbounded transport-context allocation: each context holds keys plus a 1024-bit replay window, with no cap | design §3.5, §4.2 | None | **GAP — introduced by the design** |
| **TB-S-10** | D | Per-socket sealing turns `broadcast`'s single `JSON.stringify` into N seals on the terminal-output hot path, reversing the optimisation `broadcastToClients` exists for | `src/ws-hub.ts:49-63`, `:70-73`; design §3.6 | That ChaCha20 at terminal-chunk sizes is negligible. Stated as "must be measured", and it has not been | **GAP — introduced, unmeasured** |
| **TB-S-11** | D | Strict WS counter closes the socket on any anomaly, so a duplicating or reordering intermediary turns a transient glitch into a reconnect loop | design §3.4 | That a single TCP connection is ordered and gap-free through the entire RN + proxy stack | **RES** (dilemma D-2 names the flip condition) |
| **TB-S-12** | S | Pre-E2EE / unpinned pairing has no server authentication — `seal()` uses an ephemeral sender key the client cannot verify | `src/seal.ts:24-32`, `src/server.ts:1791` | That the legacy path is retired at stage 3 | **Mit for E2EE pairings** (design §2.3), open on the legacy path through stage 2 |
| **TB-S-13** | T | The exchange response relocates the client permanently — `publicUrl` is returned unauthenticated and mobile adopts it as the server URL | `src/server.ts:1829`, consumed at `tb-mobile/services/pair-exchange.ts:188` | That the E2EE path carries `publicUrl` inside the authenticated handshake payload | **Mit on the E2EE path** (design §3.2 of mobile-design), open on the legacy path |
| **TB-S-14** | R | Session-control actions are unattributable — nothing records which principal sent a given `POST /api/sessions/:id/input`, and the pairing log carries `ip`/`ts` only | `src/server.ts:1799-1803`; no principal in the request log (`src/api/app.ts:109-118`) | That `deviceId` at pairing is enough. It is not — pairing is one event, input is every event | **GAP — the design adds pairing attribution but not action attribution** |
| **TB-S-15** | I | Request paths, session ids inside paths, response sizes, and timing stay visible at the ingress | design §3.2, dilemma D-7 | That traffic analysis is not in the threat model | **RES — accepted and named** |
| **TB-S-16** | I | `loadOrCreateApiKey` writes `server.yaml` with no file mode, so the *first* creation lands at the process umask (typically 0644) and the admin key is readable by any local user until a rotation rewrites it at 0600 | `src/auth.ts:47` vs `:170-171`, `:354-355` | None | **GAP** — pre-existing; reported, not fixed (this review does not change code) |
| **TB-S-17** | T/E | The unseal middleware runs **pre-auth** and parses attacker-controlled headers and ciphertext on a process that spawns shells | design §3.6, dilemma D-9 | That the middleware rejects on unknown `ctxId` before allocating, bounds body size before decryption, and never allocates on an attacker-supplied length | **RES — named in D-9, with the hardening rules stated** |
| **TB-S-18** | S | A live WebSocket survives device revocation: the socket is authenticated once at upgrade and never re-checked | `src/api/app.ts:121` → `src/services/security/capabilities.ts:120`; no re-check in `src/server-wiring.ts:607-671` | None today | **Mit** (design §4.4, point 3) |
| **TB-S-19** | I | `/api/logs` and `/api/logs/meta` are unauthenticated for any localhost caller, so any local process reads the streamer's logs | `src/api/middleware/auth.middleware.ts:20`, `:42-45` | That loopback is trusted. TB-2 says it partly is; a multi-user or container host says otherwise | **GAP** — pre-existing, out of the design's stated scope |
| **TB-S-20** | I | Uploads persist unencrypted inside the user's git working tree with no retention bound | `src/uploads.ts:60`; dilemma D-4 | That the user's own repo is already an acceptable place for their own files | **GAP — deliberately left open, D-4** |
| **TB-S-21** | D | Page-level encryption pushes query times past `THREADBASE_DB_SLOW_QUERY_MS` (35 ms), flooding the log — the 261 MB unrotated-log precedent is in `CLAUDE.md` | `src/db/query-timing.ts`; design §5.2 | That the measured p50 0.03 ms / p99 0.87 ms baseline has enough headroom | **RES — design requires measurement, none taken yet** |
| **TB-S-22** | T | Downgrade: an on-path attacker strips `e2ee` from `/api/info`, strips `spk` from a relayed QR, or simply answers as a pre-E2EE server | `src/api/routes/misc.routes.ts:141-166`; design §6.3 | **That the client honours its pinned bit.** The server-side `426` is necessary but not sufficient — the enforcement that matters is on the device | **Mit, but the load-bearing half is client-side** |
| **TB-S-23** | E | `--local-no-auth` returns `next()` for any loopback caller **before** the capability check runs, so any local process gets unauthenticated full access — and the design never says whether a pinned device's `426` applies on that path | `src/api/middleware/auth.middleware.ts:47-52`, returning ahead of the capability check at `:92-108` | That loopback is trusted while the flag is on. Partly guarded already: `/api/auth/rotate` (`src/api/routes/misc.routes.ts:172-175`) and `PUT /api/config/claude-flags` are refused while it is active | **GAP — pre-existing, and the design's interaction with it is unspecified** |
| **TB-S-24** | T | Permission gates are detected by scraping the *rendered* terminal screen, so content the agent prints can influence what the streamer believes is a gate and which options it offers a phone | `detectGateScreen` in `src/pty-manager.ts`; the bottom-up last-option-block scan exists precisely because prose above a gate can contain a matching numbered list (`CLAUDE.md`, pty-manager) | That the screen parser is not confusable by agent-printed content, e.g. from a hostile file the agent reads. E2EE protects the channel, not the parser | **GAP — orthogonal to this design, but it sits directly under the A1 asset** |
| **TB-S-25** | I | The unseal middleware becomes an oracle if it distinguishes "unknown context", "bad sequence", and "tag mismatch" by status code, message, or timing | design §3.6, dilemma D-9 | That every failure answers identically and in constant-ish time. Not currently specified | **GAP — introduced by the design** |

### Abuse cases

Written next to the use cases they invert, per the skill's step 4.

| Use case | Abuse case | Covered by |
|---|---|---|
| "Pair my phone by scanning the QR on my terminal" | "Photograph the QR over the owner's shoulder, or from a screen-share recording, and redeem it first" | TB-S-01 |
| "Send a prompt to my agent from my phone" | "Send a prompt to someone else's agent from the coffee-shop Wi-Fi" | TB-S-02 |
| "Expose my streamer publicly through a tunnel" | "Read every developer's terminal from the position the tunnel provider occupies" | TB-S-03 |
| "Pair a read-only device to glance at status" | "Use that read-only device to kill every running session" | TB-S-04 |
| "Watch a session's terminal from my phone" | "Watch *every* session, including the one for a project this device was never meant to see" | TB-S-05 |
| "Turn E2EE off for a local debugging run" | "Convince a pinned device that the server never supported E2EE" | TB-S-22 |
| "Back up my conversation cache" | "Read the backup" | TB-S-07 |
| "Report which device did what" | "Do something and be indistinguishable from the owner's own phone" | TB-S-14 |
| "Open an encrypted connection" | "Open ten thousand of them and stall the event loop" | TB-S-08, TB-S-09 |

---

## 5. DREAD scores

Rubric: 1–10 each on **D**amage, **R**eproducibility, **E**xploitability, **A**ffected users, **D**iscoverability. Ranked by sum.
Every score of 8 or above carries a one-line justification below the table.

| Rank | ID | Cat | D | R | E | A | Di | **Sum** |
|---|---|---|---|---|---|---|---|---|
| 1 | TB-S-03 | I | 9 | 10 | 3 | 9 | 9 | **40** |
| 2 | TB-S-01 | E | 10 | 8 | 7 | 6 | 7 | **38** |
| 3 | TB-S-02 | T→E | 10 | 9 | 6 | 7 | 5 | **37** |
| 4 | TB-S-07 | I | 8 | 9 | 5 | 8 | 6 | **36** |
| 4 | TB-S-14 | R | 5 | 10 | 10 | 8 | 3 | **36** |
| 6 | TB-S-05 | I | 7 | 10 | 9 | 4 | 5 | **35** |
| 6 | TB-S-08 | D | 6 | 9 | 8 | 7 | 5 | **35** |
| 8 | TB-S-04 | E | 6 | 10 | 9 | 4 | 5 | **34** |
| 8 | TB-S-16 | I | 9 | 9 | 8 | 4 | 4 | **34** |
| 10 | TB-S-12 | S | 9 | 7 | 5 | 6 | 6 | **33** |
| 10 | TB-S-22 | T | 9 | 7 | 5 | 6 | 6 | **33** |
| 12 | TB-S-15 | I | 4 | 10 | 3 | 8 | 7 | **32** |
| 12 | TB-S-23 | E | 8 | 9 | 7 | 3 | 5 | **32** |
| 14 | TB-S-09 | D | 6 | 8 | 7 | 6 | 4 | **31** |
| 14 | TB-S-13 | T | 8 | 8 | 5 | 5 | 5 | **31** |
| 14 | TB-S-18 | S | 7 | 9 | 6 | 5 | 4 | **31** |
| 17 | TB-S-19 | I | 4 | 9 | 8 | 6 | 3 | **30** |
| 18 | TB-S-17 | T/E | 9 | 5 | 4 | 7 | 3 | **28** |
| 18 | TB-S-20 | I | 5 | 9 | 5 | 5 | 4 | **28** |
| 20 | TB-S-06 | E | 7 | 8 | 5 | 3 | 4 | **27** |
| 20 | TB-S-24 | T | 7 | 6 | 4 | 6 | 4 | **27** |
| 22 | TB-S-25 | I | 3 | 8 | 5 | 6 | 3 | **25** |
| 23 | TB-S-10 | D | 5 | 7 | 4 | 5 | 3 | **24** |
| 23 | TB-S-21 | D | 4 | 6 | 3 | 7 | 4 | **24** |
| 25 | TB-S-11 | D | 5 | 6 | 3 | 5 | 3 | **22** |

**Justifications for scores ≥ 8**

- **TB-S-03 D=9** — terminal output routinely contains source, environment variables, and secrets echoed by tooling; the edge sees all of it.
- **TB-S-03 R=10** — this is not an exploit, it is the normal data path: every request, every day, by design.
- **TB-S-03 A=9** — the Named Tunnel is the repo's own recommended always-on ingress (`docs/guides/remote-access/cloudflare.md:74`).
- **TB-S-03 Di=9** — the repo's own guide documents the `http://127.0.0.1:8766` mapping in plain text.
- **TB-S-01 D=10** — the credential returned is `admin` on a machine running an agent with filesystem write and shell access.
- **TB-S-01 R=8** — given the photo, redemption is one deterministic HTTP POST with no timing or race.
- **TB-S-02 D=10** — injected input into a `bypassPermissions` session is unattended arbitrary code execution, and the repo documents that there is no spend cap.
- **TB-S-02 R=9** — replaying a captured bearer against a hard-coded, documented endpoint path is deterministic.
- **TB-S-07 D=8** — `conversation_tail.messages_json` is verbatim message content, not a summary.
- **TB-S-07 R=9** — reading a copied SQLite file succeeds every time, with `sqlite3` and no exploit.
- **TB-S-07 A=8** — every installation writes this file by default.
- **TB-S-14 R=10 / E=10** — it is the absence of a control rather than an exploit, so it holds on every request without any attacker effort.
- **TB-S-14 A=8** — every deployment; nothing records the acting principal today.
- **TB-S-05 R=10 / TB-S-04 R=10** — a single well-formed JSON frame on an already-open socket.
- **TB-S-05 E=9 / TB-S-04 E=9** — no crypto, no race, no privilege beyond having a socket.
- **TB-S-08 E=8** — an unauthenticated public endpoint doing asymmetric crypto is reachable with a `curl` loop.
- **TB-S-16 D=9** — the exposed value is the shared admin key.
- **TB-S-16 R=9 / E=8** — reading a file with default permissions is deterministic and requires no exploit.
- **TB-S-12 D=9 / TB-S-22 D=9** — both hand the attacker the admin credential and a durable relay position; a downgrade re-enables every plaintext threat at once.
- **TB-S-15 R=10** — metadata exposure is continuous and unconditional.
- **TB-S-15 A=8** — applies to every deployment behind any ingress.
- **TB-S-13 D=8** — the redirection is persisted, so it outlives the attacker's on-path position.
- **TB-S-18 R=9** — an already-open socket simply keeps working; no attacker action is needed.
- **TB-S-09 R=8 / TB-S-19 R=9 / TB-S-20 R=9 / TB-S-06 R=8 / TB-S-25 R=8** — each is a deterministic property of the code path rather than a probabilistic exploit.
- **TB-S-19 E=8** — any local process can issue the request; there is no credential to obtain.
- **TB-S-17 D=9** — a parsing bug in a pre-auth path on a process that spawns shells is an unauthenticated path to A1.
- **TB-S-23 D=8** — any local process reaches session input, which is asset A1, with no credential at all.
- **TB-S-23 R=9** — a plain HTTP request from localhost; deterministic while the flag is on.

---

## 6. Attack trees — top 3 by DREAD

Notation per `attack-tree-construction`: `(OR)` any child suffices, `(AND)` all children required.
Leaf attributes: **skill** / **cost** / **detection risk**.

### 6.1 TB-S-03 (40) — Read every developer's terminal from the ingress

```
[GOAL] Obtain plaintext terminal output and conversation content in transit
  │
  ├── (OR) A. Occupy the TLS-termination point
  │     ├── A1. Be the tunnel provider — plaintext by design       skill: none  / cost: n/a / detect: none
  │     │       └── docs/guides/remote-access/cloudflare.md:109-113
  │     ├── A2. Compromise the Cloudflare account and add an
  │     │       ingress rule or a second connector                 skill: med   / cost: $$  / detect: med
  │     │       └── (AND) obtain CF credentials  +  tunnel is named, not quick
  │     ├── A3. Compromise the host running `cloudflared` and read
  │     │       the loopback hop (TB-2)                            skill: med   / cost: $   / detect: low
  │     └── A4. Insert a corporate TLS middlebox on the client path skill: low  / cost: $   / detect: low
  │
  ├── (OR) B. Skip the tunnel — take the LAN path
  │     ├── B1. Passive capture of ws:// on a shared network       skill: low   / cost: $   / detect: none
  │     │       └── tb-mobile/services/ws-client.ts:122
  │     └── B2. ARP/DNS spoof to become on-path                    skill: low   / cost: $   / detect: low
  │
  └── (OR) C. Defeat the E2EE that closes A and B
        ├── C1. Downgrade the client to plaintext  ──► see TB-S-22, and 6.3 below
        ├── C2. Obtain the server identity key from the host       skill: high  / cost: $$$ / detect: low
        │       └── requires TB-5 access; key file is 0600 (design §2.2)
        └── C3. Break ChaCha20-Poly1305 / X25519                   skill: n/a   / cost: ∞   / detect: n/a
```

**Where the design cuts the tree:** branches A and B are severed for content by §3 — the edge and the LAN observer both see ciphertext.
Neither is severed for **metadata** (TB-S-15): A1 still learns which endpoints, how often, and how large.
Branch C is what the rest of the design defends, and **C1 is the cheapest surviving path** — which is why the client-side hard-fail (§6.3) is the single most load-bearing control in this whole design and why it lives in the *other* repo.

### 6.2 TB-S-01 (38) — Admin takeover via a photographed QR

```
[GOAL] Hold the shared API key (admin) on someone else's streamer
  │
  ├── (AND) A. Redeem a live pair token
  │     ├── A1. Obtain the token
  │     │     ├── (OR) A1a. Photograph the terminal QR             skill: none / cost: $ / detect: none
  │     │     ├──      A1b. Capture it from a screen-share or a
  │     │     │              recorded demo                          skill: none / cost: $ / detect: none
  │     │     ├──      A1c. Read it from terminal scrollback — the
  │     │     │              CLI also prints the Pair URL as text
  │     │     │              (cli/index.ts:713)                     skill: low  / cost: $ / detect: none
  │     │     └──      A1d. Capture it in transit on TB-1/TB-3
  │     │                    during a legitimate pairing            skill: med  / cost: $ / detect: low
  │     ├── A2. Reach the server URL                                skill: none / cost: $ / detect: none
  │     │     └── the URL is in the same payload as the token
  │     └── A3. Beat the legitimate phone and the 180 s TTL         skill: none / cost: $ / detect: MED
  │           └── consume() is single-use (src/pair-store.ts:60-62), so
  │               losing this race is the owner's only warning signal today
  │
  └── (OR) B. Convert the pairing into durable admin
        ├── B1. Use the sealed API key directly — it IS admin       skill: none / cost: $ / detect: low
        │       └── src/server.ts:1791 + capabilities.ts:63-69
        ├── B2. Rotate the key to lock the owner out                skill: none / cost: $ / detect: HIGH
        │       └── POST /api/auth/rotate, admin-scoped
        ├── B3. Revoke the owner's real devices                     skill: none / cost: $ / detect: high
        └── B4. Set claudeFlags.permissionMode = bypassPermissions,
                then drive a session                                skill: low  / cost: $ / detect: med
                └── PUT /api/config/claude-flags, admin-scoped
```

**Where the design cuts the tree:** nowhere in branch A — a photographed QR still pairs, and §2.6 says so.
It cuts **B1**, and only at stage 2, by not returning the shared key on the E2EE path.
That is the important observation: the design's answer to the QR threat is not prevention but **blast-radius reduction plus detection**, and both halves are currently scheduled rather than built. A3's detection signal is a bare 401 string today (`src/server.ts:1784-1787`) with no log line at all.

### 6.3 TB-S-02 (37) — Inject input into a live agent session

```
[GOAL] Cause the developer's agent to execute attacker-chosen instructions
  │
  ├── (AND) A. Reach the input path
  │     ├── A1. Obtain a credential
  │     │     ├── (OR) A1a. Capture ?key= at the edge or in a proxy log
  │     │     │              (auth.middleware.ts:56-57)             skill: low  / cost: $  / detect: none
  │     │     ├──      A1b. Capture the Bearer header at TB-1       skill: low  / cost: $$ / detect: none
  │     │     ├──      A1c. Capture the redundant WS `auth` frame
  │     │     │              mobile sends and nothing reads
  │     │     │              (tb-mobile/services/ws-client.ts:179)  skill: low  / cost: $  / detect: none
  │     │     ├──      A1d. Read server.yaml at umask mode (TB-S-16) skill: low / cost: $  / detect: none
  │     │     └──      A1e. Pair via a photographed QR ──► 6.2
  │     └── A2. Know a session id
  │           └── free: handleWsOpen unicasts the whole session list
  │               to any socket (src/server-wiring.ts:597-598)      skill: none / cost: $ / detect: none
  │
  └── (OR) B. Turn input into code execution
        ├── B1. The session already runs bypassPermissions/dontAsk  skill: none / cost: $ / detect: low
        ├── B2. Set it via PUT /api/config/claude-flags, then start
        │       a fresh session (needs admin — see 6.2 B4)          skill: low  / cost: $ / detect: med
        ├── B3. Answer the permission gate card yourself: the
        │       `permission` prompt is broadcast to subscribers
        │       (src/server-wiring.ts:642-651) and answered over
        │       HTTP with session:control                            skill: low / cost: $ / detect: med
        └── B4. Social-engineer the owner into approving a gate
                whose prompt the attacker wrote                      skill: med / cost: $ / detect: high
```

**Where the design cuts the tree:** A1a–A1c are severed — the credential stops travelling in a URL (§3.5), the redundant frame is deleted (mobile §4.2), and the Bearer header travels sealed (D-9).
**A1d and A2 are not cut.** A2 in particular is free and stays free: the design does not scope `session_list` or `subscribe_session` to a principal (TB-S-05), so an attacker who obtains any credential immediately learns every session id.
Branch B is entirely untouched by this design, and B3 deserves separate attention: a subscriber sees permission prompts, and control of the answer is one capability away.

---

## 7. Prioritized mitigations

Types per `threat-mitigation-mapping`: **P**reventive / **D**etective / **C**orrective. Difficulty is engineering effort, not importance.

### P0 — do these or the design does not deliver what it claims

| # | Control | Type | Difficulty | Closes |
|---|---|---|---|---|
| M1 | Ship the record layer and the `IK` handshake as designed — AEAD over all WS payloads and REST bodies, counter nonces, AAD-bound headers | P | High | TB-S-02, TB-S-03 (content), TB-S-12 |
| M2 | Rate-limit `POST /api/e2ee/open` per IP **before** any asymmetric work, mirroring the ordering `/api/pair/exchange` already gets right (`src/server.ts:1763` before `:1791`), and cap concurrent contexts per device with LRU eviction | P | Low | TB-S-08, TB-S-09 |
| M3 | Add a capability check to `hold_session` in `handleWsMessage` (`src/server-wiring.ts:669-671`) — it must require `session:control`, not merely an open socket | P | Low | TB-S-04 |
| M4 | Stop returning the sealed shared API key on the E2EE pairing path at stage 2, and make that a gate on the stage rather than a follow-up | P | Medium | TB-S-01 (blast radius), TB-S-12 |
| M5 | Bound the unseal middleware before it allocates: reject unknown `ctxId` first, cap body size pre-decryption, never size a buffer from an attacker-supplied length. Answer every unseal failure identically — one status, one message, no timing tell | P | Medium | TB-S-17, TB-S-08, TB-S-25 |
| M5b | Decide and document `--local-no-auth`'s interaction with a pinned device: either the loopback bypass keeps precedence (and the flag's warning says encryption is off for local callers), or the `426` applies there too | P | Low | TB-S-23 |

### P1 — close the detection and attribution gaps the design leaves

| # | Control | Type | Difficulty | Closes |
|---|---|---|---|---|
| M6 | Log the acting principal (`deviceId`) on every session-control action, not just at pairing. `AppEnv.requestId` is declared and never set (`src/api/app.ts:33`; `CLAUDE.md`, Query timing) — the same plumbing carries both | D | Medium | TB-S-14 |
| M7 | Log a **warn** on a `used`/`expired` pair-token consume, naming it as a possible replay, and surface a device-added notification. Today a replay is a 401 string with no log (`src/server.ts:1784-1787`) | D | Low | TB-S-01 (A3 detection) |
| M8 | Scope `session_list` and `subscribe_session` to the principal — at minimum by project — instead of serving every session to every socket | P | Medium | TB-S-05, and A2 in tree 6.3 |
| M9 | Make the fail-closed rule real in the runtime, or fix the docstring to match the middleware. One of the two comments is wrong and a reader will trust the wrong one | P | Low | TB-S-06 |
| M10 | Terminate live sockets and destroy contexts on revocation, as designed in §4.4 point 3 | C | Low | TB-S-18 |

### P2 — at rest, and the pre-existing file-permission gaps

| # | Control | Type | Difficulty | Closes |
|---|---|---|---|---|
| M11 | Page-level encryption of `cache.db` and `runtime.db` with a measured p50/p99 recorded against the documented baseline before it ships | P | High | TB-S-07 |
| M12 | Assert in a test that no backup archive ever contains `keys/` | P | Low | TB-S-07 residual |
| M13 | Pass `mode: 0o600` to the `writeFileSync` in `loadOrCreateApiKey` (`src/auth.ts:47`), matching what every other writer in that module already does | P | Trivial | TB-S-16 |
| M14 | Bound `.threadbase-uploads/` retention and add it to the generated `.gitignore` guidance | C | Low | TB-S-20 |
| M15 | Require a credential for `/api/logs` even from localhost, or document loopback as a trust boundary the product accepts | P | Low | TB-S-19 |

### P3 — measure before believing

| # | Control | Type | Difficulty | Closes |
|---|---|---|---|---|
| M16 | Benchmark per-socket sealing on the `broadcast` path at realistic socket × session counts before stage 2 | D | Medium | TB-S-10 |
| M17 | Instrument `e2ee.sequence_violation` with enough context to distinguish an attack from an intermediary artefact, and watch it in stage 1 before relying on strict ordering | D | Low | TB-S-11 |
| M18 | Record the at-rest query-timing delta explicitly; treat a `db.slow_query` that starts firing as a design failure, not a threshold to raise | D | Low | TB-S-21 |
| M19 | Fuzz `detectGateScreen` with agent-printed content designed to look like a gate — a hostile file the agent reads is a realistic delivery path, and the parser sits directly under asset A1 | D | Medium | TB-S-24 |

**Defense-in-depth check.** The design is strong on Preventive and thin on Detective — six of the eighteen controls above are detective, and five of those are gaps the design left rather than things it specified. That imbalance is the review's main structural finding: for the top threat that the design *cannot* prevent (TB-S-01, a photographed QR), detection is the entire remaining defense, and it currently consists of a 401 string.

---

## 8. Open questions

Unresolved by the docs or the source. None were resolved by assumption.

1. **Does the fail-closed test actually exist, and does it cover mounted sub-apps?** `capabilities.ts:78-82` promises deny-by-default; `auth.middleware.ts:96-104` implements fall-through and points at a test for the guarantee. Which is authoritative, and does that test enumerate routes from the Hono app or from a hand-maintained list? (TB-S-06, M9)

2. **Is `hold_session` without a capability check intentional?** It reaches `startGraceTimer` from a socket that only proved `history:read` (`src/server-wiring.ts:669-671`). If read-only devices are meant to be able to stop sessions, that should be written down; if not, it is a live elevation. (TB-S-04)

3. **Should `subscribe_session` be scoped?** The 2026-05-02 WS-push design is silent on it and the implementation has no check. Was that considered under the single-credential model, or is it an omission the capability work was expected to close? (TB-S-05)

4. **Why is the device token minted, stored, and never used?** `tb-mobile/stores/servers.ts:163-165` writes it; every request still sends the shared admin key (`tb-mobile/services/api-client.ts:200`). Does E2EE depend on client adoption landing first, or does the handshake supersede it entirely?

5. **What is the intended `--no-e2ee` story for a supervised prod instance?** The design deliberately gives it no `server.yaml` key and no env var (dilemma D-8), but `CLAUDE.md` documents env vars as *the* escape hatch for launchd/Task Scheduler instances whose argv is fixed. These two positions conflict and the team should pick.

6. **Is a native crypto module acceptable on mobile?** Everything about the record layer's throughput on the terminal stream rests on that answer (dilemma D-3), and it is a product decision about `pod install` churn, not a security one.

7. **Does `qrcode-terminal` at `{ small: true }` still render legibly with `spk` added?** If not, `spk` becomes a truncated fingerprint and the handshake needs a key-lookup step — a materially different design. Untested. (design §2.3)

8. **Retention and location of uploads.** `.threadbase-uploads/` sits inside a git working tree with no cleanup and no gitignore guidance (`src/uploads.ts:60`). Product question, surfaced here because dilemma D-4 could not resolve it.

9. **Does `--local-no-auth` outrank a pinned device?** The loopback bypass returns before the capability check (`src/api/middleware/auth.middleware.ts:47-52`) and the design never mentions the flag. Either answer is defensible; leaving it unspecified means whoever implements it picks silently. (TB-S-23, M5b)

10. **Is `detectGateScreen` confusable by agent-printed content?** The bottom-up last-option-block scan exists because prose above a gate can contain a matching numbered list, which says the failure mode is known — but "known and narrowed" is not "tested against hostile input", and the parser decides which options a phone is offered for a session that may run with `bypassPermissions`. (TB-S-24, M19)

11. **Doc drift, harmless but worth a fix:** `docs/architecture/2026-07-24-device-identity-and-capabilities.md:15`, `:21` cite `src/server.ts:1524-1559` and `:1561` for the pairing handlers; after the server split they are at `:1755-1837` and `:1839`. Behaviour matches; only the line numbers are stale.
