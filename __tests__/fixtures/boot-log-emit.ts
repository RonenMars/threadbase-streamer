/**
 * Emits the real boot API-key line through the real logger, so
 * boot-log-api-key.test.ts can read the bytes production writes to fd 1.
 *
 * Out of process on purpose: in the vitest process silence-logs.ts pins the
 * level to silent, and pino writes straight to the descriptor where no stdout
 * spy can see it. Here stdout is a pipe, so the logger's default dest is
 * "pino" and the line lands on fd 1 as the JSON a bug report would carry.
 */
import { logApiKeyLine } from "../../cli/boot-log";
import { getLogger } from "../../src/logger";

const apiKey = process.argv[2];
if (!apiKey) throw new Error("usage: boot-log-emit.ts <apiKey>");

logApiKeyLine(getLogger("cli"), apiKey);
