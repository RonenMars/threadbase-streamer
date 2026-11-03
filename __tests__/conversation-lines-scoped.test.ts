// #887 — conversation_events / conversation_event go only to the sockets that
// subscribed to that id, never to every connected client. conversation_updated
// is a list-refresh hint and stays a broadcast.

import { describe, expect, it, vi } from "vitest";
import { StreamerServer } from "../src/server";

const LINE = JSON.stringify({
  type: "user",
  uuid: "u1",
  timestamp: "2026-11-02T10:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});

function send(subs: Map<string, Set<object>>, id: string) {
  const broadcast = vi.fn();
  const broadcastToClients = vi.fn();
  (StreamerServer.prototype as any).broadcastConversationLines.call(
    { wsHub: { broadcast, broadcastToClients }, sessionSubscribers: subs },
    id,
    [LINE],
    null,
  );
  return { broadcast, broadcastToClients };
}

describe("broadcastConversationLines scoping (#887)", () => {
  it("sends both frame shapes to that id's subscribers and to nobody else", () => {
    const mine = {};
    const other = {};
    const subs = new Map<string, Set<object>>([
      ["conv-a", new Set([mine])],
      ["conv-b", new Set([other])],
    ]);
    const { broadcast, broadcastToClients } = send(subs, "conv-a");

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToClients).toHaveBeenCalledTimes(2);
    for (const [clients] of broadcastToClients.mock.calls) {
      expect([...clients]).toEqual([mine]);
    }
    expect(broadcastToClients.mock.calls.map(([, m]) => m.type)).toEqual([
      "conversation_events",
      "conversation_event",
    ]);
  });

  it("reaches no one when nobody subscribed to the id", () => {
    const subs = new Map<string, Set<object>>([["conv-b", new Set([{}])]]);
    const { broadcast, broadcastToClients } = send(subs, "conv-a");

    expect(broadcast).not.toHaveBeenCalled();
    for (const [clients] of broadcastToClients.mock.calls) {
      expect([...clients]).toEqual([]);
    }
  });
});
