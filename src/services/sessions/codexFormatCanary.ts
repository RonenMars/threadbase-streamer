import { parseCodexJsonlLine } from "@threadbase-sh/scanner";

/**
 * Does a Codex rollout still look the way this streamer reads it?
 *
 * Everything built on Codex history — the conversation list, detail, search,
 * resume identity, and a fork's inherited prefix — parses an on-disk format
 * that Codex owns, does not version, and changes without telling anyone. It has
 * already changed once here: `forked_from_ordinal_exclusive` appears in exactly
 * one of the 38 fork rollouts on the machine this was written on, and its
 * absence is why every earlier fork opened as an empty conversation for months.
 *
 * That is the failure mode worth paying for. A format change does not throw —
 * it renders a conversation short, or empty, or a fork with turns it never
 * inherited, and every one of those looks like a bug in this app rather than a
 * moved contract.
 *
 * So this asserts the handful of things the readers actually depend on, and
 * NOTHING ELSE. A canary that fires on a benign addition gets muted, and a
 * muted canary is worse than none — Codex is free to add line types, payload
 * fields and roles, and every one of those must pass silently.
 */

/** What broke, in terms of the assumption it breaks. */
export type CodexFormatFindingCode =
  /** First line is not a `session_meta` — every reader starts there. */
  | "first_line_not_session_meta"
  /** `session_meta` carries no id, so the file names no conversation. */
  | "session_meta_missing_id"
  /**
   * Ordinals are not one-per-line ascending. `readMessagesBeforeOrdinal` treats
   * a line ordinal as a position, and falls back to the line counter when the
   * field is absent — both are wrong the moment ordinals skip or repeat, and a
   * fork's cut then lands in the wrong place with no error.
   */
  | "ordinals_not_sequential"
  /**
   * Lines that are structurally messages exist, but the render rule matched
   * none of them — a renamed role, type, or content shape. This is the silent
   * empty-conversation case.
   */
  | "no_messages_parsed"
  /**
   * A fork that names its source but not where the source stops. Its inherited
   * history cannot be reconstructed, so it opens showing only its own turns.
   */
  | "fork_link_without_cut"
  /** Most lines are not JSON at all — the container itself changed. */
  | "not_jsonl";

export interface CodexFormatFinding {
  code: CodexFormatFindingCode;
  detail: string;
}

/** Lines read before giving up: enough to see the shape, bounded for a 68 MB rollout. */
export const CANARY_LINE_BUDGET = 2000;

/** Above this share of unparseable lines, the container is the problem. */
const NOT_JSONL_RATIO = 0.5;

/** Message-shaped lines needed before "none rendered" means drift, not tag-stripping. */
const MIN_MESSAGES_FOR_RENDER_DRIFT = 5;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Audit the opening `lines` of one rollout.
 *
 * Pure and synchronous so the assumptions can be tested against drifted
 * fixtures rather than only against healthy ones — a canary nobody has seen
 * fire is a canary nobody knows is wired up.
 */
export function auditCodexRolloutLines(lines: string[]): CodexFormatFinding[] {
  const findings: CodexFormatFinding[] = [];
  const present = lines.filter((l) => l.trim().length > 0);
  if (present.length === 0) return findings;

  const parsed: Array<Record<string, unknown> | null> = present.map((l) => {
    try {
      return asRecord(JSON.parse(l));
    } catch {
      return null;
    }
  });

  const unparseable = parsed.filter((p) => p === null).length;
  if (unparseable / present.length > NOT_JSONL_RATIO) {
    return [
      {
        code: "not_jsonl",
        detail: `${unparseable} of ${present.length} opening lines are not JSON`,
      },
    ];
  }

  const first = parsed[0];
  if (first?.type !== "session_meta") {
    findings.push({
      code: "first_line_not_session_meta",
      detail: `first line has type ${JSON.stringify(first?.type ?? null)}`,
    });
  } else {
    const payload = asRecord(first.payload);
    const id = payload?.id ?? payload?.session_id;
    if (typeof id !== "string" || id.length === 0) {
      findings.push({
        code: "session_meta_missing_id",
        detail: "session_meta payload carries neither `id` nor `session_id`",
      });
    }
    // A fork that names its source should say where the source stops — but
    // only when Codex could have known. Measured on real rollouts: a fork
    // records `forked_from_ordinal_exclusive` exactly when its SOURCE has
    // ordinals, and inherits them (its own first line carries the cut as its
    // ordinal). Fork from a rollout written before ordinals existed and you
    // get an id and nothing else, today, with a current Codex.
    //
    // So a missing cut is only drift when this file HAS an ordinal: that
    // proves the source had them, which is exactly when a cut was available to
    // record. Without that qualifier this fires on every fork of an old
    // conversation — a permanent, known condition, and the fastest way to
    // train someone to ignore the canary.
    if (typeof payload?.forked_from_id === "string" && typeof first.ordinal === "number") {
      const cut = payload.forked_from_ordinal_exclusive;
      if (typeof cut !== "number" || !Number.isFinite(cut)) {
        findings.push({
          code: "fork_link_without_cut",
          detail: `forked_from_id present with ordinals, forked_from_ordinal_exclusive is ${JSON.stringify(cut ?? null)}`,
        });
      }
    }
  }

  // Ordinals must not go BACKWARDS. That is the whole assumption the readers
  // make: `readMessagesBeforeOrdinal` walks until `ordinal >= cut` and stops,
  // so a descending ordinal would end the prefix early and silently drop
  // inherited turns.
  //
  // Not asserted: that they start at zero — a fork continues its source's
  // numbering, its first line carrying the cut. Nor that they advance by
  // exactly one. Codex does emit repeats: one file in ~676 on the machine this
  // was written on carries ordinal 312 twice, and the readers are fine with it
  // because two lines sharing a position still fall on the same side of a cut.
  const ordinals = parsed.map((p) => (typeof p?.ordinal === "number" ? p.ordinal : null));
  let lastOrdinal: number | null = null;
  for (let i = 0; i < ordinals.length; i++) {
    const cur = ordinals[i];
    if (cur === null) continue;
    if (lastOrdinal !== null && cur < lastOrdinal) {
      findings.push({
        code: "ordinals_not_sequential",
        detail: `line ${i} has ordinal ${cur} after ${lastOrdinal}`,
      });
      break;
    }
    lastOrdinal = cur;
  }

  // The render rule, against the structural shape it reads. Only the
  // all-or-nothing case is a finding: a file legitimately renders fewer
  // messages than it has message-shaped lines (developer/system roles, bodies
  // that are only system tags), and reporting that would fire on every file.
  let messageShaped = 0;
  let rendered = 0;
  for (let i = 0; i < present.length; i++) {
    const entry = parsed[i];
    const payload = asRecord(entry?.payload);
    // Only roles the render rule would ever accept count as "should have
    // rendered". An aborted session whose sole message line is `developer`
    // sandbox boilerplate is legitimately empty, not drift — four such files
    // exist in this corpus, and counting them fires the canary on a working
    // conversation that simply has nothing to say.
    if (
      entry?.type === "response_item" &&
      payload?.type === "message" &&
      (payload.role === "user" || payload.role === "assistant")
    ) {
      messageShaped++;
    }
    if (parseCodexJsonlLine(present[i])) rendered++;
  }
  // A handful of message-shaped lines can legitimately render as nothing: a
  // body that is entirely `<command-name>` / `<local-command-stdout>` tags is
  // stripped to empty by design, and two such files exist here. Drift is a
  // file with real conversation in it rendering as none of it, so this needs a
  // floor. Five is a judgement call, sized above the observed noise.
  if (messageShaped >= MIN_MESSAGES_FOR_RENDER_DRIFT && rendered === 0) {
    findings.push({
      code: "no_messages_parsed",
      detail: `${messageShaped} message-shaped lines, none matched the render rule`,
    });
  }

  return findings;
}

/**
 * The newest rollouts under `roots`, newest first.
 *
 * Newest is the whole point: an old file proves only what Codex used to write,
 * and the drift worth catching is in what it writes now. Date-partitioned
 * directories (`<root>/YYYY/MM/DD`) mean the newest day's directory is enough —
 * walking every rollout would be a full-tree stat on a machine with thousands.
 */
export function findNewestRollouts(
  roots: string[],
  limit: number,
  fs: {
    readdirSync: (p: string) => string[];
    statSync: (p: string) => { mtimeMs: number; isDirectory(): boolean };
    existsSync: (p: string) => boolean;
  },
  join: (...parts: string[]) => string,
): string[] {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  const newestChildren = (dir: string, depth: number): void => {
    if (!fs.existsSync(dir)) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const dirs: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of entries) {
      const full = join(dir, name);
      let stat: { mtimeMs: number; isDirectory(): boolean };
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        dirs.push({ path: full, mtimeMs: stat.mtimeMs });
      } else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        candidates.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
    // Descend only into the newest directories, and only as deep as the
    // YYYY/MM/DD layout goes.
    if (depth <= 0) return;
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const d of dirs.slice(0, 2)) newestChildren(d.path, depth - 1);
  };

  for (const root of roots) newestChildren(root, 3);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit).map((c) => c.path);
}

export interface CanaryDeps {
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { mtimeMs: number; isDirectory(): boolean };
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf8") => string;
  join: (...parts: string[]) => string;
}

export interface CanaryReport {
  audited: number;
  findings: Array<{ filePath: string } & CodexFormatFinding>;
}

/** How many of the newest rollouts each sweep looks at. */
export const CANARY_SAMPLE_SIZE = 3;

/**
 * One sweep: audit the newest rollouts and report what no longer holds.
 *
 * Returns rather than logs so the caller owns the log vocabulary and a test can
 * assert on findings instead of on log lines.
 */
export function sweepCodexFormat(roots: string[], deps: CanaryDeps): CanaryReport {
  const files = findNewestRollouts(roots, CANARY_SAMPLE_SIZE, deps, deps.join);
  const findings: CanaryReport["findings"] = [];
  for (const filePath of files) {
    let head: string[];
    try {
      // Bounded: a rollout can reach tens of MB, and the opening lines carry
      // every structural assumption this checks.
      head = deps.readFileSync(filePath, "utf8").split("\n", CANARY_LINE_BUDGET);
    } catch {
      continue; // Unreadable is not drift — it may be mid-write.
    }
    for (const finding of auditCodexRolloutLines(head)) findings.push({ filePath, ...finding });
  }
  return { audited: files.length, findings };
}
