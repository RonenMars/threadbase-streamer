# STOP-T7 — Codex `requestUserInput` is default-off / under development in 0.150.1

**Prober:** codex-gate-prober · **Written:** 2026-08-28 · **Binary:** `/opt/homebrew/bin/codex` → `/opt/homebrew/Caskroom/codex/0.150.1/bin/codex`, `codex-cli 0.150.1`, sha256 `a14f9a907c12c8812878b70e6b7d65f81c39ed795513e46a55817d7428c0ca6b`.

## Live capture (evidence `codex/X02-request-user-input-no-flag/`)

Default config in a redirected `CODEX_HOME` (model `gpt-5.6-luna`, `approval_policy=on-request`, `sandbox_mode=workspace-write`, **no `[features]` table, no `--enable`**), three `initialize` variants (`experimentalApi:true`, `experimentalApi:false`, no capabilities):

1. The model **has** the `request_user_input` tool and calls it — rollout `response_item.function_call name="request_user_input"` with `questions[{id,header,question,options[{label,description}]}]`.
2. The app-server **never emits `item/tool/requestUserInput`** to the client (`frames.*.jsonl`: server request kinds = `[]`).
3. The server answers the model itself: `function_call_output.output = "request_user_input is unavailable in Default mode"`; stderr `codex_core::tools::router: request_user_input is unavailable in Default mode`.
4. The turn completes with the agent's fallback text `NO-SUCH-TOOL-X02`.

`experimentalFeature/list` (documented method, `experimentalFeature-list.json`):
`{"name":"default_mode_request_user_input","stage":"underDevelopment","enabled":false,"defaultEnabled":false,"displayName":null,"description":null}` — same flag name as the 0.149.0 capture. `codex features list` agrees (`under development  false`).

## Documented alternative path? — none found
The refusal names "Default mode". The protocol schema has `ModeKind = "plan" | "default"` and `ThreadSettings.collaborationMode`, but `collaborationMode` appears **only** in `ThreadSettings` (reported via `thread/settings/updated`); neither `ThreadStartParams` nor `TurnStartParams` accepts a mode, and `features list` marks `collaboration_modes` as `removed`. So there is no documented client-side way to reach a non-default mode through the app-server in 0.150.1. Not tested by enabling anything.

## Not done (per protocol)
The flag was **not** enabled. `experimentalFeature/enablement/set` exists as a documented method; it was not called.

## Consequence for the scorecard
- Blocked (`unknown / blocked-by-T7`): X0.4 (requestUserInput with exact flag), X0.5 (multi-question request), X0.6 (`questionId`/`isSecret`/`isBlocking` on the wire), X03 requestUserInput category, X04 pending-`requestUserInput` variants (approval variants still run), X05 "server sends request kind client doesn't know" via requestUserInput (approval-based variant still run).
- Continuing: X0.1–X0.3 (done, pass), X01, X02 (this finding), X03 minus question category, X04 approval variants, X06, X07.

Owner decision needed: whether an internal-experiment adapter with the under-development flag is ever acceptable (codex-results D4 says: no production rollout while default-off).

## Owner decision (ai-investigation-claude-67, 2026-08-28 07:56 IDT)

Finding stands as the headline of X02 and of the Codex verdict: at 0.150.1 `requestUserInput` is under-development / default-off with no documented client path ⇒ per codex-results D4 **not production-eligible**. Grounded in D4's own wording ("internal-experiment capability, not a production contract"):

1. A second, clearly-labelled evidence pass **with** the flag is permitted — only because the flag is documented in `experimentalFeature/list` (T7, not T9), and only inside the redirected `CODEX_HOME` scratch config. Real `~/.codex/config.toml` never touched. META records exactly how the flag was enabled.
2. Rows produced under the flag (X0.4, X0.5, X0.6, requestUserInput sub-rows of X03/X04/X05) carry the suffix `flag-gated: default_mode_request_user_input (underDevelopment)`. Verdict may be pass for *mechanics*; never contributes to a production-readiness pass. GO-NO-GO must state Codex questions remain internal-experiment-only until default-on and negotiable without hidden configuration.
3. Order: all non-flag rows first (X01, X03 non-question, X04 approvals, X06, X07); flag-gated pass last, in separate evidence dirs (`X0.4-…-flagged/` etc.), so drift under the flag cannot contaminate default-config evidence.
4. This file stays on disk as the record.
