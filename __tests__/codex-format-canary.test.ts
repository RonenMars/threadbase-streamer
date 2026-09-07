/**
 * The Codex rollout format canary.
 *
 * Codex owns this format, does not version it, and changes it without notice —
 * `forked_from_ordinal_exclusive` appeared somewhere between 2026-08-30 and
 * 2026-09-06, and its absence is why every fork before that opened as an empty
 * conversation for months. Nothing threw; the app just looked broken.
 *
 * Half of these tests are the drift cases. The other half are the ones that
 * matter more: a canary that fires on healthy files gets muted, and a muted
 * canary is worse than none. Every "stays silent" case below was found by
 * running this against 676 real rollouts, and each one made the rules looser.
 */

import { describe, expect, it } from "vitest";
import {
  auditCodexRolloutLines,
  findNewestRollouts,
  sweepCodexFormat,
} from "../src/services/sessions/codexFormatCanary";

const line = (o: unknown) => JSON.stringify(o);

function meta(extra: Record<string, unknown> = {}, ordinal?: number) {
  return line({
    ...(ordinal != null && { ordinal }),
    type: "session_meta",
    payload: { id: "01a075cd-f290-7d63-9bd8-b37f70c2ef5f", cwd: "/tmp/p", ...extra },
  });
}

function msg(role: string, text: string, ordinal?: number) {
  return line({
    ...(ordinal != null && { ordinal }),
    timestamp: "2026-09-06T11:20:26.000Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
}

function healthy(): string[] {
  return [
    meta({}, 0),
    line({ ordinal: 1, type: "event_msg", payload: { type: "task_started" } }),
    msg("user", "first question", 2),
    msg("assistant", "first answer", 3),
  ];
}

const codes = (lines: string[]) => auditCodexRolloutLines(lines).map((f) => f.code);

describe("drift the canary must catch", () => {
  it("first line is no longer a session_meta", () => {
    expect(codes([msg("user", "hi", 0), meta({}, 1)])).toContain("first_line_not_session_meta");
  });

  it("session_meta names no conversation", () => {
    const [, ...rest] = healthy();
    const anonymous = line({ ordinal: 0, type: "session_meta", payload: { cwd: "/tmp/p" } });
    expect(codes([anonymous, ...rest])).toContain("session_meta_missing_id");
  });

  it("ordinals run backwards", () => {
    // The readers walk until `ordinal >= cut` and stop, so a descending ordinal
    // ends an inherited prefix early and drops turns with no error.
    const lines = [meta({}, 0), msg("user", "a", 5), msg("assistant", "b", 2)];
    expect(codes(lines)).toContain("ordinals_not_sequential");
  });

  it("real conversation renders as no messages at all", () => {
    // What a renamed role, type, or content shape looks like from here.
    const renamed = Array.from({ length: 6 }, (_, i) =>
      line({
        ordinal: i + 1,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "prompt_text", body: "hi" }] },
      }),
    );
    expect(codes([meta({}, 0), ...renamed])).toContain("no_messages_parsed");
  });

  it("a fork that inherited ordinals but records no cut", () => {
    // Its own ordinal proves the source had them, which is exactly when Codex
    // had a cut available to write down.
    const forked = meta({ forked_from_id: "01a06e20-75ff-7cb2-8cc2-14fb76121928" }, 297);
    expect(codes([forked])).toContain("fork_link_without_cut");
  });

  it("the file is not JSONL any more", () => {
    expect(codes(["not json", "also not json", meta({}, 0)])).toEqual(["not_jsonl"]);
  });
});

describe("healthy files the canary must stay silent on", () => {
  it("an ordinary rollout", () => {
    expect(codes(healthy())).toEqual([]);
  });

  it("line types, payload fields and roles it has never seen", () => {
    // Codex adds these freely. Reporting them is how a canary gets muted.
    const lines = [
      meta({ some_new_field: true }, 0),
      line({ ordinal: 1, type: "thread_settings_applied", payload: { type: "whatever" } }),
      line({ ordinal: 2, type: "response_item", payload: { type: "function_call", name: "x" } }),
      line({
        ordinal: 3,
        type: "response_item",
        payload: { type: "message", role: "tool", content: [{ type: "input_text", text: "x" }] },
      }),
      msg("user", "still fine", 4),
    ];
    expect(codes(lines)).toEqual([]);
  });

  it("a fork whose source predates ordinals, so there is no cut to record", () => {
    // Measured on real files: a fork carries a cut exactly when its SOURCE has
    // ordinals. Fork an old conversation today and you get an id and nothing
    // else — permanent and known, not drift.
    const forked = meta({ forked_from_id: "01a06e20-75ff-7cb2-8cc2-14fb76121928" });
    expect(codes([forked, msg("user", "carry on")])).toEqual([]);
  });

  it("a fork that continues its source's numbering", () => {
    const forked = meta(
      {
        forked_from_id: "01a075cd-f290-7d63-9bd8-b37f70c2ef5f",
        forked_from_ordinal_exclusive: 297,
      },
      297,
    );
    expect(codes([forked, msg("user", "continue with the merge", 298)])).toEqual([]);
  });

  it("an aborted session whose only message line is developer boilerplate", () => {
    // Four such files in the corpus. Legitimately empty, not drift.
    const lines = [
      meta({}, 0),
      line({ ordinal: 1, type: "event_msg", payload: { type: "task_started" } }),
      msg("developer", "sandbox policy dump", 2),
      line({ ordinal: 3, type: "event_msg", payload: { type: "turn_aborted" } }),
    ];
    expect(codes(lines)).toEqual([]);
  });

  it("a couple of messages that are entirely system tags", () => {
    // `<command-name>/model</command-name>` strips to empty by design. Two such
    // files exist; the render-drift check has a floor so they pass.
    const lines = [
      meta({}, 0),
      msg("user", "<command-name>/model</command-name>", 1),
      msg("user", "<local-command-stdout>Set model</local-command-stdout>", 2),
    ];
    expect(codes(lines)).toEqual([]);
  });

  it("a repeated ordinal, which Codex really does emit", () => {
    // One file in ~676 carries ordinal 312 twice. The readers are fine with it:
    // two lines sharing a position still fall on the same side of a cut.
    const lines = [meta({}, 0), msg("user", "a", 312), msg("assistant", "b", 312)];
    expect(codes(lines)).toEqual([]);
  });

  it("a file with no ordinals at all — the pre-ordinal format", () => {
    expect(codes([meta(), msg("user", "a"), msg("assistant", "b")])).toEqual([]);
  });

  it("an empty file", () => {
    expect(codes([])).toEqual([]);
    expect(codes(["", "  "])).toEqual([]);
  });
});

describe("picking which files to audit", () => {
  const tree: Record<string, string[]> = {
    "/root": ["2026", "notes.txt"],
    "/root/2026": ["08", "09"],
    "/root/2026/08": ["rollout-old-a.jsonl"],
    "/root/2026/09": ["rollout-new-a.jsonl", "rollout-new-b.jsonl", "unrelated.json"],
  };
  const mtimes: Record<string, number> = {
    "/root/2026": 20,
    "/root/2026/08": 10,
    "/root/2026/09": 30,
    "/root/2026/08/rollout-old-a.jsonl": 10,
    "/root/2026/09/rollout-new-a.jsonl": 30,
    "/root/2026/09/rollout-new-b.jsonl": 20,
  };
  const fs = {
    existsSync: (p: string) => p in tree || p in mtimes,
    readdirSync: (p: string) => tree[p] ?? [],
    statSync: (p: string) => ({
      mtimeMs: mtimes[p] ?? 0,
      isDirectory: () => p in tree,
    }),
    readFileSync: () => "",
    join: (...parts: string[]) => parts.join("/"),
  };

  it("returns the newest rollouts, newest first, ignoring non-rollout files", () => {
    expect(findNewestRollouts(["/root"], 3, fs, fs.join)).toEqual([
      "/root/2026/09/rollout-new-a.jsonl",
      "/root/2026/09/rollout-new-b.jsonl",
      "/root/2026/08/rollout-old-a.jsonl",
    ]);
  });

  it("a missing root is not an error", () => {
    expect(findNewestRollouts(["/nope"], 3, fs, fs.join)).toEqual([]);
  });

  it("a sweep attributes each finding to its file", () => {
    const drifted = [msg("user", "no session_meta first", 0)].join("\n");
    const report = sweepCodexFormat(["/root"], { ...fs, readFileSync: () => drifted });
    expect(report.audited).toBe(3);
    expect(report.findings.every((f) => f.code === "first_line_not_session_meta")).toBe(true);
    expect(report.findings[0].filePath).toBe("/root/2026/09/rollout-new-a.jsonl");
  });

  it("an unreadable file is skipped, not reported as drift", () => {
    // Mid-write, permissions, a race with Codex rotating a file.
    const report = sweepCodexFormat(["/root"], {
      ...fs,
      readFileSync: () => {
        throw new Error("EACCES");
      },
    });
    expect(report.findings).toEqual([]);
  });
});
