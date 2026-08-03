// Guards against running a build, test or deploy under a Node whose major
// differs from the one the repo pins in `.nvmrc`.
//
// Why this exists and `engines.node` doesn't cover it: `engines` is the
// CONSUMER contract shipped in the published package, so tightening it to the
// dev pin would warn (or, under engine-strict, fail) every end user installing
// the CLI on a newer Node. `.nvmrc` is the dev pin, and nothing enforces it —
// version managers only read it when asked, and nvm-windows has no auto-cd
// hook at all.
//
// The failure it prevents is not loud. Native modules are compiled per Node
// ABI, so a build under the wrong major produces a `better-sqlite3` binary the
// service cannot load — and `scripts/deploy.sh` runs in a subshell that does
// not load nvm's lazy-init, so its `node` is whatever the system provides
// rather than the pinned one. Each side's `npm rebuild` then fixes its own ABI
// and breaks the other's. See docs/troubleshooting.md, "Native modules / ABI
// mismatches".
//
// ponytail: major-only comparison. Exact-version matching is easy under nvm
// and genuinely awkward under nvm-windows (manual `nvm use`, sometimes
// elevation), and every ABI break this guards against is a major-version
// change. The full pinned version is still printed, so a patch-level drift is
// visible without being fatal.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const warnOnly = process.argv.includes("--warn");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let pinned;
try {
  pinned = readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
} catch {
  process.exit(0); // No pin declared — nothing to enforce.
}

const pinnedMajor = pinned.split(".")[0];
const runningMajor = process.versions.node.split(".")[0];
if (!pinnedMajor || pinnedMajor === runningMajor) process.exit(0);

const label = warnOnly ? "⚠ " : "✖ ";
console.error(`
${label}Node major mismatch: this repo pins v${pinned}, you are running ${process.version}.

  Running: ${process.execPath}
  Pinned:  .nvmrc → v${pinned}

Native modules are compiled per Node ABI, so building or deploying here produces
binaries the pinned Node cannot load — and the reverse. Switch before continuing:

  nvm use            # or: fnm use / asdf install
  nvm-windows: nvm use ${pinnedMajor}   (no auto-cd hook — it must be explicit)
`);

process.exit(warnOnly ? 0 : 1);
