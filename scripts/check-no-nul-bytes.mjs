// Guards against literal NUL (0x00) bytes landing in tracked source files.
//
// A NUL byte renders as an ordinary space in every editor, in `git diff`, and
// in GitHub's web view — completely invisible in review. Worse, several grep
// implementations (ugrep, and some system greps) suppress binary output: run
// against a file containing a NUL, they return an EMPTY, exit-1 result for
// EVERY pattern, with no error and no warning. That reads as "the answer is
// no" when it actually means "the tool declined to answer" — a confident
// false negative that already cost real investigation time once (see
// src/pty-manager.ts history, fixed by the commit that added this guard).
//
// Deliberately reads bytes directly rather than shelling out to grep for a
// NUL: a grep-based guard would go green on exactly the files it exists to
// catch, for the same reason above, which is worse than no guard at all.
//
// Skips known-binary extensions rather than sniffing file content to decide:
// a real binary asset (an image, a font, a compiled addon) is nothing but
// NUL bytes and would otherwise fail every PR that adds one, with a fix
// message ("replace the NUL byte with an escape") that makes no sense for a
// PNG — the fastest way out of that is deleting this guard, not fixing
// anything. Extension is a property of the filename, not the content, so it
// cannot let a NUL hiding in a real source file exempt itself the way a
// content-sniffing heuristic could.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BINARY_EXTENSIONS = new Set([
  // images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".icns",
  ".webp",
  // fonts
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  // archives
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".7z",
  // compiled / native
  ".node",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".wasm",
  // documents / media
  ".pdf",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
]);

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const hits = [];
for (const file of tracked) {
  if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;

  const full = join(root, file);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    // A path git tracks but that isn't present (or isn't readable) in this
    // working tree — e.g. a sparse checkout. Not a submodule case: a
    // submodule gitlink like vendor/menubar stats fine as a directory and is
    // caught by the isFile() check below instead. Skipped rather than
    // reported: a full `actions/checkout` (what CI runs) never hits this,
    // and other steps (build, tsc, tests) already fail loudly on a genuinely
    // missing file, so this guard doesn't need to duplicate that signal.
    continue;
  }
  // Submodules (vendor/menubar) are directories as far as `git ls-files` is
  // concerned; their contents belong to another repo and are out of scope.
  if (!stat.isFile()) continue;

  const data = readFileSync(full);
  const offset = data.indexOf(0);
  if (offset !== -1) hits.push({ file, offset });
}

if (hits.length === 0) process.exit(0);

// Spelled out via fromCharCode rather than written as a literal escape: the
// literal 4-hex-digit escape sequence for NUL is exactly what this guard
// exists to keep out of source files, so constructing it at runtime avoids
// planting one in the file that checks for them.
const escapeExample = `${String.fromCharCode(92)}u0000`;

console.error(`
✖ Found a literal NUL (0x00) byte in ${hits.length} tracked file(s):
${hits.map((h) => `  ${h.file} (first at byte offset ${h.offset})`).join("\n")}

Fix: replace each NUL byte with the escape ${escapeExample} (six characters:
backslash, u, 0, 0, 0, 0) — not a bare "\\0", which is ambiguous when the next
character is a digit.

To find it yourself, do not trust a plain \`grep\` on this machine: it may be
routed to an implementation that suppresses binary output. Use either:
  grep -a <pattern> <file>
  python3 -c "print(open('<file>', 'rb').read().find(b'\\x00'))"
`);

process.exit(1);
