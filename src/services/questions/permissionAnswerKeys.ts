// Build the keystrokes that answer a permission gate by its ON-SCREEN number.
//
// Permission gates show options like "2. Yes / 3. No" — the visible number is
// NOT a stable 1-based index, so we send the actual number + Enter, never a
// down-arrow count (that's the AskUserQuestion path, answersToKeystrokes).
// Sent via the existing `/api/sessions/:id/input` { keys } route → sendKeys
// (raw bytes), NOT bracketed-paste `/input` text (no blanket \n).
//
// Mobile already does this directly (`POST /input { keys: \`${index}\r\` }`),
// so this helper exists for the server-side contract + tests.

const ENTER = "\r";

export function permissionAnswerKeys(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid permission option index: ${index}`);
  }
  return `${index}${ENTER}`;
}

// M5 — answerKeys keystroke-injection guard.
// Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L74
//
// The server tells mobile what keystroke bytes to forward to the PTY as an
// answer, and the client forwards them verbatim. A misbehaving/compromised
// detection path could smuggle arbitrary control bytes into `answerKeys`, so
// we constrain the field to a tight allowlist of the ONLY keystrokes a
// permission/shell-prompt answer legitimately needs before broadcasting:
//
//   - `\r`        bare Enter (a "press enter to continue" gate)
//   - `y\r`/`n\r` yes / no confirmations
//   - `\x03`      Ctrl-C (cancel)
//   - `<digits>\r` a numbered option (the on-screen number + Enter)
//
// biome-ignore lint/suspicious/noControlCharactersInRegex: the allowlist matches literal answer keystrokes (CR, Ctrl-C)
const ANSWER_KEYS_ALLOWLIST = /^(?:\r|[yn]\r|\x03|\d+\r)$/;

/**
 * Return `keys` unchanged if it is a recognised, safe answer keystroke; return
 * `undefined` for anything else so the caller drops the field and the client
 * falls back to answering by option index. Pure — no I/O.
 */
export function sanitizeAnswerKeys(keys: string | undefined): string | undefined {
  if (keys === undefined) return undefined;
  return ANSWER_KEYS_ALLOWLIST.test(keys) ? keys : undefined;
}
