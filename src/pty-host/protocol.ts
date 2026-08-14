import type { ProviderName } from "../providers";
import type {
  AgentPhase,
  AskQuestion,
  ManagedSession,
  PermissionOption,
  StartFreshSessionOptions,
  StartSessionOptions,
  UserMessage,
} from "../types";

/**
 * Wire protocol between the streamer and `tb-streamer pty-host`
 * (persistence plan Phase 6a).
 * See docs/plans/live-sessions-persistence-plan.md §4 and
 * docs/architecture/2026-07-24-durable-session-runtime.md (alternative D).
 *
 * The point of the host is that the PTY master fd is held by a process that is
 * NOT being restarted. Everything the audit lists as lost with the streamer —
 * node-pty, the ring buffer, the xterm screen, inputHistory, pendingReady,
 * queuedInputs, and the prompt/gate detectors — lives on the host side of this
 * boundary; the streamer keeps only a mirror it can rebuild from `status`.
 *
 * Newline-delimited JSON rather than a binary framing: PTY output is already
 * being JSON-escaped for the WebSocket hub a layer above, the volumes are a
 * terminal's worth of bytes rather than a video stream, and a protocol you can
 * read with `nc` is worth more during an incident than the bytes it saves.
 *
 * Two message directions, never mixed:
 *
 *  - **Requests** (streamer → host) each carry an `id` and are answered by
 *    exactly one `Response` with the same `id`.
 *  - **Events** (host → streamer) are unsolicited and carry no `id`. They are
 *    the transport for what are callbacks in `PTYManagerOptions` today; the
 *    detectors that fire them run in the host, so every one of those callbacks
 *    needs an event here or the feature silently stops working when the flag
 *    is on. That is why this list is longer than the sketch in the plan.
 *
 * Deliberately absent: `resize`. The plan lists it, but PTY dimensions are the
 * fixed `PTY_COLS`/`PTY_ROWS` constants and `SessionRunner` has no resize
 * method, so the verb would be one nothing could ever send. Add it with the
 * caller that needs it.
 */

/**
 * Bumped on any incompatible change to the shapes below. Version 2 adds the
 * heartbeat and shutdown controls required for host supervision. Version 3
 * adds the `phase-change` event — the detector runs in the host, so without a
 * verb here the agent-phase indicator silently stops working when the flag is
 * on, which is exactly the failure this file's header warns about.
 */
export const PTY_HOST_PROTOCOL_VERSION = 3;

export interface HostHeartbeatState {
  registryState: "known" | "unknown";
  referencedSessionIds: string[];
}

/** `spawn` with a null sessionId means startFresh — the host assigns the id. */
export type SpawnRequest = {
  id: number;
  type: "spawn";
  provider: ProviderName;
} & (
  | { sessionId: string; options: StartSessionOptions }
  | { sessionId: null; options: StartFreshSessionOptions }
);

export type HostRequest =
  | SpawnRequest
  /** A submitted user message. Answered with the session's new promptCount. */
  | { id: number; type: "write"; sessionId: string; input: string }
  /** Raw keystrokes — never recorded as a user message. */
  | { id: number; type: "keys"; sessionId: string; keys: string }
  /** Begin receiving events. Sent once per connection after status passes the version check. */
  | { id: number; type: "subscribe" }
  /** The rendered screen, newest `maxLines` rows, in true on-screen order. */
  | { id: number; type: "replay"; sessionId: string; maxLines: number }
  | { id: number; type: "input-history"; sessionId: string }
  | { id: number; type: "cancel"; sessionId: string }
  /**
   * Stop a session. `hold` is `putOnHold` (SIGINT, history intact, resumable);
   * without it, and addressed by `pid`, it is `killPid`. One verb because the
   * host's answer is the same either way: that process is no longer running.
   */
  | { id: number; type: "kill"; sessionId: string; hold: true }
  | { id: number; type: "kill"; pid: number; hold?: false }
  | ({ id: number; type: "heartbeat" } & HostHeartbeatState)
  /** Stop this host after acknowledging the request. Used only on version skew. */
  | { id: number; type: "shutdown-host" }
  /** Every session the host owns. Seeds the streamer's mirror on connect. */
  | { id: number; type: "status" };

export type HostRequestType = HostRequest["type"];

/**
 * One response per request, correlated by `id`.
 *
 * A failure is a value, not a dropped message: a request that never gets a
 * response leaves the caller's promise pending forever, which is how a
 * transport bug turns into a hung session start rather than an error.
 */
export type HostResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/**
 * Unsolicited host → streamer messages. One per `PTYManagerOptions` callback,
 * plus `exit`, which is `onStatusChange` with the process actually gone.
 */
export type HostEvent =
  | { type: "event"; event: "output"; sessionId: string; data: string }
  | { type: "event"; event: "status-change"; session: ManagedSession }
  | { type: "event"; event: "ready"; session: ManagedSession }
  | {
      type: "event";
      event: "permission-change";
      sessionId: string;
      gate: {
        prompt?: string;
        detail?: string;
        options: PermissionOption[];
        cursor?: number;
      } | null;
    }
  /**
   * Agent phase changed within a running turn, including to `null` at turn
   * end. Carries the same always-present/nullable contract as the wire field:
   * absence must never mean "cleared", because the consumer merges state.
   */
  | { type: "event"; event: "phase-change"; sessionId: string; phase: AgentPhase | null }
  | { type: "event"; event: "live-question"; sessionId: string; questions: AskQuestion[] }
  | { type: "event"; event: "live-question-gone"; sessionId: string }
  | { type: "event"; event: "user-message"; sessionId: string; text: string; ts: number }
  | { type: "event"; event: "exit"; sessionId: string; exitCode: number };

export type HostMessage = HostResponse | HostEvent;

export function isHostEvent(message: HostMessage): message is HostEvent {
  return "type" in message && message.type === "event";
}

/**
 * A request minus the `id` the sender assigns.
 *
 * Distributive on purpose: a plain `Omit<HostRequest, "id">` collapses the
 * union into its common keys, which loses `sessionId`, `provider` and the rest
 * — so every call site fails to type-check against a request shape that is
 * actually correct.
 */
export type HostRequestBody = HostRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

/**
 * A session plus the one thing `ManagedSession` does not carry: the OS pid.
 *
 * The in-process runners read it off the node-pty handle, which lives on the
 * host now — and the durable registry needs it at spawn to record something a
 * later boot can probe. It is fixed for the life of a session, so `spawn` and
 * `status` are the only messages that carry it.
 */
export interface HostSession {
  session: ManagedSession;
  pid: number | null;
}

/** Result shapes, named so both ends agree on what a given request answers. */
export interface StatusResult {
  protocolVersion: number;
  sessions: HostSession[];
}
export interface InputHistoryResult {
  history: UserMessage[];
}
export interface ReplayResult {
  lines: string[];
  /** The raw ring buffer, so a reconnecting streamer can restore `getOutput`. */
  output: string;
}

/**
 * A duplex line channel. Deliberately not a socket: the runner is tested
 * against an in-memory pair, and PR 7 supplies the real one over a unix socket
 * (POSIX) or named pipe (Windows).
 */
export interface HostTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** `Date` survives JSON as a string; every session field that is one is listed here. */
const SESSION_DATE_FIELDS = [
  "startedAt",
  "completedAt",
  "statusUpdatedAt",
  "lastActivityAt",
  "firstMessageAt",
  "lastMessageAt",
] as const;

/**
 * Restore a `ManagedSession` that crossed the wire.
 *
 * JSON turns every `Date` into a string, and `ManagedSession.startedAt` is read
 * as a Date all over the server (`elapsedMs` arithmetic, `toISOString()`).
 * Without this the failure is a string where a Date is expected — which does
 * not throw, it produces `NaN` elapsed times and a crash only at the
 * `.toISOString()` call sites.
 */
export function reviveSession(raw: unknown): ManagedSession {
  const s = { ...(raw as Record<string, unknown>) };
  for (const field of SESSION_DATE_FIELDS) {
    const value = s[field];
    if (typeof value === "string") s[field] = new Date(value);
  }
  return s as unknown as ManagedSession;
}

export function encodeMessage(message: HostRequest | HostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Reassemble newline-delimited JSON from arbitrarily-chunked reads.
 *
 * A socket splits wherever it likes, so "one chunk is one message" holds right
 * up until a PTY burst makes it false. Stateful for exactly that reason: the
 * tail of a chunk is held until its newline arrives.
 */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // The final element is whatever followed the last newline — an empty string
    // when the chunk ended cleanly, a partial message otherwise. Either way it
    // is not a complete line yet.
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0);
  }
}
