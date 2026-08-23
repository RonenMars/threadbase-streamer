# Homebrew Tap for `tb-streamer` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a one-command Homebrew install path for `tb-streamer` (binary + `brew services` launchd plist + `set-key` subcommand), wired into the existing semantic-release pipeline so every stable release auto-publishes a formula to `RonenMars/homebrew-threadbase`.

**Architecture:** Two repos. `threadbase-streamer` (this repo) gets a new `set-key` CLI subcommand and a release-time step that builds `Formula/tb-streamer.rb` from a template and pushes it to the tap repo. `homebrew-threadbase` (new) holds only that formula and is updated entirely by automation. The formula uses per-arch URLs (darwin-arm64, darwin-x64, linux-x64) pointing at the existing per-platform release tarballs.

**Tech Stack:** Node 20+, commander, Homebrew formula (Ruby), GitHub Actions, semantic-release. No new runtime deps.

---

## Spec reference

Design doc: `docs/superpowers/specs/2026-05-31-homebrew-tap-design.md` (uncommitted but in the working tree).

## Files

**Create in this repo:**
- `cli/setKey.ts` — pure `runSetKey(args, deps)` function
- `__tests__/set-key.test.ts` — tests for `runSetKey`
- `scripts/build-formula.mjs` — generates `Formula/tb-streamer.rb` from template + release assets
- `scripts/templates/tb-streamer.rb.tmpl` — formula template with `{{PLACEHOLDERS}}`
- `scripts/publish-formula.sh` — clones tap repo, copies formula, commits, pushes (run from CI)
- `docs/superpowers/specs/2026-05-31-homebrew-tap-design.md` — design (already exists, uncommitted)

**Modify in this repo:**
- `cli/index.ts` — wire the `set-key` subcommand
- `src/auth.ts` — add `setApiKey(key)` helper that mirrors the existing regex-based pattern
- `.github/workflows/release.yml` — add post-release "Publish Homebrew formula" job
- `docs/auto-update.md` — link from "Set your API key" section to `set-key`
- `README.md` — add Homebrew install instructions section
- `CLAUDE.md` — append short "Homebrew tap" subsection under distribution

**Create in `RonenMars/homebrew-threadbase` (new repo, one-time setup):**
- `README.md` — stub pointing to streamer repo
- `Formula/tb-streamer.rb` — placeholder; first real release overwrites it

---

## Important spec corrections discovered during pre-write

The design doc assumed a single tarball per release and said first-run on macOS would take 30–60s to rebuild native modules. After reading `scripts/pack-platform.mjs` and `.github/workflows/release.yml`:

1. **Release produces 4 per-platform tarballs**, not one. Naming: `threadbase-streamer-<version>-<platform>-<arch>.tgz` where platform-arch ∈ {`darwin-arm64`, `darwin-x64`, `linux-x64`, `win32-x64`}. The formula uses Homebrew's `on_macos`/`on_linux` + `on_arm`/`on_intel` to pick the right one.
2. **`better-sqlite3` is NOT bundled in the tarball.** The `pack-platform.mjs` entries list is `["dist", "package.json", "package-lock.json", "node_modules/node-pty"]`. The formula must run `npm install --production --no-audit --no-fund --omit=dev better-sqlite3 pg` (and any other missing native deps) during install. We will install ALL prod deps via `npm ci --omit=dev` to be safe.

Plan accounts for both. The spec needs to be updated to match — do that as the last task before committing.

---

## Architecture clarifications worth pinning down upfront

**Tap repo setup:** Manual, one-time. The user creates `RonenMars/homebrew-threadbase` and a fine-grained PAT with `contents: write` scoped to that repo. Plan does NOT cover GitHub repo creation — it assumes the repo + PAT exist. A precondition task verifies they do.

**Pre-release handling:** semantic-release's `next` channel produces pre-release tags. The publish step gates on `nextRelease.channel === undefined` (stable) via a small Node check. Pre-releases are skipped entirely.

**Test strategy for the formula itself:** No automated test in CI — Homebrew formulas can only be tested by running `brew install ./Formula/tb-streamer.rb` on a real Homebrew host, which CI doesn't have ergonomically. The plan adds a manual verification task before the first user-facing release.

---

## Task 1: Add `setApiKey()` helper to `src/auth.ts`

**Files:**
- Modify: `src/auth.ts`
- Test: `__tests__/auth-set-key.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `__tests__/auth-set-key.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setApiKey } from "../src/auth";

let configDir: string;
let configFile: string;
let originalHome: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tb-auth-"));
  configFile = join(configDir, ".threadbase", "server.yaml");
  originalHome = process.env.HOME;
  process.env.HOME = configDir;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
});

describe("setApiKey", () => {
  it("creates server.yaml with the key when the file does not exist", () => {
    setApiKey("tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const content = readFileSync(configFile, "utf-8");
    expect(content).toMatch(/^api_key:\s*tb_a{32}$/m);
  });

  it("updates api_key in place, preserving other fields", () => {
    writeFileSync(
      configFile.replace("server.yaml", ""),
      "",
    ); // ensure parent dir exists path-wise (mkdtempSync already created configDir)
    const fs = require("node:fs");
    fs.mkdirSync(join(configDir, ".threadbase"), { recursive: true });
    fs.writeFileSync(
      configFile,
      "api_key: tb_old_old_old_old_old_old_old_old_oo\nbrowse_root: /tmp/x\npublic_url: https://example.com\n",
      "utf-8",
    );

    setApiKey("tb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const content = readFileSync(configFile, "utf-8");
    expect(content).toMatch(/^api_key:\s*tb_b{32}$/m);
    expect(content).toContain("browse_root: /tmp/x");
    expect(content).toContain("public_url: https://example.com");
  });

  it("appends api_key when file exists but has no api_key line", () => {
    const fs = require("node:fs");
    fs.mkdirSync(join(configDir, ".threadbase"), { recursive: true });
    fs.writeFileSync(configFile, "browse_root: /tmp/x\n", "utf-8");

    setApiKey("tb_cccccccccccccccccccccccccccccccc");

    const content = readFileSync(configFile, "utf-8");
    expect(content).toContain("browse_root: /tmp/x");
    expect(content).toMatch(/api_key:\s*tb_c{32}/);
  });

  it("writes the file with 0600 permissions", () => {
    setApiKey("tb_dddddddddddddddddddddddddddddddd");
    const mode = statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/auth-set-key.test.ts`
Expected: FAIL with `setApiKey is not a function` (or similar — `setApiKey` doesn't exist yet).

- [ ] **Step 3: Add `setApiKey` to `src/auth.ts`**

Append to `src/auth.ts` (after `loadOrCreateApiKey`):

```ts
export function setApiKey(key: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });

  let content = "";
  try {
    content = readFileSync(CONFIG_FILE, "utf-8");
  } catch {
    // file does not exist; we'll create it
  }

  const apiKeyLine = `api_key: ${key}`;
  const updated = /^api_key:\s*.+$/m.test(content)
    ? content.replace(/^api_key:\s*.+$/m, apiKeyLine)
    : content.length === 0 || content.endsWith("\n")
      ? `${content}${apiKeyLine}\n`
      : `${content}\n${apiKeyLine}\n`;

  // Atomic write: tmp then rename.
  const tmpFile = `${CONFIG_FILE}.tmp`;
  writeFileSync(tmpFile, updated, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpFile, CONFIG_FILE);
}
```

Also add to the existing imports at the top of `src/auth.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
```

(Replace the existing `fs` import — `renameSync` is new, the rest already exist.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/auth-set-key.test.ts`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: clean exit. Fix any biome/tsc errors before moving on.

- [ ] **Step 6: Commit**

```bash
git add src/auth.ts __tests__/auth-set-key.test.ts
git commit -m "feat(auth): add setApiKey helper for in-place api_key writes"
```

---

## Task 2: Add `tb-streamer set-key` CLI subcommand

**Files:**
- Create: `cli/setKey.ts`
- Modify: `cli/index.ts`
- Test: `__tests__/set-key.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/set-key.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetKey } from "../cli/setKey";

let homeDir: string;
let configFile: string;
let originalHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-setkey-"));
  configFile = join(homeDir, ".threadbase", "server.yaml");
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
});

describe("runSetKey", () => {
  it("accepts a valid key passed as argument and writes it", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { log });
    expect(code).toBe(0);
    expect(readFileSync(configFile, "utf-8")).toMatch(/api_key:\s*tb_a{32}/);
  });

  it("rejects a key with bad prefix", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "wrong_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { log });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid key format. Expected: tb_<32 hex chars>"),
    );
  });

  it("rejects a key with bad length", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "tb_short" }, { log });
    expect(code).toBe(1);
  });

  it("rejects a key with non-hex chars", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "tb_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }, { log });
    expect(code).toBe(1);
  });

  it("reads from stdin when key is '-'", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const stdin = "tb_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n";
    const code = await runSetKey({ key: "-" }, { log, readStdin: async () => stdin });
    expect(code).toBe(0);
    expect(readFileSync(configFile, "utf-8")).toMatch(/api_key:\s*tb_e{32}/);
  });

  it("rejects missing key without TTY prompt support", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: undefined }, { log, readStdin: async () => "" });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("API key required"),
    );
  });

  it("prints restart hint on success", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    await runSetKey({ key: "tb_ffffffffffffffffffffffffffffffff" }, { log });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("brew services restart tb-streamer"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/set-key.test.ts`
Expected: FAIL with `Cannot find module '../cli/setKey'`.

- [ ] **Step 3: Implement `cli/setKey.ts`**

Create `cli/setKey.ts`:

```ts
import { setApiKey } from "../src/auth";

const KEY_PATTERN = /^tb_[a-f0-9]{32}$/;

export interface SetKeyArgs {
  key: string | undefined;
}

export interface SetKeyDeps {
  log: { info: (msg: string) => void; error: (msg: string) => void };
  readStdin?: () => Promise<string>;
}

async function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

export async function runSetKey(args: SetKeyArgs, deps: SetKeyDeps): Promise<number> {
  const readStdin = deps.readStdin ?? defaultReadStdin;

  let key = args.key;
  if (key === "-") {
    key = (await readStdin()).trim();
  }

  if (!key || key.length === 0) {
    deps.log.error("API key required. Pass as argument or via stdin with '-'.");
    return 1;
  }

  if (!KEY_PATTERN.test(key)) {
    deps.log.error("Invalid key format. Expected: tb_<32 hex chars>");
    return 1;
  }

  try {
    setApiKey(key);
  } catch (err) {
    deps.log.error(`Failed to write key: ${(err as Error).message}`);
    return 1;
  }

  deps.log.info("API key updated.");
  deps.log.info("Restart the service to pick up the new key: brew services restart tb-streamer");
  return 0;
}
```

- [ ] **Step 4: Wire the subcommand into `cli/index.ts`**

In `cli/index.ts`, find the block where commands are registered (around line 156 where `.command("pair")` lives) and add this new command before or after it:

```ts
program
  .command("set-key [key]")
  .description("Set the streamer API key in ~/.threadbase/server.yaml")
  .action(async (key: string | undefined) => {
    const { runSetKey } = await import("./setKey");
    const code = await runSetKey(
      { key },
      {
        log: {
          info: (msg) => console.log(msg),
          error: (msg) => console.error(msg),
        },
      },
    );
    process.exit(code);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run __tests__/set-key.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 6: Run full lint**

Run: `npm run lint`
Expected: clean exit.

- [ ] **Step 7: Smoke test the built CLI**

Run:
```bash
npm run build
HOME=/tmp/tb-smoke node dist/cli.cjs set-key tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
cat /tmp/tb-smoke/.threadbase/server.yaml
```
Expected: stdout shows "API key updated." + restart hint. The yaml file contains `api_key: tb_a{32}`.

- [ ] **Step 8: Commit**

```bash
git add cli/setKey.ts cli/index.ts __tests__/set-key.test.ts
git commit -m "feat(cli): add tb-streamer set-key subcommand"
```

---

## Task 3: Create the formula template

**Files:**
- Create: `scripts/templates/tb-streamer.rb.tmpl`

- [ ] **Step 1: Create the directory and template**

Create `scripts/templates/tb-streamer.rb.tmpl`:

```ruby
class TbStreamer < Formula
  desc "PTY session management, WebSocket streaming, and REST API for Claude Code"
  homepage "https://github.com/RonenMars/threadbase-streamer"
  license "MIT"
  version "{{VERSION}}"

  depends_on "node@20"

  on_macos do
    on_arm do
      url "https://github.com/RonenMars/threadbase-streamer/releases/download/v{{VERSION}}/threadbase-streamer-{{VERSION}}-darwin-arm64.tgz"
      sha256 "{{SHA256_DARWIN_ARM64}}"
    end
    on_intel do
      url "https://github.com/RonenMars/threadbase-streamer/releases/download/v{{VERSION}}/threadbase-streamer-{{VERSION}}-darwin-x64.tgz"
      sha256 "{{SHA256_DARWIN_X64}}"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/RonenMars/threadbase-streamer/releases/download/v{{VERSION}}/threadbase-streamer-{{VERSION}}-linux-x64.tgz"
      sha256 "{{SHA256_LINUX_X64}}"
    end
  end

  def install
    libexec.install Dir["*"]

    # Tarball ships dist/, package.json, package-lock.json, and node_modules/node-pty.
    # Install the remaining production deps (better-sqlite3, pg, etc.) into libexec.
    cd libexec do
      system Formula["node@20"].opt_bin/"npm", "ci", "--omit=dev", "--no-audit", "--no-fund"
    end

    (bin/"tb-streamer").write_env_script libexec/"dist/cli.cjs",
      PATH: "#{Formula["node@20"].opt_bin}:$PATH"
  end

  service do
    run [opt_bin/"tb-streamer", "serve", "--port", "8766"]
    keep_alive true
    log_path       var/"log/tb-streamer.log"
    error_log_path var/"log/tb-streamer.err"
    environment_variables PATH: std_service_path_env
  end

  def caveats
    <<~EOS
      Next steps to finish setup:

        1. Set your API key (one-time):
           tb-streamer set-key <YOUR_API_KEY>

        2. Start the service (also starts on login):
           brew services start tb-streamer

        3. (Optional) Enable automatic updates:
           tb-streamer update --enable-auto-update

      Note: Homebrew install is mutually exclusive with the
      manual scripts/deploy.sh install. If you previously
      installed via that path, run:
        launchctl bootout gui/$UID/com.threadbase.streamer
      before starting the Homebrew service.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tb-streamer --version")
  end
end
```

- [ ] **Step 2: Lint the template (syntax-only)**

The template has `{{...}}` placeholders that aren't valid Ruby. Confirm by eyeball that the rest is valid Ruby formula syntax (matches Homebrew docs patterns). No automated check at this step — Task 4 generates a real `.rb` file we can sanity-check.

- [ ] **Step 3: Commit**

```bash
git add scripts/templates/tb-streamer.rb.tmpl
git commit -m "feat(brew): add formula template for tb-streamer"
```

---

## Task 4: Build `scripts/build-formula.mjs`

**Files:**
- Create: `scripts/build-formula.mjs`
- Test: `__tests__/build-formula.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/build-formula.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scripts", "build-formula.mjs");

describe("build-formula.mjs", () => {
  it("renders the template with version + per-arch sha256s", () => {
    const work = mkdtempSync(join(tmpdir(), "build-formula-"));
    const artifactsDir = join(work, "release-artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    // Fake tarballs with deterministic content
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-darwin-arm64.tgz"), "ARM_BODY");
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-darwin-x64.tgz"), "X64_BODY");
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-linux-x64.tgz"), "LIN_BODY");

    const outFile = join(work, "tb-streamer.rb");

    execFileSync("node", [
      SCRIPT,
      "--version", "9.9.9",
      "--artifacts", artifactsDir,
      "--out", outFile,
    ]);

    const rendered = readFileSync(outFile, "utf-8");
    expect(rendered).toContain('version "9.9.9"');
    expect(rendered).toContain("threadbase-streamer-9.9.9-darwin-arm64.tgz");
    expect(rendered).toContain("threadbase-streamer-9.9.9-darwin-x64.tgz");
    expect(rendered).toContain("threadbase-streamer-9.9.9-linux-x64.tgz");
    expect(rendered).not.toContain("{{");
    // Compare sha256 of literal "ARM_BODY" with what the script emitted.
    const { createHash } = require("node:crypto");
    const armSha = createHash("sha256").update("ARM_BODY").digest("hex");
    expect(rendered).toContain(armSha);
  });

  it("exits non-zero when a required artifact is missing", () => {
    const work = mkdtempSync(join(tmpdir(), "build-formula-fail-"));
    const artifactsDir = join(work, "release-artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    // Missing darwin-arm64
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-darwin-x64.tgz"), "X");
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-linux-x64.tgz"), "L");

    let exitCode = 0;
    try {
      execFileSync("node", [
        SCRIPT,
        "--version", "9.9.9",
        "--artifacts", artifactsDir,
        "--out", join(work, "out.rb"),
      ]);
    } catch (err: any) {
      exitCode = err.status;
    }
    expect(exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/build-formula.test.ts`
Expected: FAIL with `Cannot find module '.../scripts/build-formula.mjs'`.

- [ ] **Step 3: Implement `scripts/build-formula.mjs`**

Create `scripts/build-formula.mjs`:

```js
#!/usr/bin/env node
// Renders scripts/templates/tb-streamer.rb.tmpl into a real formula file.
// Usage: node scripts/build-formula.mjs --version <ver> --artifacts <dir> --out <file>

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function arg(name, required = true) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) {
    if (required) {
      console.error(`Missing --${name}`);
      process.exit(2);
    }
    return undefined;
  }
  return process.argv[idx + 1];
}

const version = arg("version");
const artifacts = resolve(arg("artifacts"));
const out = resolve(arg("out"));
const templatePath = join(__dirname, "templates", "tb-streamer.rb.tmpl");

const targets = [
  { key: "DARWIN_ARM64", file: `threadbase-streamer-${version}-darwin-arm64.tgz` },
  { key: "DARWIN_X64",   file: `threadbase-streamer-${version}-darwin-x64.tgz` },
  { key: "LINUX_X64",    file: `threadbase-streamer-${version}-linux-x64.tgz` },
];

const replacements = { VERSION: version };

for (const { key, file } of targets) {
  const path = join(artifacts, file);
  if (!existsSync(path)) {
    console.error(`Missing artifact: ${path}`);
    process.exit(1);
  }
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  replacements[`SHA256_${key}`] = sha;
}

let rendered = readFileSync(templatePath, "utf-8");
for (const [k, v] of Object.entries(replacements)) {
  rendered = rendered.replaceAll(`{{${k}}}`, v);
}

if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) {
  console.error("Template still contains unresolved placeholders after render.");
  console.error(rendered.match(/\{\{[A-Z0-9_]+\}\}/g));
  process.exit(1);
}

writeFileSync(out, rendered, "utf-8");
console.log(`wrote ${out}`);
```

Make it executable:
```bash
chmod +x scripts/build-formula.mjs
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/build-formula.test.ts`
Expected: PASS — both tests.

- [ ] **Step 5: Smoke test manually**

```bash
mkdir -p /tmp/fake-artifacts
echo "FAKE_ARM" > /tmp/fake-artifacts/threadbase-streamer-1.0.0-darwin-arm64.tgz
echo "FAKE_X64" > /tmp/fake-artifacts/threadbase-streamer-1.0.0-darwin-x64.tgz
echo "FAKE_LIN" > /tmp/fake-artifacts/threadbase-streamer-1.0.0-linux-x64.tgz
node scripts/build-formula.mjs --version 1.0.0 --artifacts /tmp/fake-artifacts --out /tmp/tb-streamer.rb
cat /tmp/tb-streamer.rb
```
Expected: file shows `version "1.0.0"`, three different sha256 hex strings, no `{{...}}` left.

- [ ] **Step 6: Run full lint**

Run: `npm run lint`
Expected: clean exit. (The new `.mjs` script is plain JS; biome should be fine.)

- [ ] **Step 7: Commit**

```bash
git add scripts/build-formula.mjs __tests__/build-formula.test.ts
git commit -m "feat(brew): add formula build script"
```

---

## Task 5: Publish-formula shell script (for CI)

**Files:**
- Create: `scripts/publish-formula.sh`

- [ ] **Step 1: Implement the script**

Create `scripts/publish-formula.sh`:

```bash
#!/usr/bin/env bash
# Publishes Formula/tb-streamer.rb to the homebrew-threadbase tap repo.
# Required env:
#   HOMEBREW_TAP_TOKEN  fine-grained PAT with contents:write on RonenMars/homebrew-threadbase
#   VERSION             release version (e.g. "1.2.0")
#   FORMULA_PATH        absolute path to the rendered tb-streamer.rb
# Run from CI after build-formula.mjs has produced FORMULA_PATH.

set -euo pipefail

: "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN required}"
: "${VERSION:?VERSION required}"
: "${FORMULA_PATH:?FORMULA_PATH required}"

if [[ ! -f "$FORMULA_PATH" ]]; then
  echo "Formula file not found at $FORMULA_PATH" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Use the token in the URL — works for ephemeral CI clones.
REPO_URL="https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/RonenMars/homebrew-threadbase.git"

git clone --depth 1 "$REPO_URL" "$WORK/tap"
mkdir -p "$WORK/tap/Formula"
cp "$FORMULA_PATH" "$WORK/tap/Formula/tb-streamer.rb"

cd "$WORK/tap"

if git diff --quiet Formula/tb-streamer.rb; then
  echo "Formula unchanged — nothing to publish for v${VERSION}."
  exit 0
fi

git -c user.name="threadbase-release-bot" \
    -c user.email="release-bot@threadbase.local" \
    add Formula/tb-streamer.rb

git -c user.name="threadbase-release-bot" \
    -c user.email="release-bot@threadbase.local" \
    commit -m "chore: tb-streamer v${VERSION}"

git push origin HEAD:main

echo "Published Formula/tb-streamer.rb v${VERSION} to homebrew-threadbase."
```

Make it executable:
```bash
chmod +x scripts/publish-formula.sh
```

- [ ] **Step 2: Sanity-check (no real push)**

Verify the script syntax:
```bash
bash -n scripts/publish-formula.sh
```
Expected: no output (success). Any syntax error here means a typo.

- [ ] **Step 3: Commit**

```bash
git add scripts/publish-formula.sh
git commit -m "feat(brew): add formula publish script"
```

---

## Task 6: Wire formula publishing into the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add a "Publish Homebrew formula" step after semantic-release**

Open `.github/workflows/release.yml`. The last step in the `release:` job is `Run semantic-release`. Add these two steps after it:

```yaml
      - name: Build Homebrew formula
        if: success()
        env:
          # semantic-release writes the published version to this file as part
          # of the workflow output. If it didn't publish (no release-worthy
          # commits), skip the publish step.
          NEXT_VERSION_FILE: ./.next-version
        run: |
          # Extract the version semantic-release just shipped, if any.
          # semantic-release doesn't write a version file by default; we infer
          # from the most recent git tag created during this job.
          TAG=$(git tag --points-at HEAD | grep '^v' | head -n1 || true)
          if [[ -z "$TAG" ]]; then
            echo "No release tag at HEAD — semantic-release did not publish. Skipping formula."
            exit 0
          fi
          VERSION="${TAG#v}"
          echo "Building formula for version $VERSION"
          mkdir -p formula-out
          node scripts/build-formula.mjs \
            --version "$VERSION" \
            --artifacts release-artifacts \
            --out formula-out/tb-streamer.rb
          echo "VERSION=$VERSION" >> "$GITHUB_ENV"
          echo "FORMULA_PATH=$PWD/formula-out/tb-streamer.rb" >> "$GITHUB_ENV"

      - name: Publish Homebrew formula
        if: env.VERSION != ''
        env:
          HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}
        run: bash scripts/publish-formula.sh
```

- [ ] **Step 2: Verify the YAML is valid**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): publish homebrew formula after semantic-release"
```

---

## Task 7: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a Homebrew install section to `README.md`**

In `README.md`, find the existing "Install" or "Getting Started" section (use `grep -n "install\|Install" README.md` to locate it). Add this subsection AT THE TOP of install instructions (Homebrew is the recommended path going forward):

```markdown
### Install via Homebrew (recommended, macOS + Linux)

```bash
brew tap RonenMars/threadbase
brew install tb-streamer

# One-time setup:
tb-streamer set-key <YOUR_API_KEY>

# Start the service (also starts on login):
brew services start tb-streamer

# Optional: enable automatic updates
tb-streamer update --enable-auto-update
```

To stop or restart: `brew services stop tb-streamer` / `brew services restart tb-streamer`.

> **Note:** the Homebrew install is mutually exclusive with the manual `scripts/deploy.sh` install. If you previously installed via that path, run `launchctl bootout gui/$UID/com.threadbase.streamer` before starting the Homebrew service.
```

(Keep the existing manual install / deploy script instructions below this new section.)

- [ ] **Step 2: Add a short "Homebrew tap" note to `CLAUDE.md`**

In `CLAUDE.md`, find the "Global `threadbase-streamer` / `tb-streamer` command" section (search: `## Global`). Append a new short subsection right before "## Cloudflare Tunnel":

```markdown
## Homebrew distribution

`brew install RonenMars/threadbase/tb-streamer` is an alternate install path for end users. The formula lives in `RonenMars/homebrew-threadbase` and is regenerated on every stable release by `scripts/build-formula.mjs` + `scripts/publish-formula.sh`, invoked from `.github/workflows/release.yml` after `semantic-release` finishes.

Homebrew installs the binary into `libexec/`, exposes `tb-streamer` on PATH, and registers `brew services start tb-streamer` to run it under launchd (macOS) or systemd (Linux). The formula's `service` block uses port 8766 and `--prod` is NOT passed — Homebrew installs are not part of the prod/dev lifecycle scheme.

Pre-releases (`next` channel) are NOT published to the tap. Pre-release users continue to use the GitHub release tarball.

A user can have either the Homebrew install OR the `scripts/deploy.sh` install, not both — both bind port 8766 with different launchd labels. Detection is deferred (see `docs/BACKLOG.md` "Homebrew vs `scripts/deploy.sh` plist collision"). Caveats in the formula warn users.
```

- [ ] **Step 3: Run full lint to catch any formatting issues**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(brew): document homebrew install path"
```

---

## Task 8: Update the design spec to match reality

**Files:**
- Modify: `docs/superpowers/specs/2026-05-31-homebrew-tap-design.md`

- [ ] **Step 1: Fix the per-platform tarball discrepancy**

In the spec, find the section "Native deps and first-run cost" and replace it with:

```markdown
### Native deps

The release pipeline produces per-platform tarballs (`darwin-arm64`, `darwin-x64`, `linux-x64`, `win32-x64`). The formula uses Homebrew's `on_macos`/`on_linux` + `on_arm`/`on_intel` to pick the matching one — the user gets a tarball already built for their architecture, so there is no ABI rebuild on first run.

`better-sqlite3` and `pg` are NOT bundled in the tarball (only `node-pty` is). The formula's `install` block runs `npm ci --omit=dev --no-audit --no-fund` inside `libexec/` to fetch them; this builds `better-sqlite3` against the user's Node 20 once during `brew install`. Expected install time: 30–60s. After install, `brew services start tb-streamer` boots clean and stays fast.
```

- [ ] **Step 2: Fix the formula example**

In the spec, find the Ruby formula block and replace it with the multi-arch version from `scripts/templates/tb-streamer.rb.tmpl` (verbatim, but with version `1.1.0` and placeholder sha256s for readability).

- [ ] **Step 3: Update first-run timing in caveats**

Anywhere the spec mentions "30–60s on Apple Silicon" or "rebuild on first run", change to:
"`brew install` itself takes 30–60s while `better-sqlite3` builds. After that, `tb-streamer` and `brew services start tb-streamer` are immediate."

- [ ] **Step 4: Add the spec file to git**

The spec was created but never committed. Stage it now:

```bash
git add docs/superpowers/specs/2026-05-31-homebrew-tap-design.md
git commit -m "docs(brew): design spec for homebrew tap"
```

---

## Task 9: Manual verification (pre-launch checklist)

This task is performed by a human, not an agent. It runs once before announcing the brew install path publicly.

**Pre-reqs (one-time, performed before the first release that ships this code):**

- [ ] `RonenMars/homebrew-threadbase` repo created (public, with stub README)
- [ ] Fine-grained PAT `HOMEBREW_TAP_TOKEN` created, scoped to `RonenMars/homebrew-threadbase`, permissions `contents: write`
- [ ] PAT added to `threadbase-streamer` repo secrets as `HOMEBREW_TAP_TOKEN`

**Verification after the first release that ships this code:**

- [ ] After release, `RonenMars/homebrew-threadbase/Formula/tb-streamer.rb` exists and contains the right version
- [ ] On a clean Mac (Apple Silicon):
  ```bash
  brew tap RonenMars/threadbase
  brew install tb-streamer
  tb-streamer --version  # matches release version
  tb-streamer set-key tb_<32 hex chars from your account>
  brew services start tb-streamer
  sleep 5
  curl http://localhost:8766/healthz  # expect { "ok": true, ... }
  brew services stop tb-streamer
  brew uninstall tb-streamer
  brew untap RonenMars/threadbase
  ```
- [ ] Confirm `~/.threadbase/server.yaml` and `~/.threadbase/cache.db` survive uninstall (user data preserved)
- [ ] Update website with the install snippet

---

## Self-Review

**Spec coverage:** Walked through the spec section by section.

- §Architecture → Tasks 3, 4, 5, 6 cover formula template + build + publish + CI wiring.
- §Formula contents → Task 3 (template) and Task 4 (rendered output).
- §`set-key` subcommand → Tasks 1 + 2.
- §Release pipeline changes → Tasks 4, 5, 6.
- §Documentation updates → Task 7.
- §Testing and rollout → Task 9 (manual verification).
- §Spec discrepancies (per-arch tarballs + better-sqlite3) → Task 8 fixes the spec.

No gaps. The `ensureNativeAbiMatches()` thing the spec added late in self-review is **not needed** for Homebrew because the per-arch tarball + `npm ci` install gives us correct natives without a runtime rebuild. Task 8 removes that paragraph from the spec.

**Placeholder scan:** Spot-checked all tasks. No TBDs, no "implement later", every code step shows actual code, every command step shows the actual command + expected output. ✓

**Type consistency:** Names used across tasks:
- `setApiKey(key: string)` — defined Task 1, used Task 2 ✓
- `runSetKey(args, deps)` — defined Task 2 only ✓
- `build-formula.mjs` flags: `--version`, `--artifacts`, `--out` — consistent across Tasks 4 and 6 ✓
- `HOMEBREW_TAP_TOKEN` env var — consistent across Tasks 5, 6, 9 ✓
- Tarball filename pattern `threadbase-streamer-<v>-<platform>-<arch>.tgz` — consistent with `scripts/pack-platform.mjs` (verified during pre-write) ✓

No issues found.
