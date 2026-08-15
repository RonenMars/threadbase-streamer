import type { LiveSessionWiringDeps, PendingQuestion } from "../src/server-wiring";
import { createLiveSessionOptions } from "../src/server-wiring";
import type { WSMessage } from "../src/types";

/**
 * onLiveQuestionGone fires whenever this streamer's own live PTY screen shows
 * an AskUserQuestion menu closing — see pty-manager.ts's detectLivePrompts.
 * pendingQuestions can hold either the screen-synthesized `screen:` id, or the
 * real `toolu_…` id a later JSONL flush swapped in for the SAME question
 * (handleLiveQuestion's doc comment). Either way the menu closing is
 * authoritative and must cancel whatever is pending — not just the
 * screen-scoped case (bbc1568 only cancelled the `screen:` case, on the
 * assumption the JSONL id meant handleSendAnswer had already cleared it,
 * which only holds when the menu closed BECAUSE we answered it).
 *
 * cancelPendingQuestion itself (server.ts) is a private StreamerServer
 * method, so it can't be imported directly — this mirrors its exact
 * no-op-if-absent guard rather than a bare spy, which is what lets the
 * "handleSendAnswer already cleared it" test prove no double broadcast,
 * not just that a mock function got called.
 */
function makeCancelPendingQuestion(
  pendingQuestions: Map<string, PendingQuestion>,
  pendingQuestionKey: Map<string, string>,
  broadcast: (msg: WSMessage) => void,
): (sessionId: string) => void {
  return (sessionId) => {
    const pq = pendingQuestions.get(sessionId);
    if (!pq) return;
    pendingQuestions.delete(sessionId);
    pendingQuestionKey.delete(sessionId);
    broadcast({ type: "question_cancelled", sessionId, toolUseId: pq.toolUseId });
  };
}

function buildDeps(pendingQuestion: PendingQuestion | undefined): {
  deps: LiveSessionWiringDeps;
  broadcast: ReturnType<typeof vi.fn>;
  pendingQuestions: Map<string, PendingQuestion>;
} {
  const broadcast = vi.fn();
  const pendingQuestionKey = new Map<string, string>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  if (pendingQuestion) {
    pendingQuestions.set("session-1", pendingQuestion);
    pendingQuestionKey.set("session-1", "some-key");
  }

  // Only the fields onLiveQuestionGone actually reads — LiveSessionWiringDeps
  // wires the whole server, and standing one up here would test the wiring
  // rather than the guard.
  const deps = {
    pendingQuestions,
    pendingQuestionKey,
    cancelPendingQuestion: makeCancelPendingQuestion(
      pendingQuestions,
      pendingQuestionKey,
      broadcast,
    ),
  } as unknown as LiveSessionWiringDeps;

  return { deps, broadcast, pendingQuestions };
}

const QUESTIONS = [{ question: "Which area?", header: "area", multiSelect: false, options: [] }];

describe("createLiveSessionOptions — onLiveQuestionGone cancel guard", () => {
  it("cancels a real toolu_… pending question and broadcasts question_cancelled", () => {
    const { deps, broadcast, pendingQuestions } = buildDeps({
      toolUseId: "toolu_abc123",
      questions: QUESTIONS,
      origin: "jsonl",
    });
    const options = createLiveSessionOptions(deps);

    options.onLiveQuestionGone?.("session-1");

    expect(broadcast).toHaveBeenCalledWith({
      type: "question_cancelled",
      sessionId: "session-1",
      toolUseId: "toolu_abc123",
    });
    expect(pendingQuestions.has("session-1")).toBe(false);
  });

  it("still cancels a screen-scoped pending question", () => {
    const { deps, broadcast } = buildDeps({
      toolUseId: "screen:session-1:12",
      questions: QUESTIONS,
      origin: "pty",
    });
    const options = createLiveSessionOptions(deps);

    options.onLiveQuestionGone?.("session-1");

    expect(broadcast).toHaveBeenCalledWith({
      type: "question_cancelled",
      sessionId: "session-1",
      toolUseId: "screen:session-1:12",
    });
  });

  it("does not double-cancel after handleSendAnswer already cleared it", () => {
    const { deps, broadcast, pendingQuestions } = buildDeps({
      toolUseId: "toolu_abc123",
      questions: QUESTIONS,
      origin: "jsonl",
    });
    // handleSendAnswer's success path deletes pendingQuestions directly
    // (sessions.handlers.ts) before this event ever arrives — the menu closes
    // as a RESULT of the answer, so onLiveQuestionGone fires after the fact.
    pendingQuestions.delete("session-1");
    const options = createLiveSessionOptions(deps);

    options.onLiveQuestionGone?.("session-1");

    expect(broadcast).not.toHaveBeenCalled();
  });
});
