import { Hono } from "hono";
import { resolveClaudeExe, resolveCodexExe } from "../../platform";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER } from "../../providers";
import { providerHealth } from "../../services/providers/providerHealth";
import type { AppEnv } from "../app";

/**
 * GET /api/providers — what each provider supports, and whether the installed
 * build is one we have verified against (C2).
 *
 * Clients need this to hide actions a provider cannot perform, rather than
 * offering them and failing. Before this, the only capability signal that
 * reached a client was a 501 from LiveSessionManager — i.e. it arrived as a
 * failed action instead of an absent button.
 *
 * Capabilities are per-provider, not per-session, so this is a separate
 * endpoint rather than more fields on SessionResponse.
 *
 * Deliberately exposes no filesystem paths: which binary resolved is an
 * implementation detail, and a resolved path can leak the user's home layout.
 */
export const createProviderRoutes = () => {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const providers = await Promise.all([
      providerHealth(CLAUDE_CODE_PROVIDER, resolveClaudeExe),
      providerHealth(CODEX_CLI_PROVIDER, resolveCodexExe),
    ]);

    return c.json({ providers });
  });

  return app;
};
