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

// The inverse: do these raw keystroke bytes answer THIS gate?
//
// Used to close a gate the moment its answer is written to the PTY, instead of
// waiting for the detector to notice the box is gone — after an approved tool
// starts running there is no end-of-turn OSC and no ╭/❯ prompt marker, so the
// detector's close condition can't fire until the whole turn ends.
//
// Deliberately strict, exact-match only. A false positive retires a LIVE gate
// on every connected client, which is worse than the lateness this fixes, so
// anything ambiguous stays for the detector to resolve: arrow keys (cursor
// moves, answers nothing), a bare Enter (accepts the highlight, but we don't
// track which option Claude has highlighted), a number this gate doesn't
// offer, and a gate whose options haven't painted yet (`options: []`) all
// return false.
export function isPermissionAnswer(
  gate: { options: { index: number; answerKeys?: string }[] },
  keys: string,
): boolean {
  return gate.options.some((o) => keys === (o.answerKeys ?? permissionAnswerKeys(o.index)));
}
