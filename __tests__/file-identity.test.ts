import { describe, expect, it } from "vitest";
import { fileIdentity, splitCompleteLines } from "../src/utils/fileIdentity";

describe("fileIdentity", () => {
  it("uses the inode when available", () => {
    expect(fileIdentity({ dev: 66, ino: 12345 })).toBe("inode:66:12345");
  });

  it("falls back to a head-bytes fingerprint when ino is 0", () => {
    const a = fileIdentity({ dev: 0, ino: 0 }, Buffer.from("hello"));
    const b = fileIdentity({ dev: 0, ino: 0 }, Buffer.from("hello"));
    const c = fileIdentity({ dev: 0, ino: 0 }, Buffer.from("world"));
    expect(a).toBe(b); // deterministic
    expect(a).not.toBe(c); // content-sensitive
    expect(a.startsWith("fp:")).toBe(true);
  });

  it("distinguishes a replaced file (new inode) from a grown one (same inode)", () => {
    const grown = fileIdentity({ dev: 1, ino: 100 });
    const replaced = fileIdentity({ dev: 1, ino: 200 });
    expect(grown).not.toBe(replaced);
  });
});

describe("splitCompleteLines", () => {
  it("emits one span per complete line with absolute offsets", () => {
    const buf = Buffer.from("aa\nbbb\n");
    const { spans, consumed } = splitCompleteLines(buf, 0);
    expect(spans).toEqual([
      { byteOffset: 0, byteLength: 2, text: "aa" },
      { byteOffset: 3, byteLength: 3, text: "bbb" },
    ]);
    expect(consumed).toBe(7); // both newlines consumed
  });

  it("does NOT consume a trailing partial line (torn write)", () => {
    const buf = Buffer.from("aa\nbbb\npar");
    const { spans, consumed } = splitCompleteLines(buf, 0);
    // Only the two complete lines are emitted; "par" is left for the next read.
    expect(spans.map((s) => s.text)).toEqual(["aa", "bbb"]);
    expect(consumed).toBe(7); // stops before "par"
  });

  it("completes the torn line on the next read at the correct absolute offset", () => {
    // First read consumed 7 bytes (offset now 7). The next buffer starts there
    // and carries the rest of the torn line plus a new complete line.
    const buf = Buffer.from("tial\nccc\n");
    const { spans, consumed } = splitCompleteLines(buf, 7);
    expect(spans).toEqual([
      { byteOffset: 7, byteLength: 4, text: "tial" },
      { byteOffset: 12, byteLength: 3, text: "ccc" },
    ]);
    expect(consumed).toBe(9);
  });

  it("advances baseOffset correctly and skips empty lines", () => {
    const buf = Buffer.from("x\n\ny\n"); // blank line in the middle
    const { spans, consumed } = splitCompleteLines(buf, 100);
    expect(spans).toEqual([
      { byteOffset: 100, byteLength: 1, text: "x" },
      { byteOffset: 103, byteLength: 1, text: "y" },
    ]);
    expect(consumed).toBe(5); // all three newlines consumed, blank produced no span
  });

  it("consumes nothing when there is no newline yet", () => {
    const { spans, consumed } = splitCompleteLines(Buffer.from("partial"), 0);
    expect(spans).toEqual([]);
    expect(consumed).toBe(0);
  });
});
