import type { WebSocket } from "ws";
import { createMiscRoutes } from "../src/api/routes/misc.routes";
import { resolveFeatureFlags } from "../src/feature-flags";
import type { ApiDepsWiring } from "../src/server-wiring";
import { createApiDeps } from "../src/server-wiring";
import {
  type CpuTimesSnapshot,
  classifyHostPressure,
  cpuBusyRatio,
  HOST_PRESSURE_BARS,
  HOST_PRESSURE_SAMPLE_MS,
  HostPressureMonitor,
  type HostSample,
  hostPressureOs,
} from "../src/services/host-pressure/hostPressure";
import type { SessionStore } from "../src/session-store";
import type { HostPressureReason, WSMessage } from "../src/types";
import type { WSHub } from "../src/ws-hub";

const POSIX: NodeJS.Platform = "linux";
const WIN32: NodeJS.Platform = "win32";

const healthy: HostSample = {
  liveAgents: 0,
  memFreeRatio: 0.5,
  eventLoopP99Ms: 10,
  load1: 0.2,
  ncpu: 8,
};

function sample(over: Partial<HostSample>): HostSample {
  return { ...healthy, ...over };
}

describe("HOST_PRESSURE_BARS", () => {
  it("locks the starting enter bars", () => {
    expect(HOST_PRESSURE_BARS.memFreeRatio.enterElevated).toBe(0.15);
    expect(HOST_PRESSURE_BARS.memFreeRatio.enterCritical).toBe(0.08);
    expect(HOST_PRESSURE_BARS.eventLoopP99Ms.enterElevated).toBe(100);
    expect(HOST_PRESSURE_BARS.eventLoopP99Ms.enterCritical).toBe(250);
    expect(HOST_PRESSURE_BARS.loadPerCpu.enterElevated).toBe(1.25);
    expect(HOST_PRESSURE_BARS.loadPerCpu.enterCritical).toBe(2.0);
    expect(HOST_PRESSURE_BARS.cpuBusy.enterElevated).toBe(0.85);
    expect(HOST_PRESSURE_BARS.cpuBusy.enterCritical).toBe(0.97);
    expect(HOST_PRESSURE_BARS.liveAgentsPair).toBe(4);
  });
});

describe("classifyHostPressure", () => {
  it("is ok on a quiet host", () => {
    expect(classifyHostPressure(healthy, "ok", POSIX)).toEqual({ level: "ok", reasons: [] });
  });

  it("is elevated on free memory below 15%", () => {
    expect(classifyHostPressure(sample({ memFreeRatio: 0.14 }), "ok", POSIX)).toEqual({
      level: "elevated",
      reasons: ["memory"],
    });
  });

  it("is critical on free memory below 8%", () => {
    expect(classifyHostPressure(sample({ memFreeRatio: 0.07 }), "ok", POSIX)).toEqual({
      level: "critical",
      reasons: ["memory"],
    });
  });

  it("caps Darwin unused-page memory at elevated, never critical", () => {
    expect(classifyHostPressure(sample({ memFreeRatio: 0.005 }), "ok", "darwin")).toEqual({
      level: "elevated",
      reasons: ["memory"],
    });
    expect(classifyHostPressure(sample({ memFreeRatio: 0.07 }), "ok", "darwin")).toEqual({
      level: "elevated",
      reasons: ["memory"],
    });
  });

  it("still allows critical on Darwin from event-loop stall", () => {
    expect(
      classifyHostPressure(sample({ memFreeRatio: 0.5, eventLoopP99Ms: 260 }), "ok", "darwin"),
    ).toEqual({
      level: "critical",
      reasons: ["event_loop"],
    });
  });

  it("is elevated on event-loop p99 above 100ms", () => {
    expect(classifyHostPressure(sample({ eventLoopP99Ms: 120 }), "ok", POSIX)).toEqual({
      level: "elevated",
      reasons: ["event_loop"],
    });
  });

  it("is critical on event-loop p99 above 250ms", () => {
    expect(classifyHostPressure(sample({ eventLoopP99Ms: 260 }), "ok", POSIX)).toEqual({
      level: "critical",
      reasons: ["event_loop"],
    });
  });

  it("is elevated when POSIX load per cpu crosses 1.25", () => {
    expect(classifyHostPressure(sample({ load1: 11, ncpu: 8 }), "ok", POSIX)).toEqual({
      level: "elevated",
      reasons: ["load"],
    });
  });

  it("is ok when POSIX load per cpu is 1.0", () => {
    expect(classifyHostPressure(sample({ load1: 8, ncpu: 8 }), "ok", POSIX)).toEqual({
      level: "ok",
      reasons: [],
    });
  });

  it("is critical when POSIX load per cpu crosses 2.0", () => {
    expect(classifyHostPressure(sample({ load1: 17, ncpu: 8 }), "ok", POSIX)).toEqual({
      level: "critical",
      reasons: ["load"],
    });
  });

  it("ignores POSIX loadavg on win32", () => {
    expect(classifyHostPressure(sample({ load1: 13, ncpu: 8 }), "ok", WIN32)).toEqual({
      level: "ok",
      reasons: [],
    });
  });

  it("is elevated on win32 when cpu busy crosses 0.85", () => {
    expect(classifyHostPressure(sample({ cpuBusyRatio: 0.9 }), "ok", WIN32)).toEqual({
      level: "elevated",
      reasons: ["load"],
    });
  });

  it("is critical on win32 when cpu busy crosses 0.97", () => {
    expect(classifyHostPressure(sample({ cpuBusyRatio: 0.99 }), "ok", WIN32)).toEqual({
      level: "critical",
      reasons: ["load"],
    });
  });

  it("pairs liveAgents >= 4 with win32 cpu busy", () => {
    expect(classifyHostPressure(sample({ liveAgents: 4, cpuBusyRatio: 0.9 }), "ok", WIN32)).toEqual(
      {
        level: "elevated",
        reasons: ["load", "agents"],
      },
    );
  });

  it("does not use cpuBusyRatio on POSIX", () => {
    const hotBusy = sample({ cpuBusyRatio: 0.99, load1: 0.2, ncpu: 8 });
    expect(classifyHostPressure(hotBusy, "ok", POSIX)).toEqual({
      level: "ok",
      reasons: [],
    });
    expect(classifyHostPressure(hotBusy, "ok", "darwin")).toEqual({
      level: "ok",
      reasons: [],
    });
  });

  it("does not elevate on liveAgents >= 4 alone", () => {
    expect(classifyHostPressure(sample({ liveAgents: 4 }), "ok", POSIX)).toEqual({
      level: "ok",
      reasons: [],
    });
  });

  it("pairs liveAgents >= 4 with a resource signal", () => {
    expect(
      classifyHostPressure(sample({ liveAgents: 4, memFreeRatio: 0.14 }), "ok", POSIX),
    ).toEqual({
      level: "elevated",
      reasons: ["memory", "agents"],
    });
  });

  it("lists every firing reason worst-first", () => {
    const reasons: HostPressureReason[] = ["memory", "event_loop", "load", "agents"];
    expect(
      classifyHostPressure(
        sample({
          liveAgents: 4,
          memFreeRatio: 0.07,
          eventLoopP99Ms: 260,
          load1: 17,
          ncpu: 8,
        }),
        "ok",
        POSIX,
      ),
    ).toEqual({ level: "critical", reasons });
  });

  it("enters a level on one sample above the enter bar", () => {
    expect(classifyHostPressure(sample({ eventLoopP99Ms: 120 }), "ok", POSIX).level).toBe(
      "elevated",
    );
    expect(classifyHostPressure(sample({ eventLoopP99Ms: 260 }), "ok", POSIX).level).toBe(
      "critical",
    );
  });

  it("stays critical between the critical and elevated bars", () => {
    const entered = classifyHostPressure(sample({ memFreeRatio: 0.07 }), "ok", POSIX);
    expect(entered.level).toBe("critical");
    expect(classifyHostPressure(sample({ memFreeRatio: 0.1 }), "critical", POSIX).level).toBe(
      "critical",
    );
  });

  it("does not flicker on a 14.9% ↔ 15.1% free-mem wiggle once elevated", () => {
    const entered = classifyHostPressure(sample({ memFreeRatio: 0.149 }), "ok", POSIX);
    expect(entered.level).toBe("elevated");
    expect(classifyHostPressure(sample({ memFreeRatio: 0.151 }), "elevated", POSIX).level).toBe(
      "elevated",
    );
  });

  it("clears to ok after recovering past the leave bar", () => {
    expect(classifyHostPressure(sample({ memFreeRatio: 0.2 }), "elevated", POSIX).level).toBe("ok");
    expect(classifyHostPressure(sample({ memFreeRatio: 0.2 }), "critical", POSIX).level).toBe("ok");
  });
});

describe("hostPressureOs", () => {
  it("keeps darwin, linux, and win32", () => {
    expect(hostPressureOs("darwin")).toBe("darwin");
    expect(hostPressureOs("linux")).toBe("linux");
    expect(hostPressureOs("win32")).toBe("win32");
  });

  it("omits platforms the client has no advice for", () => {
    expect(hostPressureOs("freebsd")).toBeUndefined();
  });
});

describe("cpuBusyRatio", () => {
  const idle: CpuTimesSnapshot = { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 };

  it("is 0 without a previous snapshot", () => {
    expect(cpuBusyRatio(null, [{ user: 80, nice: 0, sys: 20, idle: 100, irq: 0 }])).toBe(0);
  });

  it("is 0 when cpu counts differ", () => {
    expect(cpuBusyRatio([idle], [idle, idle])).toBe(0);
  });

  it("is 0 when the interval is all idle", () => {
    const later: CpuTimesSnapshot = { user: 0, nice: 0, sys: 0, idle: 200, irq: 0 };
    expect(cpuBusyRatio([idle], [later])).toBe(0);
  });

  it("is 1 when the interval has no idle", () => {
    const later: CpuTimesSnapshot = { user: 80, nice: 0, sys: 20, idle: 100, irq: 0 };
    expect(cpuBusyRatio([idle], [later])).toBe(1);
  });
});

describe("HostPressureMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("broadcasts host_pressure on a level change and stays quiet on the same level", () => {
    const broadcasts: WSMessage[] = [];
    const hub: Pick<WSHub, "broadcast"> = { broadcast: (msg) => broadcasts.push(msg) };
    let current = healthy;
    const monitor = new HostPressureMonitor({
      wsHub: hub,
      readSample: () => current,
      platform: POSIX,
      now: () => new Date(),
    });
    current = sample({ memFreeRatio: 0.14, liveAgents: 2 });
    monitor.start();

    vi.advanceTimersByTime(HOST_PRESSURE_SAMPLE_MS);
    expect(broadcasts).toEqual([
      {
        type: "host_pressure",
        level: "elevated",
        reasons: ["memory"],
        liveAgents: 2,
        updatedAt: "2026-08-18T12:00:05.000Z",
        os: "linux",
      },
    ]);

    current = sample({ memFreeRatio: 0.13, liveAgents: 3 });
    vi.advanceTimersByTime(HOST_PRESSURE_SAMPLE_MS);
    expect(broadcasts).toHaveLength(1);

    current = healthy;
    vi.advanceTimersByTime(HOST_PRESSURE_SAMPLE_MS);
    expect(broadcasts[1]).toEqual({
      type: "host_pressure_cleared",
      updatedAt: "2026-08-18T12:00:15.000Z",
    });

    monitor.dispose();
  });

  it("includes os on darwin, linux, and win32 and omits it otherwise", () => {
    function firstFrame(platform: NodeJS.Platform): WSMessage {
      const broadcasts: WSMessage[] = [];
      let current = healthy;
      const monitor = new HostPressureMonitor({
        wsHub: { broadcast: (msg) => broadcasts.push(msg) },
        readSample: () => current,
        platform,
        now: () => new Date(),
      });
      current = sample({ memFreeRatio: 0.14 });
      monitor.start();
      vi.advanceTimersByTime(HOST_PRESSURE_SAMPLE_MS);
      monitor.dispose();
      const frame = broadcasts[0];
      if (!frame) throw new Error("expected a host_pressure frame");
      return frame;
    }

    expect(firstFrame("linux")).toMatchObject({ type: "host_pressure", os: "linux" });
    expect(firstFrame("darwin")).toMatchObject({ type: "host_pressure", os: "darwin" });
    expect(firstFrame("win32")).toMatchObject({ type: "host_pressure", os: "win32" });
    const other = firstFrame("freebsd");
    expect(other).toMatchObject({ type: "host_pressure", level: "elevated", reasons: ["memory"] });
    expect(other).not.toHaveProperty("os");
  });

  it("does not emit host_pressure_cleared on a process that never warned", () => {
    const broadcasts: WSMessage[] = [];
    const monitor = new HostPressureMonitor({
      wsHub: { broadcast: (msg) => broadcasts.push(msg) },
      readSample: () => healthy,
      platform: POSIX,
    });
    monitor.start();
    vi.advanceTimersByTime(HOST_PRESSURE_SAMPLE_MS * 3);
    expect(broadcasts).toEqual([]);
    expect(monitor.wsMessage()).toBeNull();
    monitor.dispose();
  });
});

describe("handleWsOpen host_pressure replay", () => {
  const warning: Extract<WSMessage, { type: "host_pressure" }> = {
    type: "host_pressure",
    level: "elevated",
    reasons: ["memory"],
    liveAgents: 4,
    updatedAt: "2026-08-18T12:00:00.000Z",
    os: "linux",
  };

  function openDeps(wsMessage: WSMessage | null) {
    const unicast = vi.fn();
    const addClient = vi.fn();
    const wiring = {
      wsHub: { addClient, unicast, broadcast: vi.fn() },
      sessionStore: { list: () => [] },
      ptyAttachedIds: () => new Set<string>(),
      withReconciledLifecycle: (sessions: readonly unknown[]) => sessions,
      currentWarmupState: () => null,
      cacheMonitor: () => null,
      hostPressureMonitor: () => (wsMessage ? { wsMessage: () => wsMessage } : null),
    } as unknown as ApiDepsWiring;
    return { handleWsOpen: createApiDeps(wiring).handleWsOpen, unicast };
  }

  it("unicasts host_pressure to a new socket while currently warned", () => {
    const { handleWsOpen, unicast } = openDeps(warning);
    const ws = { send: vi.fn() } as unknown as WebSocket;
    handleWsOpen(ws);
    expect(unicast).toHaveBeenCalledWith(ws, warning);
  });

  it("stays silent on open when ok", () => {
    const { handleWsOpen, unicast } = openDeps(null);
    const ws = { send: vi.fn() } as unknown as WebSocket;
    handleWsOpen(ws);
    expect(unicast).not.toHaveBeenCalled();
  });
});

describe("GET /api/info hostPressure", () => {
  it("includes hostPressure: true", async () => {
    const flags = resolveFeatureFlags({ env: {} });
    const app = createMiscRoutes({
      publicUrl: null,
      sessionStore: { list: () => [] } as SessionStore,
      ptyAttachedIds: () => new Set(),
      rotateApiKey: () => ({ newKey: "x", persisted: false }),
      localNoAuth: true,
      pushRepo: () => null,
      liveActivityPushEnabled: () => false,
      featureFlagsConfig: () => ({
        registry: [],
        values: flags.values,
        sources: flags.sources,
      }),
    });
    const res = await app.request("/api/info");
    const body = (await res.json()) as { hostPressure: boolean };
    expect(res.status).toBe(200);
    expect(body.hostPressure).toBe(true);
  });
});
