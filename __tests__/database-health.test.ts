import Database from "better-sqlite3";
import { createHealthRoutes } from "../src/api/routes/health.routes";
import type { ApiDeps } from "../src/api/types/api-deps";
import { instrumentDatabase } from "../src/db/query-timing";

it("surfaces repeated query failures and recovers after the observation window", async () => {
  vi.useFakeTimers();
  const db = instrumentDatabase(new Database(":memory:"));
  const health = createHealthRoutes({ cacheMonitor: () => null } as ApiDeps);
  try {
    const stmt = db.prepare("SELECT ?");
    for (let i = 0; i < 3; i++) expect(() => stmt.get()).toThrow();
    const res = await health.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, databaseAlert: { recentFailures: 3 } });
    vi.advanceTimersByTime(60_001);
    expect(await (await health.request("/")).json()).not.toHaveProperty("databaseAlert");
  } finally {
    db.close();
    vi.useRealTimers();
  }
});
