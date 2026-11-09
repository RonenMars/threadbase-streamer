import { z } from "zod";
import { StreamerHttpError, type StreamerTool, textResult } from "./client";

interface Block {
  type?: string;
  text?: string;
}

interface ApiMessage {
  role: string;
  text?: string;
  is_tool_result?: boolean;
  content?: Block[];
}

interface ConversationResponse {
  messages: ApiMessage[];
  message_pagination: { next_before_index: number | null };
}

/** Role plus plain text; tool results and messages with no text are dropped. */
export function flattenMessage(m: ApiMessage): { role: string; text: string } | null {
  if (m.is_tool_result) return null;
  const text =
    m.text ||
    (m.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  return text ? { role: m.role, text } : null;
}

export const readConversationTools: StreamerTool[] = [
  {
    name: "read_conversation",
    description:
      "Read a session's messages as role plus plain text, newest first. " +
      "`limit` bounds the page; pass the returned `next_before_index` as `before_index` to fetch the next older page " +
      "(null means there is nothing older). Tool calls and results are not included. " +
      "Fails with a one-line error when the session is unknown.",
    inputSchema: {
      id: z.string().min(1).describe("The session id."),
      limit: z.number().int().min(1).max(100).default(20).describe("Messages per page."),
      before_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("The `next_before_index` from the previous page."),
    },
    handler: async ({ id, limit, before_index }, client) => {
      const qs = `msg_limit=${limit}${before_index === undefined ? "" : `&before_index=${before_index}`}`;
      let res: ConversationResponse;
      try {
        res = await client.get<ConversationResponse>(
          `/api/conversations/${encodeURIComponent(String(id))}?${qs}`,
        );
      } catch (err) {
        if (err instanceof StreamerHttpError && err.status === 404) {
          throw new Error(`Session not found: ${id}.`);
        }
        throw err;
      }
      const messages = res.messages
        .map(flattenMessage)
        .filter((m) => m !== null)
        .reverse();
      return textResult({
        messages,
        next_before_index: res.message_pagination.next_before_index,
      });
    },
  },
];
