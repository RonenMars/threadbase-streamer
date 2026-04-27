import { randomBytes } from "crypto";

export interface PairTokenRecord {
  token: string;
  expiresAt: number;
  used: boolean;
}

export interface MintResult {
  token: string;
  expiresAt: number;
  expiresInSeconds: number;
}

export interface ConsumeOk {
  ok: true;
}

export interface ConsumeErr {
  ok: false;
  reason: "unknown" | "expired" | "used";
}

export type ConsumeResult = ConsumeOk | ConsumeErr;

const DEFAULT_TTL_SECONDS = 180;
const SWEEP_INTERVAL_MS = 60_000;

export class PairTokenStore {
  private current: PairTokenRecord | null = null;
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { ttlSeconds?: number; autoSweep?: boolean } = {}) {
    this.ttlMs = (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    if (opts.autoSweep !== false) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  mint(): MintResult {
    const token = `pt_${randomBytes(16).toString("hex")}`;
    const expiresAt = Date.now() + this.ttlMs;
    this.current = { token, expiresAt, used: false };
    return {
      token,
      expiresAt,
      expiresInSeconds: Math.floor(this.ttlMs / 1000),
    };
  }

  consume(token: string): ConsumeResult {
    const record = this.current;
    if (!record || record.token !== token) return { ok: false, reason: "unknown" };
    if (Date.now() > record.expiresAt) {
      this.current = null;
      return { ok: false, reason: "expired" };
    }
    if (record.used) return { ok: false, reason: "used" };
    record.used = true;
    return { ok: true };
  }

  peek(): PairTokenRecord | null {
    return this.current;
  }

  clear(): void {
    this.current = null;
  }

  sweep(): void {
    if (this.current && Date.now() > this.current.expiresAt) {
      this.current = null;
    }
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.current = null;
  }
}
