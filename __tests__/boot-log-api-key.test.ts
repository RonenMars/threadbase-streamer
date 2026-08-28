import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #723: the boot line interpolated the whole API key into its message while
 * the structured field beside it masked deliberately, so every boot wrote a
 * credential equivalent to a shell on the machine into the JSON log people
 * attach to bug reports.
 *
 * Method: run the real emitter through the real logger out of process and read
 * what it actually writes to fd 1. Asserting on the template in the source
 * would prove nothing — the bug was visible there and still shipped.
 *
 * Every assertion is an exact substring, never a regex: the scrub that found
 * this bug had a loose pattern that matched the masked prefix and reported the
 * full key absent while it sat in the file.
 *
 * The masked prefix is the positive control. Without it, a harness that
 * captured nothing at all — wrong path, silent level, crashed child — would
 * sail through "the full key is absent" and report the leak as fixed.
 */

const REPO_ROOT = join(__dirname, "..");
const EMITTER = join(__dirname, "fixtures", "boot-log-emit.ts");

// Shaped like a released pairing key (tb_<32 hex>) so the masking runs on the
// real thing rather than on a placeholder it might slice differently.
const API_KEY = "tb_c99ed4f1a2b3c4d5e6f708192a3b4c5d";
const MASKED = "tb_c99…";

function bootLogStdout(): string {
  return execFileSync(process.execPath, ["--import", "tsx", EMITTER, API_KEY], {
    cwd: REPO_ROOT,
    env: { ...process.env, LOG_LEVEL: "info" },
    encoding: "utf8",
  });
}

describe("boot API key log line", () => {
  it("emits the masked key and never the full key", () => {
    const stdout = bootLogStdout();

    expect(stdout).toContain(MASKED);
    expect(stdout).not.toContain(API_KEY);
  });

  it("keeps the full key out of every field of the emitted record", () => {
    const lines = bootLogStdout().trim().split("\n").filter(Boolean);
    const record = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;

    expect(record.msg).toBe(`API key: ${MASKED}`);
    expect(record.apiKeyMasked).toBe(MASKED);
    expect(JSON.stringify(record)).not.toContain(API_KEY);
  });
});
