import Ajv from "ajv";
import addFormats from "ajv-formats";
import { mkdtempSync, readFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../../src/server";

// ─── Fixture Profiles ─────────────────────────────────────────────
// Point scanner at the contract fixtures instead of ~/.claude.

export const FIXTURES_DIR = join(__dirname, "../../vendor/scanner/__fixtures__");

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

export async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function createTestServer(fixtureDir: string) {
  const port = await getRandomPort();
  const cacheDir = mkdtempSync(join(tmpdir(), "tb-test-cache-"));
  const server = new StreamerServer({
    port,
    apiKey: TEST_API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    scanProfiles: createFixtureProfiles(fixtureDir),
  });
  await server.listen(port, { awaitReady: true });
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
