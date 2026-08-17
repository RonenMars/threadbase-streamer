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

Snake_case (`pty_host`) is also unknown. Current ids: `codexSystemPrompt`, `sessionRehydration`, `liveActivityPush`, `e2ee`, `ptyHost`. `GET /api/config/feature-flags` `registry[].id` is the same list.

## Env vars

Each flag has a `THREADBASE_FEATURE_*` variable (`FEATURE_FLAGS.<id>.env`). Env is the highest real source, so it works on a supervised instance whose argv is fixed. Truthy: `1` / `true` / `yes` / `on`. Falsy: `0` / `false` / `no` / `off` / `""`. Unset means "defer to `--feature`, then yaml, then the registry default."

See [env.example](../env.example).

## Resolution

Once, at boot. Precedence, highest first: legacy `codexSystemPromptEnabled` override → env → `--feature` → `feature_flags:` → registry default.

- YAML: unknown ids and non-booleans are dropped; the process still boots.
- CLI: an unknown id or a non-boolean value stops the boot with a message listing the known keys.

`GET /api/config/feature-flags` returns `{ registry, values, sources }` (read-only; no PUT). `sources` names which rung won.

What each flag gates: `CLAUDE.md` § Feature flags.
