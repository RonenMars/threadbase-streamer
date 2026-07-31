import { existsSync } from "fs";
import { Hono } from "hono";
import { resolveClaudeExe, resolveCodexExe } from "../../platform";
import {
  buildReport,
  type DiagnosticCheck,
  redactPath,
  redactValue,
} from "../../services/diagnostics/diagnostics";
import { rehydrateSkipReason } from "../../services/sessions/rehydrateSessions";
import { currentBootToken } from "../../utils/bootToken";
import { getVersion } from "../../version";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

/**
 * GET /api/diagnostics — a versioned, redacted health report (C6).
 *
 * `/healthz` answers only "is the process up". When a session will not start,
 * that says nothing about why: the provider CLI may be missing, the cache may
 * have failed to open, or the clock may be skewed past the pairing TTL.
 *
 * Every subsystem is checked independently so one failure never masks another,
 * and each carries a stable remediation code the client maps to instructions
 * without parsing English.
 *
 * The response is designed to be pasted into a bug report, so paths are reduced
 * to their last two segments and the whole payload passes through redactValue()
 * before serialization.
 */

function providerCheck(name: string, resolve: () => string): DiagnosticCheck {
  try {
    const exe = resolve();
    // Report only that it resolved and roughly where — never the full path,
    // which carries the username and home layout.
    return {
      id: `provider:${name}`,
      status: "ok",
      summary: `${name} CLI is installed.`,
      remediation: "NONE",
      detail: { location: redactPath(exe) },
    };
  } catch {
    return {
      id: `provider:${name}`,
      status: "failed",
      summary: `${name} CLI could not be located. Sessions for this provider cannot start.`,
      remediation: "PROVIDER_NOT_INSTALLED",
    };
  }
}

export const createDiagnosticsRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const checks: DiagnosticCheck[] = [];

    checks.push({
      id: "streamer",
      status: "ok",
      summary: "Streamer is running.",
      remediation: "NONE",
      detail: { version: getVersion(), uptimeSeconds: Math.floor(process.uptime()) },
    });

    checks.push(providerCheck("claude-code", resolveClaudeExe));
    checks.push(providerCheck("codex-cli", resolveCodexExe));

    // The cache backs conversation reads; without it every request falls back
    // to slower disk-only scans, which is degraded rather than broken.
    const cacheAlert = deps.cacheMonitor()?.healthzField();
    checks.push(
      cacheAlert
        ? {
            id: "cache",
            status: "degraded",
            summary: "Conversation cache reported an integrity alert.",
            remediation: "CACHE_DEGRADED",
          }
        : {
            id: "cache",
            status: "ok",
            summary: "Conversation cache is healthy.",
            remediation: "NONE",
          },
    );

    // node-pty is a native addon; if it failed to load, no managed session can
    // start regardless of provider availability.
    let ptyOk = true;
    try {
      require.resolve("node-pty");
    } catch {
      ptyOk = false;
    }
    checks.push(
      ptyOk
        ? { id: "pty", status: "ok", summary: "PTY subsystem is available.", remediation: "NONE" }
        : {
            id: "pty",
            status: "failed",
            summary: "node-pty failed to load, so no managed session can start.",
            remediation: "PTY_UNAVAILABLE",
          },
    );

    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const claudeProjects = home ? `${home}/.claude/projects` : "";
    checks.push(
      claudeProjects && existsSync(claudeProjects)
        ? {
            id: "filesystem",
            status: "ok",
            summary: "Provider history directory is present.",
            remediation: "NONE",
            detail: { location: redactPath(claudeProjects) },
          }
        : {
            id: "filesystem",
            status: "degraded",
            summary: "Provider history directory was not found; history may be unavailable.",
            remediation: "FS_SCOPE_MISSING",
          },
    );

    // Final redaction pass. Individual checks are written not to include
    // secrets, but this payload is meant to be shared, so one careless field
    // must not be able to leak a credential.
    return c.json(redactValue(buildReport(checks)));
  });

  /**
   * GET /api/diagnostics/sessions — why each registry row ended up as it did
   * (plan Phase 5, gap G11).
   *
   * `GET /api/sessions` shows the outcome; this shows the reasoning. "My
   * session did not come back after a restart" is otherwise unanswerable
   * without the server's logs, and the interesting rows are precisely the ones
   * that never made it into the session list.
   *
   * Read-only and side-effect free: it recomputes the rehydration decision from
   * the same pure function the boot path uses rather than recording one, so
   * calling it can never change what a later boot would do.
   */
  app.get("/sessions", (c) => {
    const repo = deps.managedSessionsRepo();
    if (!repo) {
      return c.json(
        { error: "Session registry is unavailable", code: "REGISTRY_UNAVAILABLE" },
        503,
      );
    }

    const rows = repo.listAll();
    const verdicts = deps.sessionVerdicts();
    const bootToken = currentBootToken();
    const now = Date.now();

    const sessions = rows.map((row) => {
      const verdict = verdicts.get(row.session_id);
      const skip = rehydrateSkipReason(row, { now, projectExists: existsSync });
      return {
        sessionId: row.session_id,
        provider: row.provider,
        status: row.status,
        statusSource: row.status_source,
        statusUpdatedAt: new Date(row.status_updated_at).toISOString(),
        // Whether the recorded pid is probeable at all this boot, not whether
        // it is alive — a mismatch means the question was never asked.
        //
        // NOT named for the boot token it derives from: `redactValue`'s
        // SECRET_KEY_RE matches any key containing "token", so `bootTokenMatches`
        // was scrubbed to the string "[redacted]" and the field shipped useless.
        // The regex is deliberately over-broad for a payload meant to be pasted
        // into bug reports, so the field moved rather than the guard.
        recordedThisBoot: row.boot_token != null && row.boot_token === bootToken,
        // Absent when this boot never classified the row: a clean restart
        // stamps completed_at on the way out, which takes it out of the probe
        // set entirely. That absence is itself the answer.
        lifecycle: verdict?.lifecycle ?? null,
        lifecycleReason: verdict?.reason ?? null,
        rehydrated: skip == null,
        rehydrateSkipReason: skip,
        projectExists: existsSync(row.project_path),
        projectPath: redactPath(row.project_path),
      };
    });

    // Same contract as the report above: meant to be pasted into a bug report,
    // so paths are reduced and the whole payload gets a final redaction pass.
    return c.json(redactValue({ generatedAt: new Date().toISOString(), sessions }));
  });

  return app;
};
