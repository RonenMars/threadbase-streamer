import { describe, expect, it } from "vitest";
import {
  buildReport,
  CLOCK_SKEW_WARN_MS,
  clockSkewCheck,
  DIAGNOSTICS_CONTRACT_VERSION,
  type DiagnosticCheck,
  redactPath,
  redactValue,
  worstStatus,
} from "../src/services/diagnostics/diagnostics";

const check = (over: Partial<DiagnosticCheck> = {}): DiagnosticCheck => ({
  id: "x",
  status: "ok",
  summary: "fine",
  remediation: "NONE",
  ...over,
});

describe("worstStatus", () => {
  // A single failure must never be hidden by surrounding successes — the point
  // of an aggregate field is that a client can branch on it safely.
  it("reports the worst status present", () => {
    expect(worstStatus([check(), check({ status: "failed" }), check()])).toBe("failed");
    expect(worstStatus([check(), check({ status: "degraded" })])).toBe("degraded");
    expect(worstStatus([check(), check({ status: "unknown" })])).toBe("unknown");
  });

  it("ranks failed above degraded above unknown above ok", () => {
    expect(worstStatus([check({ status: "degraded" }), check({ status: "failed" })])).toBe(
      "failed",
    );
    expect(worstStatus([check({ status: "unknown" }), check({ status: "degraded" })])).toBe(
      "degraded",
    );
  });

  it("is ok when everything is ok, and for an empty set", () => {
    expect(worstStatus([check(), check()])).toBe("ok");
    expect(worstStatus([])).toBe("ok");
  });
});

describe("redactPath", () => {
  // A full path leaks the home directory layout, the username, and often client
  // or project names. The tail identifies the directory to someone who already
  // knows their own machine, which is all a diagnostic needs.
  it("keeps only the last two segments", () => {
    expect(redactPath("/Users/someone/dev/work/tb-streamer")).toBe("…/work/tb-streamer");
    expect(redactPath("C:\\Users\\someone\\projects\\app")).toBe("…/projects/app");
  });

  it("never emits a home directory or username", () => {
    const out = redactPath("/Users/ronenmars/.claude/projects/foo") ?? "";
    expect(out).not.toContain("ronenmars");
    expect(out).not.toContain("/Users");
  });

  it("passes through short paths and handles absent input", () => {
    expect(redactPath("/tmp")).toBe("tmp");
    expect(redactPath(null)).toBeNull();
    expect(redactPath("")).toBeNull();
  });
});

describe("redactValue", () => {
  // This endpoint is designed to be pasted into a bug report, so one careless
  // check must not be able to leak a credential.
  it.each([
    ["apiKey", { apiKey: "sk-secret" }],
    ["token", { token: "abc" }],
    ["authorization", { authorization: "Bearer x" }],
    ["password", { password: "hunter2" }],
    ["clientSecret", { clientSecret: "s" }],
  ])("redacts secret-shaped key %s", (_name, input) => {
    expect(JSON.stringify(redactValue(input))).not.toMatch(/sk-secret|abc|Bearer|hunter2|"s"/);
  });

  it("redacts nested and array-held secrets", () => {
    const out = redactValue({ a: { b: { deviceToken: "t" } }, list: [{ apiKey: "k" }] });
    expect(JSON.stringify(out)).not.toContain('"t"');
    expect(JSON.stringify(out)).not.toContain('"k"');
  });

  it("leaves non-secret values untouched", () => {
    expect(redactValue({ status: "ok", count: 3, live: true })).toEqual({
      status: "ok",
      count: 3,
      live: true,
    });
  });
});

describe("clockSkewCheck", () => {
  const now = 1_700_000_000_000;

  // Pair tokens expire after 180s, so a badly skewed clock makes every pairing
  // attempt fail with no indication that time is the cause.
  it("flags a large skew with a stable remediation code", () => {
    const result = clockSkewCheck(now + 10 * 60_000, now);
    expect(result.status).toBe("degraded");
    expect(result.remediation).toBe("CLOCK_SKEWED");
    expect(result.summary).toMatch(/180s|pairing/i);
  });

  it("accepts a skew inside tolerance", () => {
    expect(clockSkewCheck(now + CLOCK_SKEW_WARN_MS - 1, now).status).toBe("ok");
  });

  it("flags skew in either direction", () => {
    expect(clockSkewCheck(now - 10 * 60_000, now).status).toBe("degraded");
  });

  // Absence of a reference is not evidence of a healthy clock.
  it("reports unknown rather than ok when no reference exists", () => {
    const result = clockSkewCheck(now, null);
    expect(result.status).toBe("unknown");
    expect(result.remediation).toBe("NONE");
  });
});

describe("buildReport", () => {
  it("stamps the contract version so clients can branch on it", () => {
    expect(buildReport([check()]).contractVersion).toBe(DIAGNOSTICS_CONTRACT_VERSION);
  });

  it("summarizes to the worst check", () => {
    expect(buildReport([check(), check({ status: "failed" })]).overall).toBe("failed");
  });

  it("emits an ISO timestamp", () => {
    const at = new Date("2026-07-24T12:00:00.000Z");
    expect(buildReport([check()], at).generatedAt).toBe(at.toISOString());
  });

  // Independent checks: one failure must not prevent the others from being
  // reported, which is what makes the report useful for diagnosis.
  it("retains every check regardless of status", () => {
    const report = buildReport([
      check({ id: "a", status: "failed" }),
      check({ id: "b", status: "ok" }),
    ]);
    expect(report.checks.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
