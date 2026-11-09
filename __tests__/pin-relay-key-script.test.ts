import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "scripts", "pin-relay-key.mjs");
const OLD = "4ba23-GN46vx3UARG7KvzT63Y-4JRXem3ExSROlw3jM";
const NEW = "A".repeat(43);

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-pin-relay-"));
  file = join(dir, "hosted.ts");
  writeFileSync(
    file,
    `const HOSTED_RELAY_URL = "wss://relay.threadbase.sh/tunnel";\nconst HOSTED_RELAY_PUBLIC_KEY = "${OLD}";\n`,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8" });
}

describe("scripts/pin-relay-key.mjs", () => {
  it("rewrites the pinned key and leaves the rest of the file alone", () => {
    const r = run(NEW);

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("changed");
    expect(readFileSync(file, "utf8")).toBe(
      `const HOSTED_RELAY_URL = "wss://relay.threadbase.sh/tunnel";\nconst HOSTED_RELAY_PUBLIC_KEY = "${NEW}";\n`,
    );
  });

  it("reports unchanged when the key is already pinned", () => {
    const r = run(OLD);

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("unchanged");
  });

  it.each([
    ["too short", "abc"],
    ["too long", "A".repeat(44)],
    ["not base64url", `${"A".repeat(42)}+`],
    ["a quote that would break out of the string", `${"A".repeat(41)}";x`],
  ])("refuses a key that is %s, without touching the file", (_name, bad) => {
    const before = readFileSync(file, "utf8");
    const r = run(bad);

    expect(r.status).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses when no key is given", () => {
    expect(run().status).toBe(1);
  });

  it("fails when the constant is gone, instead of silently doing nothing", () => {
    writeFileSync(file, "export const x = 1;\n");

    const r = run(NEW);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HOSTED_RELAY_PUBLIC_KEY not found");
  });
});
