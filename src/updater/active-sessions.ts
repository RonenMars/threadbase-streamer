export type ActiveSessionsResult =
  | { kind: "count"; count: number }
  | { kind: "unreachable"; reason: string }
  | { kind: "error"; status?: number; reason: string };

/**
 * Asks the running streamer how many sessions are mid-conversation.
 *
 * Three outcomes, intentionally distinguished so the caller can decide what
 * to do with each:
 *   - "count":       the streamer answered; trust the number.
 *   - "unreachable": connection refused, DNS failure, timeout. The streamer
 *                    is almost certainly not running, so there is no active
 *                    work to interrupt. Caller should proceed with update.
 *   - "error":       the streamer responded, but with a non-2xx status or
 *                    malformed body. State is unknown — caller should defer
 *                    rather than risk killing live sessions.
 */
export async function countActiveSessions(opts: {
  port: number;
  apiKey: string;
  timeoutMs?: number;
}): Promise<ActiveSessionsResult> {
  const url = `http://127.0.0.1:${opts.port}/api/sessions?status=running,waiting_input&limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: controller.signal,
    });
  } catch (err) {
    return { kind: "unreachable", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return {
      kind: "error",
      status: res.status,
      reason: `streamer returned ${res.status} ${res.statusText}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      kind: "error",
      status: res.status,
      reason: `malformed JSON from streamer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = body as { total?: unknown; sessions?: unknown };
  if (typeof parsed.total === "number") return { kind: "count", count: parsed.total };
  if (Array.isArray(parsed.sessions)) return { kind: "count", count: parsed.sessions.length };

  return {
    kind: "error",
    status: res.status,
    reason: "streamer response missing both 'total' and 'sessions'",
  };
}
