# Feature flags

Booleans that gate streamer behaviour that is not ready to be unconditional. They are **not** Claude CLI flags (`claude_flags:` / `--claude-flag`).

The registry is the `FEATURE_FLAGS` object in `src/feature-flags.ts`. Each key is the flag's stable id.

## Ids

`--feature` and `feature_flags:` in `~/.threadbase/server.yaml` use the **object keys**, camelCase:

```yaml
feature_flags: {"ptyHost":true,"sessionRehydration":false}
```

```bash
tb-streamer serve --feature ptyHost=true --feature liveActivityPush=true
```

Those keys are **not** the env var names. This does nothing (unknown key, dropped with a warning):

```yaml
feature_flags: {"THREADBASE_FEATURE_PTY_HOST":true}
```

Snake_case (`pty_host`) is also unknown. Current ids: `codexSystemPrompt`, `sessionRehydration`, `liveActivityPush`, `e2ee`, `accessProbe`, `ptyHost`. `GET /api/config/feature-flags` `registry[].id` is the same list.

## `accessProbe` — on by default, and why

Most flags default off. This one defaults **on** because it costs one HTTP request at boot and catches a failure that is otherwise silent and expensive.

A sealed request carries no `Authorization` header — that is what the envelope is for — so an interactive Cloudflare Access application in front of this server refuses it at the edge, before the tunnel. The device then reports that *pairing failed and the server did not finish the handshake*, blaming a server that never saw the request. Measured on hardware (2026-09-02): with Access on a tunnelled streamer, `POST /api/e2ee/open` never arrives and pairing fails closed; with Access bypassed, the same phone paired and ran sealed WebSocket and REST traffic through the same tunnel.

So at boot, when `e2ee` is on and a public URL is configured, the streamer asks its own public URL what an unauthenticated device would get. If a Cloudflare Access login answers, it warns — console and JSON log, `event: "access.gate_detected"` — naming the gate host and the two remedies. It never blocks the boot, never retries, and says nothing when the public URL is merely unreachable.

Turn it off with `--feature accessProbe=false`, `THREADBASE_FEATURE_ACCESS_PROBE=0`, or `feature_flags: {"accessProbe":false}`.

Optional: if `~/.threadbase/server.yaml` carries

```yaml
access_service_token: {"client_id":"…","client_secret":"…"}
```

the probe repeats the request with those Cloudflare service-token headers and reports whether they satisfy the gate. A malformed line costs that second half only; the gate is still detected.

## Env vars

Each flag has a `THREADBASE_FEATURE_*` variable (`FEATURE_FLAGS.<id>.env`). Env is the highest real source, so it works on a supervised instance whose argv is fixed. Truthy: `1` / `true` / `yes` / `on`. Falsy: `0` / `false` / `no` / `off` / `""`. Unset means "defer to `--feature`, then yaml, then the registry default."

See [env.example](../env.example).

## Resolution

Once, at boot. Precedence, highest first: legacy `codexSystemPromptEnabled` override → env → `--feature` → `feature_flags:` → registry default.

- YAML: unknown ids and non-booleans are dropped; the process still boots.
- CLI: an unknown id or a non-boolean value stops the boot with a message listing the known keys.

`GET /api/config/feature-flags` returns `{ registry, values, sources }` (read-only; no PUT). `sources` names which rung won.

What each flag gates: `CLAUDE.md` § Feature flags.
