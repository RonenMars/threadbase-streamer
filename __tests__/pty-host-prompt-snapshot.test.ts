import { encodeMessage, PTY_HOST_PROTOCOL_VERSION } from "../src/pty-host/protocol";
import { RemoteSessionRunner } from "../src/pty-host/remote-session-runner";
import type { PTYManagerOptions } from "../src/types";

describe("pty-host prompt snapshot", () => {
  it("restores a prompt that opens between status and subscribe", async () => {
    const calls: unknown[][] = [];
    let onLine: (line: string) => void = () => {};
    const transport = {
      send(line: string) {
        const request = JSON.parse(line);
        const result =
          request.type === "status"
            ? { protocolVersion: PTY_HOST_PROTOCOL_VERSION, sessions: [], promptSnapshots: [] }
            : request.type === "subscribe"
              ? {
                  promptSnapshots: [
                    {
                      kind: "permission",
                      sessionId: "session-1",
                      occurrenceId: "host-occurrence-1",
                      gate: {
                        prompt: "Allow command?",
                        options: [{ index: 2, label: "Yes" }],
                      },
                    },
                  ],
                }
              : {};
        queueMicrotask(() => onLine(encodeMessage({ id: request.id, ok: true, result })));
      },
      onLine(handler: (line: string) => void) {
        onLine = handler;
      },
      onClose() {},
      close() {},
    };

    await RemoteSessionRunner.connect(transport, {
      onPermissionChange: (...args) => calls.push(args),
    } as PTYManagerOptions);

    expect(PTY_HOST_PROTOCOL_VERSION).toBe(4);
    expect(calls).toEqual([
      [
        "session-1",
        { prompt: "Allow command?", options: [{ index: 2, label: "Yes" }] },
        "host-occurrence-1",
      ],
    ]);
  });
});
