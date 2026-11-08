import type { ManagedSessionRow } from "../../db/repositories/managed-sessions.repository";
import { CODEX_CLI_PROVIDER, CURSOR_PROVIDER, canonicalizeProviderName } from "../../providers";

/**
 * Which id can actually resume a registry row (persistence plan Phase 3, gap G6).
 *
 * Claude's session id is always resumable as-is: it was passed to the CLI as
 * `--session-id`, so the JSONL is named after it and `--resume <id>` finds it.
 *
 * Codex has no such flag. A fresh Codex session is keyed by a local placeholder
 * UUID and its real rollout id arrives later, via `watchForCodexRollout`, as
 * `bound_conversation_id`. `codex resume <placeholder>` fails, so the bound id
 * is the only usable one — and a row that never bound has none at all, which is
 * what the `null` here means. Callers must treat `null` as "not resumable",
 * never as "resume by session_id".
 *
 * Cursor also assigns a separate transcript id to fresh sessions. A failed
 * binding write leaves it only on the live session (`liveBoundId`). Historical
 * Cursor sessions already use that id, so an absent binding keeps their id.
 */
export function resumeIdForRow(row: ManagedSessionRow, liveBoundId?: string | null): string | null {
  if (canonicalizeProviderName(row.provider) === CURSOR_PROVIDER) {
    return row.bound_conversation_id ?? liveBoundId ?? row.session_id;
  }
  if (row.provider !== CODEX_CLI_PROVIDER) return row.session_id;
  return row.bound_conversation_id;
}
