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
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --warn downgrades the failure to a notice. Used by `preinstall`, because
// `npm install` is one of the two remedies this check recommends — failing the
// install hard makes the guard block its own fix, and the only escape becomes
// `rm -rf node_modules` (the guard exits 0 when no binary exists at all).
const warnOnly = process.argv.includes("--warn");

const PKG = "better-sqlite3";
// --root exists for the test: it points the scan at a fabricated node_modules.
const rootArg = process.argv.indexOf("--root");
const root =
  rootArg > 0 ? process.argv[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");

// Every copy a dependency can carry of its own: the top-level one plus
// node_modules/<dep>/node_modules and node_modules/@scope/<dep>/node_modules.
// A nested copy can be a different major with its own ABI state, so a healthy
// top-level one proves nothing about it. ponytail: two levels deep only; add a
// real walk if a copy ever turns up nested further.
function copies() {
  const dirs = [join(modules, PKG)];
  if (!existsSync(modules)) return dirs;
  for (const name of readdirSync(modules)) {
    const parents = name.startsWith("@")
      ? readdirSync(join(modules, name)).map((n) => join(modules, name, n))
      : [join(modules, name)];
    for (const parent of parents) dirs.push(join(parent, "node_modules", PKG));
  }
  return dirs;
}

// Mirrors better-sqlite3's own lookup: v13 ships prebuilds/<platform>-<arch>.node
// and has no build/ directory; v11/v12 compile build/Release/better_sqlite3.node.
const musl =
  process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
const target = `${musl ? "linuxmusl" : process.platform}-${process.arch}`;
function binaryOf(dir) {
  return [join(dir, "prebuilds", `${target}.node`), join(dir, "build", "Release", "better_sqlite3.node")].find(
    existsSync,
  );
}

// The authoritative test is whether *this* Node can dlopen the binary. A child
// process isolates the (possibly fatal) load. dlopen failing on a binary that
// exists means an ABI/OS/arch mismatch (NODE_MODULE_VERSION, wrong mach-o/ELF)
// — exactly what this guard is for. exit 3 = dlopen threw; anything else (spawn
// failure, unrelated crash) shouldn't block install/test.
const probe = (binary) => `try { process.dlopen({ exports: {} }, ${JSON.stringify(binary)}); }
catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(3); }`;

// Fresh install (no node_modules yet, or package not installed): no binary to
// compare against — a real install/rebuild will produce a matching one.
const broken = [];
for (const dir of copies()) {
  const binary = binaryOf(dir);
  if (!binary) continue;
  const res = spawnSync(process.execPath, ["-e", probe(binary)], { encoding: "utf8" });
  if (res.status === 3) broken.push({ binary, err: (res.stderr || "").trim() });
}

if (broken.length === 0) process.exit(0);

const { binary, err } = broken[0];
const also = broken.slice(1).map((b) => `\n  Also:     ${b.binary}`).join("");
console.error(`
${warnOnly ? "⚠" : "✖"} ${PKG} native binary is incompatible with this Node.

  Expected: Node ABI ${process.versions.modules}  ${process.platform}/${process.arch}  (node ${process.version})
  Binary:   ${binary}${also}
  Loader error: ${err.replace(/\s+/g, " ").slice(0, 300)}

The compiled binary was built for a different Node version, OS, or CPU arch.
Fix it with one of:

  npm rebuild ${PKG}
  rm -rf node_modules && npm install
`);
process.exit(warnOnly ? 0 : 1);
