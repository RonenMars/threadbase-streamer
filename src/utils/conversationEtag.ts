import { createHash } from "node:crypto";

/**
 * Inputs that uniquely identify a conversation's current state for the
 * purpose of a conditional fetch. These all live on the parsed `Conversation`
 * and must be read AFTER `findConversationByUuid`'s staleness refresh — never
 * from a pre-refresh snapshot — so the validator reflects the same state the
 * response body would.
 */
export interface ConversationEtagInput {
  filePath: string;
  messageCount: number;
  timestamp: string;
}

/**
 * Derive a stable, opaque ETag for a conversation. The client never parses it;
 * it only echoes the value back via `If-None-Match`. Wrapping the inputs in a
 * hash keeps the formula changeable without the client caring.
 */
export function computeConversationEtag({
  filePath,
  messageCount,
  timestamp,
}: ConversationEtagInput): string {
  const digest = createHash("sha1")
    .update(`${filePath}:${messageCount}:${timestamp}`)
    .digest("hex")
    .slice(0, 16);
  return `"${digest}"`;
}
