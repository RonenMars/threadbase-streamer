// Rewrites HOSTED_RELAY_PUBLIC_KEY in src/relay/hosted.ts to the key given as
// argv[2]. Used by .github/workflows/update-relay.yml, whose key comes from a
// repository_dispatch payload and so is untrusted: it must be a 43-char
// base64url string (a raw X25519 public key) before it reaches the source file.
//
// Prints "changed" or "unchanged". --file exists for the test.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const fileArg = args.indexOf("--file");
const file =
  fileArg >= 0
    ? args[fileArg + 1]
    : join(dirname(fileURLToPath(import.meta.url)), "..", "src", "relay", "hosted.ts");
const key = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--file");

if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
  console.error("refusing a relay public key that is not 43 base64url characters");
  process.exit(1);
}

const src = readFileSync(file, "utf8");
const re = /(const HOSTED_RELAY_PUBLIC_KEY = ")[^"]*(";)/;
if (!re.test(src)) {
  console.error(`HOSTED_RELAY_PUBLIC_KEY not found in ${file}`);
  process.exit(1);
}
const next = src.replace(re, (_, pre, post) => `${pre}${key}${post}`);
if (next === src) {
  console.log("unchanged");
} else {
  writeFileSync(file, next);
  console.log("changed");
}
