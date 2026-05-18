/**
 * Asks the running streamer how many sessions are mid-conversation.
 * Returns 0 if the streamer is not reachable (interpreted as "safe to update").
 *
 * The updater hits this *over the network* rather than reading SessionStore
 * directly because it runs as a separate CLI invocation with no shared
 * memory.
 */
export async function countActiveSessions(opts: {
  port: number;
  apiKey: string;
  timeoutMs?: number;
}): Promise<number> {
  const url = `http://127.0.0.1:${opts.port}/api/sessions?status=running,waiting_input&limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return 0;
    const body = (await res.json()) as { total?: number; sessions?: unknown[] };
    return body.total ?? body.sessions?.length ?? 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}
