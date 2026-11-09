#!/usr/bin/env node
// Samples RSS + interval CPU of the streamer's processes once a minute for 24h.
// Out-of-process on purpose: needs no deploy, and survives streamer restarts (pids just change).
// Usage: node scripts/resource-sampler.mjs   (env: INTERVAL_S=60 TICKS=1440 OUT=<csv>)
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";

const INTERVAL_S = Number(process.env.INTERVAL_S ?? 60);
const TICKS = Number(process.env.TICKS ?? 1440); // 24h at 60s
const CHECK_EVERY = Number(process.env.CHECK_EVERY ?? Math.round(3600 / INTERVAL_S)); // hourly size check
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 2 * 1024 * 1024); // ponytail: 24h of data is ~0.3 MB; cap is a safety net, not a limit we expect to hit
const OUT = process.env.OUT ?? join(homedir(), ".threadbase/logs/resource-sample.csv");

const roleOf = (cmd) =>
  cmd.includes("pty-host") ? "pty-host" : cmd.includes("cli.js serve") ? "serve" : cmd.includes("launchd-entry") ? "supervisor" : null;

// ps cputime is "[h:]mm:ss.ss"
const cpuSecs = (t) => t.split(":").reduce((a, p) => a * 60 + Number(p), 0);

function snapshot() {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,rss=,cputime=,etime=,command="], { encoding: "utf8" }).split("\n");
  const out = [];
  for (const r of rows) {
    const m = r.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m || !m[5].includes(".threadbase/")) continue;
    const role = roleOf(m[5]);
    if (role) out.push({ pid: m[1], role, rssMb: m[2] / 1024, cpu: cpuSecs(m[3]), etime: m[4] });
  }
  return out;
}

function hourlyCleanup() {
  const size = statSync(OUT).size;
  const trimmed = size > MAX_BYTES;
  if (trimmed) {
    const lines = readFileSync(OUT, "utf8").split("\n");
    writeFileSync(OUT, [lines[0], ...lines.slice(-Math.floor(lines.length / 2))].join("\n"));
  }
  console.log(`${new Date().toISOString()} size-check bytes=${size} trimmed=${trimmed}`);
}

if (!existsSync(OUT)) writeFileSync(OUT, "ts,pid,role,rss_mb,cpu_pct,etime,load1\n");
const prev = new Map(); // pid -> cpu seconds at last tick
for (let tick = 1; tick <= TICKS; tick++) {
  const ts = new Date().toISOString();
  const load1 = loadavg()[0].toFixed(2);
  const lines = snapshot().map((p) => {
    const before = prev.get(p.pid);
    prev.set(p.pid, p.cpu);
    const cpuPct = before === undefined ? "" : (((p.cpu - before) / INTERVAL_S) * 100).toFixed(1);
    return `${ts},${p.pid},${p.role},${p.rssMb.toFixed(1)},${cpuPct},${p.etime},${load1}`;
  });
  if (lines.length) appendFileSync(OUT, lines.join("\n") + "\n");
  if (tick % CHECK_EVERY === 0) hourlyCleanup();
  if (tick < TICKS) await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
}
console.log(`${new Date().toISOString()} done after ${TICKS} ticks`);
