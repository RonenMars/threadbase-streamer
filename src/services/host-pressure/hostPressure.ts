import { cpus, freemem, loadavg, totalmem } from "os";
import { type IntervalHistogram, monitorEventLoopDelay } from "perf_hooks";
import type { HostPressureLevel, HostPressureReason, WSMessage } from "../../types";
import type { WSHub } from "../../ws-hub";

export const HOST_PRESSURE_SAMPLE_MS = 5_000;

/**
 * Enter a level at the more extreme bar; leave at the less extreme bar so a
 * value sitting between them does not flicker. The elevated→ok leave bars sit
 * a little past the enter bars so a 14.9% ↔ 15.1% free-mem wiggle stays put.
 *
 * Tune these only together with `__tests__/host-pressure.test.ts`.
 */
export const HOST_PRESSURE_BARS = {
  memFreeRatio: {
    enterElevated: 0.15,
    leaveElevated: 0.17,
    enterCritical: 0.08,
    leaveCritical: 0.15,
  },
  eventLoopP99Ms: {
    enterElevated: 100,
    leaveElevated: 80,
    enterCritical: 250,
    leaveCritical: 100,
  },
  loadPerCpu: {
    enterElevated: 0.9,
    leaveElevated: 0.7,
    enterCritical: 1.5,
    leaveCritical: 0.9,
  },
  liveAgentsPair: 4,
} as const;

export type HostSample = {
  liveAgents: number;
  memFreeRatio: number;
  eventLoopP99Ms: number;
  load1: number;
  ncpu: number;
};

export type HostPressureState = "ok" | HostPressureLevel;

export type HostPressureClassification = {
  level: HostPressureState;
  reasons: HostPressureReason[];
};

export type HostPressureWsMessage = Extract<WSMessage, { type: "host_pressure" }>;

const REASON_ORDER: readonly HostPressureReason[] = ["memory", "event_loop", "load", "agents"];

const RANK: Record<HostPressureState, number> = { ok: 0, elevated: 1, critical: 2 };

function worst(levels: HostPressureState[]): HostPressureState {
  return levels.reduce<HostPressureState>(
    (acc, level) => (RANK[level] > RANK[acc] ? level : acc),
    "ok",
  );
}

function schmittLowIsWorse(
  value: number,
  previous: HostPressureState,
  enterElevated: number,
  leaveElevated: number,
  enterCritical: number,
  leaveCritical: number,
): HostPressureState {
  if (previous === "critical") {
    if (value < leaveCritical) return "critical";
    if (value < leaveElevated) return "elevated";
    return "ok";
  }
  if (previous === "elevated") {
    if (value < enterCritical) return "critical";
    if (value < leaveElevated) return "elevated";
    return "ok";
  }
  if (value < enterCritical) return "critical";
  if (value < enterElevated) return "elevated";
  return "ok";
}

function schmittHighIsWorse(
  value: number,
  previous: HostPressureState,
  enterElevated: number,
  leaveElevated: number,
  enterCritical: number,
  leaveCritical: number,
): HostPressureState {
  if (previous === "critical") {
    if (value > leaveCritical) return "critical";
    if (value > leaveElevated) return "elevated";
    return "ok";
  }
  if (previous === "elevated") {
    if (value > enterCritical) return "critical";
    if (value > leaveElevated) return "elevated";
    return "ok";
  }
  if (value > enterCritical) return "critical";
  if (value > enterElevated) return "elevated";
  return "ok";
}

export function classifyHostPressure(
  sample: HostSample,
  previous: HostPressureState,
  platform: NodeJS.Platform,
): HostPressureClassification {
  const mem = schmittLowIsWorse(
    sample.memFreeRatio,
    previous,
    HOST_PRESSURE_BARS.memFreeRatio.enterElevated,
    HOST_PRESSURE_BARS.memFreeRatio.leaveElevated,
    HOST_PRESSURE_BARS.memFreeRatio.enterCritical,
    HOST_PRESSURE_BARS.memFreeRatio.leaveCritical,
  );
  const eventLoop = schmittHighIsWorse(
    sample.eventLoopP99Ms,
    previous,
    HOST_PRESSURE_BARS.eventLoopP99Ms.enterElevated,
    HOST_PRESSURE_BARS.eventLoopP99Ms.leaveElevated,
    HOST_PRESSURE_BARS.eventLoopP99Ms.enterCritical,
    HOST_PRESSURE_BARS.eventLoopP99Ms.leaveCritical,
  );
  const ncpu = sample.ncpu > 0 ? sample.ncpu : 1;
  const loadPerCpu = platform === "win32" ? 0 : sample.load1 / ncpu;
  const load =
    platform === "win32"
      ? "ok"
      : schmittHighIsWorse(
          loadPerCpu,
          previous,
          HOST_PRESSURE_BARS.loadPerCpu.enterElevated,
          HOST_PRESSURE_BARS.loadPerCpu.leaveElevated,
          HOST_PRESSURE_BARS.loadPerCpu.enterCritical,
          HOST_PRESSURE_BARS.loadPerCpu.leaveCritical,
        );

  const resourceLevel = worst([mem, eventLoop, load]);
  const agentsPair =
    sample.liveAgents >= HOST_PRESSURE_BARS.liveAgentsPair && resourceLevel !== "ok";
  const level = resourceLevel;

  const firing: HostPressureReason[] = [];
  if (mem !== "ok") firing.push("memory");
  if (eventLoop !== "ok") firing.push("event_loop");
  if (load !== "ok") firing.push("load");
  if (agentsPair) firing.push("agents");
  const reasons = REASON_ORDER.filter((reason) => firing.includes(reason));

  return { level, reasons };
}

export type HostPressureMonitorOpts = {
  wsHub: Pick<WSHub, "broadcast">;
  readSample: () => HostSample;
  now?: () => Date;
  platform?: NodeJS.Platform;
  histogram?: IntervalHistogram;
  intervalMs?: number;
};

export class HostPressureMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private level: HostPressureState = "ok";
  private lastWarning: HostPressureWsMessage | null = null;

  constructor(private readonly opts: HostPressureMonitorOpts) {}

  start(): void {
    this.opts.histogram?.enable();
    if (this.timer) return;
    const intervalMs = this.opts.intervalMs ?? HOST_PRESSURE_SAMPLE_MS;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  tick(): void {
    const sample = this.opts.readSample();
    const platform = this.opts.platform ?? process.platform;
    const classified = classifyHostPressure(sample, this.level, platform);
    if (classified.level === this.level) return;

    this.level = classified.level;
    const updatedAt = (this.opts.now ?? (() => new Date()))().toISOString();
    if (classified.level === "ok") {
      this.lastWarning = null;
      this.opts.wsHub.broadcast({ type: "host_pressure_cleared", updatedAt });
      return;
    }

    const message: HostPressureWsMessage = {
      type: "host_pressure",
      level: classified.level,
      reasons: classified.reasons,
      liveAgents: sample.liveAgents,
      updatedAt,
    };
    this.lastWarning = message;
    this.opts.wsHub.broadcast(message);
  }

  wsMessage(): HostPressureWsMessage | null {
    return this.lastWarning;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.opts.histogram?.disable();
  }
}

export function createHostPressureMonitor(
  wsHub: WSHub,
  liveAgents: () => number,
): HostPressureMonitor {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const monitor = new HostPressureMonitor({
    wsHub,
    histogram,
    readSample: () => {
      const eventLoopP99Ms = histogram.percentile(99) / 1e6;
      histogram.reset();
      const total = totalmem();
      return {
        liveAgents: liveAgents(),
        memFreeRatio: total > 0 ? freemem() / total : 1,
        eventLoopP99Ms,
        load1: loadavg()[0],
        ncpu: cpus().length,
      };
    },
  });
  monitor.start();
  return monitor;
}
