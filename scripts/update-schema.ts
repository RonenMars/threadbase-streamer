import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { StreamerServer } from "../src/server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "../../scanner/__fixtures__/contract-projects");
const CONTRACTS_DIR = join(__dirname, "../contracts");
const API_KEY = "tb_schema_update_key";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function inferSchema(value: unknown): object {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: {} };
    return { type: "array", items: inferSchema(value[0]) };
  }
  if (typeof value === "object") {
    const props: Record<string, object> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(value!)) {
      props[k] = inferSchema(v);
      if (v !== null && v !== undefined) required.push(k);
    }
    return { type: "object", required, properties: props };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return { type: "string", format: "date-time" };
    return { type: "string" };
  }
  return {};
}

async function captureResponses(baseUrl: string, headers: Record<string, string>) {
  const listRes = await fetch(`${baseUrl}/api/conversations?limit=3`, { headers });
  const listBody = await listRes.json();

  let detailBody = null;
  if (listBody.conversations?.length > 0) {
    const id = listBody.conversations[0].id;
    const detailRes = await fetch(`${baseUrl}/api/conversations/${id}`, { headers });
    detailBody = await detailRes.json();
  }

  const infoRes = await fetch(`${baseUrl}/api/info`, { headers });
  const infoBody = await infoRes.json();

  const sessionsRes = await fetch(`${baseUrl}/api/sessions`, { headers });
  const sessionsBody = await sessionsRes.json();

  return { listBody, detailBody, infoBody, sessionsBody };
}

function buildMobileSchema(responses: Awaited<ReturnType<typeof captureResponses>>) {
  const defs: Record<string, object> = {};

  if (responses.listBody.conversations?.length > 0) {
    defs.MobileConversation = inferSchema(responses.listBody.conversations[0]);
    defs.MobileConversationPage = {
      type: "object",
      required: ["conversations", "hasMore", "offset", "total"],
      properties: {
        conversations: { type: "array", items: { $ref: "#/$defs/MobileConversation" } },
        hasMore: { type: "boolean" },
        offset: { type: "integer", minimum: 0 },
        total: { type: "integer", minimum: 0 },
      },
    };
  }

  if (responses.detailBody) {
    defs.MobileDetailMeta = inferSchema(responses.detailBody.meta);
    if (responses.detailBody.messages?.length > 0) {
      defs.MobileMessage = inferSchema(responses.detailBody.messages[0]);
    }
    defs.MobileConversationDetail = {
      type: "object",
      required: ["meta", "messages"],
      properties: {
        meta: { $ref: "#/$defs/MobileDetailMeta" },
        messages: { type: "array", items: defs.MobileMessage ? { $ref: "#/$defs/MobileMessage" } : {} },
      },
    };
  }

  return { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: defs };
}

function buildDesktopSchema(responses: Awaited<ReturnType<typeof captureResponses>>) {
  const defs: Record<string, object> = {};

  if (responses.listBody.conversations?.length > 0) {
    defs.DesktopSearchResult = inferSchema(responses.listBody.conversations[0]);
    defs.DesktopSearchResultArray = { type: "array", items: { $ref: "#/$defs/DesktopSearchResult" } };
  }

  if (responses.detailBody) {
    defs.DesktopConversation = inferSchema(responses.detailBody);
  }

  return { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: defs };
}

function buildSharedSchema(responses: Awaited<ReturnType<typeof captureResponses>>) {
  const defs: Record<string, object> = {};

  if (responses.listBody.conversations?.length > 0) {
    const conv = responses.listBody.conversations[0];
    defs.ConversationListItem = {
      type: "object",
      required: ["id", "projectPath", "messageCount"],
      properties: {
        id: inferSchema(conv.id),
        projectPath: inferSchema(conv.projectPath),
        messageCount: inferSchema(conv.messageCount),
      },
    };
  }

  defs.ConversationListEnvelope = {
    type: "object",
    required: ["conversations", "hasMore", "offset", "total"],
    properties: {
      conversations: { type: "array", items: { $ref: "#/$defs/ConversationListItem" } },
      hasMore: { type: "boolean" },
      offset: { type: "integer", minimum: 0 },
      total: { type: "integer", minimum: 0 },
    },
  };

  defs.ServerInfo = inferSchema(responses.infoBody);

  return { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: defs };
}

async function main() {
  const args = process.argv.slice(2);
  const updateMobile = args.includes("--mobile") || args.length === 0;
  const updateDesktop = args.includes("--desktop") || args.length === 0;
  const updateShared = args.includes("--shared") || args.length === 0;

  const port = await getRandomPort();
  const server = new StreamerServer({
    port,
    apiKey: API_KEY,
    verbose: false,
    scanProfiles: [{ id: "test", label: "Test", configDir: FIXTURES_DIR, enabled: true, emoji: "🧪" }],
  });
  await server.listen(port);

  const baseUrl = `http://localhost:${port}`;
  const headers = { Authorization: `Bearer ${API_KEY}` };

  try {
    const responses = await captureResponses(baseUrl, headers);

    if (updateMobile) {
      const schema = buildMobileSchema(responses);
      const path = join(CONTRACTS_DIR, "mobile.schema.json");
      writeFileSync(path, JSON.stringify(schema, null, 2) + "\n");
      console.log("Updated mobile.schema.json");
    }

    if (updateDesktop) {
      const schema = buildDesktopSchema(responses);
      const path = join(CONTRACTS_DIR, "desktop.schema.json");
      writeFileSync(path, JSON.stringify(schema, null, 2) + "\n");
      console.log("Updated desktop.schema.json");
    }

    if (updateShared) {
      const schema = buildSharedSchema(responses);
      const path = join(CONTRACTS_DIR, "shared.schema.json");
      writeFileSync(path, JSON.stringify(schema, null, 2) + "\n");
      console.log("Updated shared.schema.json");
    }
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
