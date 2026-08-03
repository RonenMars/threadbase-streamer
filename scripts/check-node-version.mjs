// Guards against running a build, test or deploy under a Node outside the
// range this repo supports.
//
// The authority is `engines.node` in package.json — the same declaration npm
// checks — because that is the range CI actually exercises. `.nvmrc` is the
// exact version to develop against and is quoted as the suggestion, but it is
// deliberately NOT the test: CI runs the matrix on several supported majors,
// and a guard keyed to the single pinned version would reject them.
//
// Why this exists when `engines` already exists: npm only enforces it when the
// consumer opts into `engine-strict`, and it never enforces it for a bare
// `node scripts/…` invocation. `scripts/deploy.sh` runs in a subshell that does
// not load nvm's lazy-init function, so its `node` is whatever the system
// provides — which is how a deploy ends up building native modules for an ABI
// the service cannot load, then "fixing" it with a rebuild that breaks the
// other side. See docs/troubleshooting.md, "Native modules / ABI mismatches".
//
// ponytail: major-only bounds parsed from `>=A <B`, no semver dependency. Every
// ABI break this guards against is a major change. If the range is ever written
// in a shape this cannot parse, the check disables itself rather than guessing
// — its absence is the status quo, a wrong verdict is not.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const warnOnly = process.argv.includes("--warn");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
};

const pkg = read("package.json");
const range = pkg ? (JSON.parse(pkg).engines?.node ?? "") : "";
const min = range.match(/>=\s*(\d+)/)?.[1];
const max = range.match(/<\s*(\d+)/)?.[1];
if (!min && !max) process.exit(0); // Unparseable or absent — nothing to enforce.

const major = Number(process.versions.node.split(".")[0]);
if ((!min || major >= Number(min)) && (!max || major < Number(max))) process.exit(0);

const suggested = read(".nvmrc")?.trim().replace(/^v/, "");
console.error(`
${warnOnly ? "⚠" : "✖"} Node ${process.version} is outside the range this repo supports (${range}).

  Running: ${process.execPath}
  Develop against: ${suggested ? `v${suggested} (.nvmrc)` : `Node ${min ?? "?"}.x`}

Native modules are compiled per Node ABI, so building or deploying here produces
binaries the supported Node cannot load — and the reverse. Switch before continuing:

  nvm use            # or: fnm use / asdf install
  nvm-windows: nvm use ${suggested?.split(".")[0] ?? min}   (no auto-cd hook — it must be explicit)
`);

process.exit(warnOnly ? 0 : 1);
