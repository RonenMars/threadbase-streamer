import { randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".threadbase");
const CONFIG_FILE = join(CONFIG_DIR, "server.yaml");

export function generateApiKey(): string {
  return `tb_${randomBytes(16).toString("hex")}`;
}

export function validateApiKey(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function loadOrCreateApiKey(): string {
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    const match = content.match(/api_key:\s*(.+)/);
    if (match?.[1]) return match[1].trim();
  } catch {
    // File doesn't exist, create one
  }

  const key = generateApiKey();
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `api_key: ${key}\n`, "utf-8");
  return key;
}
