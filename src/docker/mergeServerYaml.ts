// Upsert flat `key: value` lines into server.yaml without clobbering unrelated
// keys. The docker entrypoint used to rewrite the whole file on every boot,
// which wiped operator-added settings (claude_flags, feature_flags, …) that
// survived on the Fly volume. This merge keeps those lines and only touches
// the keys the container must own (api_key, public_url, browse_root).
//
// Same encoding rules as src/auth.ts setConfigValue: one line per key, atomic
// tmp+rename, mode 0600. Compiled by tsup to dist/merge-server-yaml.cjs.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Upsert each key in `values` into the flat server.yaml at `filePath`.
 * Existing unrelated keys are preserved. Missing file → created.
 */
export function mergeServerYaml(filePath: string, values: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });

  let content = "";
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let updated = content;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(key)) {
      throw new Error(`refusing to write invalid server.yaml key: ${key}`);
    }
    // Values must stay on one line — newlines would break the regex readers.
    if (/[\r\n]/.test(value)) {
      throw new Error(`refusing to write multi-line value for server.yaml key: ${key}`);
    }
    const lineRe = new RegExp(`^${key}:\\s*.*$\\n?`, "m");
    const line = `${key}: ${value}`;
    if (lineRe.test(updated)) {
      updated = updated.replace(lineRe, `${line}\n`);
    } else if (updated.length === 0 || updated.endsWith("\n")) {
      updated = `${updated}${line}\n`;
    } else {
      updated = `${updated}\n${line}\n`;
    }
  }

  const tmpFile = `${filePath}.tmp`;
  writeFileSync(tmpFile, updated, { encoding: "utf-8", mode: 0o600 });
  chmodSync(tmpFile, 0o600);
  renameSync(tmpFile, filePath);
}

function main(): void {
  const filePath = process.env.SERVER_YAML_PATH;
  if (!filePath) {
    console.error("[entrypoint] merge-server-yaml: SERVER_YAML_PATH is not set");
    process.exit(1);
  }

  const values: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      console.error(`[entrypoint] merge-server-yaml: expected key=value, got: ${arg}`);
      process.exit(1);
    }
    values[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  if (Object.keys(values).length === 0) {
    console.error("[entrypoint] merge-server-yaml: no key=value arguments provided");
    process.exit(1);
  }

  try {
    mergeServerYaml(filePath, values);
  } catch (err) {
    console.error(`[entrypoint] ${(err as Error).message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
