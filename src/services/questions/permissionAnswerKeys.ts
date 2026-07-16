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
