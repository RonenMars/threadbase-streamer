import { type StreamerClient, StreamerHttpError } from "../cli/mcp/client";
import { flattenMessage, readConversationTools } from "../cli/mcp/read-conversation";

const tool = readConversationTools[0];

function fakeClient(get: (path: string) => unknown): StreamerClient {
  return { get: async (path: string) => get(path) } as unknown as StreamerClient;
}

describe("flattenMessage", () => {
  it("uses the plain text and the role", () => {
    expect(flattenMessage({ role: "assistant", text: "hi", content: [] })).toEqual({
      role: "assistant",
      text: "hi",
    });
  });

  it("falls back to the text blocks of content, dropping tool_use and tool_result", () => {
    const m = flattenMessage({
      role: "assistant",
      text: "",
      content: [
        { type: "text", text: "one" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
        { type: "text", text: "two" },
        { type: "tool_result", tool_use_id: "t1", content: "secret blob" },
      ],
    });
    expect(m).toEqual({ role: "assistant", text: "one\ntwo" });
  });

  it("returns null for a tool-result message even when it carries text", () => {
    expect(
      flattenMessage({ role: "user", text: "file contents", is_tool_result: true, content: [] }),
    ).toBeNull();
  });

  it("returns null for a message with no text (a bare tool result)", () => {
    expect(
      flattenMessage({
        role: "user",
        text: "",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
      }),
    ).toBeNull();
  });
});

describe("read_conversation handler", () => {
  const page = {
    messages: [
      { role: "user", text: "old", content: [] },
      { role: "user", text: "", content: [{ type: "tool_result", content: "x" }] },
      { role: "assistant", text: "new", content: [] },
    ],
    message_pagination: { next_before_index: 7 },
  };

  it("returns newest first and passes the cursor through verbatim", async () => {
    const res = await tool.handler(
      { id: "s1", limit: 3 },
      fakeClient(() => page),
    );
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      messages: [
        { role: "assistant", text: "new" },
        { role: "user", text: "old" },
      ],
      next_before_index: 7,
    });
  });

  it("asks for the page by msg_limit and before_index, encoding the id", async () => {
    let path = "";
    await tool.handler(
      { id: "a/b c", limit: 5, before_index: 9 },
      fakeClient((p) => {
        path = p;
        return page;
      }),
    );
    expect(path).toBe("/api/conversations/a%2Fb%20c?msg_limit=5&before_index=9");
  });

  it("maps a 404 to a one-line session-not-found error", async () => {
    const client = fakeClient(() => {
      throw new StreamerHttpError(404, "The streamer answered HTTP 404: Conversation not found.");
    });
    await expect(tool.handler({ id: "nope", limit: 5 }, client)).rejects.toThrow(
      /^Session not found: nope\.$/,
    );
  });
});
