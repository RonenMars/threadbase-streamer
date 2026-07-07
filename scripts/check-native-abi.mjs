// Guards against a stale `better-sqlite3` native binary — one compiled for a
// different Node ABI / OS / arch than the one running now (moved repo, upgraded
// Node). Such a binary fails at require-time with a cryptic NODE_MODULE_VERSION
// error deep in the server; this surfaces it up front with the fix command.
//
// Wired into `preinstall` (catch a no-op install that leaves a stale binary)
// and `pretest` (fail fast instead of paying an unconditional rebuild).
//
// ponytail: only better-sqlite3 is checked. node-pty ships N-API prebuilds
// (node-addon-api, .node files selected by platform-arch, ABI-stable across
// Node versions) so it can't hit a NODE_MODULE_VERSION mismatch.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "better-sqlite3";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(root, "node_modules", PKG, "build", "Release", "better_sqlite3.node");

// Fresh install (no node_modules yet, or package not installed): nothing to
// compare against — a real install/rebuild will produce a matching binary.
if (!existsSync(binary)) process.exit(0);

// The authoritative test is whether *this* Node can dlopen the binary. A child
// process isolates the (possibly fatal) load. dlopen failing on a binary that
// exists means an ABI/OS/arch mismatch (NODE_MODULE_VERSION, wrong mach-o/ELF)
// — exactly what this guard is for. exit 3 = dlopen threw; anything else (spawn
// failure, unrelated crash) shouldn't block install/test.
const probe = `try { process.dlopen({ exports: {} }, ${JSON.stringify(binary)}); }
catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(3); }`;
const res = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });

if (res.status !== 3) process.exit(0);

const err = (res.stderr || "").trim();
console.error(`
✖ ${PKG} native binary is incompatible with this Node.

  Expected: Node ABI ${process.versions.modules}  ${process.platform}/${process.arch}  (node ${process.version})
  Binary:   ${binary}
  Loader error: ${err.replace(/\s+/g, " ").slice(0, 300)}

The compiled binary was built for a different Node version, OS, or CPU arch.
Fix it with one of:

  npm rebuild ${PKG}
  rm -rf node_modules && npm install
`);
process.exit(1);
