import Ajv from "ajv";
import addFormats from "ajv-formats";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../../src/server";
import type { ServerConfig } from "../../src/types";

// ─── Fixture Profiles ─────────────────────────────────────────────
// Point scanner at the contract fixtures instead of ~/.claude.

export const FIXTURES_DIR = join(__dirname, "../fixtures");

export function createFixtureProfiles(fixtureDir: string) {
  return [
    {
      id: "test",
      label: "Test",
      configDir: fixtureDir,
      enabled: true,
      emoji: "🧪",
    },
  ];
}

// ─── Server Lifecycle ─────────────────────────────────────────────

export const TEST_API_KEY = "tb_contract_test_key";

export async function createTestServer(fixtureDir: string, overrides: Partial<ServerConfig> = {}) {
  const cacheDir = overrides.cacheDir ?? mkdtempSync(join(tmpdir(), "tb-test-cache-"));
  const server = new StreamerServer({
    apiKey: TEST_API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    scanProfiles: createFixtureProfiles(fixtureDir),
    // Isolate from any real ~/.claude or ~/.codex data on the host: the
    // scanner's default persistent index is a single shared SQLite file
    // unscoped by scanProfiles, and codexRoots defaults to ~/.codex/sessions.
    scannerPersistent: false,
    codexRoots: [],
    ...overrides,
    // Bind the real server to port 0 and read the OS-assigned port back off
    // it, rather than probing with a throwaway listener and closing it — a
    // closed probe leaves a window where another suite can grab the same
    // port before this server binds it for real. `overrides.port` is
    // deliberately not honored: no caller passes one, and honoring it would
    // reopen the TOCTOU window this removes.
    port: 0,
  });
  await server.listen(0, { awaitReady: true });
  const port = server.port;
  const baseUrl = `http://localhost:${port}`;
  const headers = { Authorization: `Bearer ${TEST_API_KEY}` };

  return { server, port, baseUrl, headers };
}

// ─── Schema Validation ────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const CONTRACTS_DIR = join(__dirname, "../../contracts");

export function loadSchema(name: string): object {
  const raw = readFileSync(join(CONTRACTS_DIR, `${name}.schema.json`), "utf-8");
  return JSON.parse(raw);
}

export function validateAgainstSchema(data: unknown, schemaName: string, definitionKey: string) {
  const schema = loadSchema(schemaName) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = schema;
  const validate = ajv.compile({
    ...rest,
    $ref: `#/$defs/${definitionKey}`,
  });
  const valid = validate(data);
  if (!valid) {
    const errors = validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join("\n  ");
    throw new Error(`Schema validation failed for ${schemaName}#${definitionKey}:\n  ${errors}`);
  }
}

// ─── Fetch Helpers ────────────────────────────────────────────────

export async function get(baseUrl: string, path: string, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

export async function post(
  baseUrl: string,
  path: string,
  data: unknown,
  headers: Record<string, string>,
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

// HTTP QUERY (RFC 10008) — safe/idempotent/cacheable like GET, JSON body like POST.
export async function query(
  baseUrl: string,
  path: string,
  data: unknown,
  headers: Record<string, string>,
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "QUERY",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}
