/**
 * Load test: N concurrent matches against a game server in open mode.
 *
 *   LT_URL=https://cockfight-loadtest.fly.dev LT_MATCHES=200 LT_SECONDS=600 pnpm --filter @cockfight/tools loadtest
 *
 * Spreads the bots over LT_PROCS processes (bots.ts), polls the server's
 * /health every 5 s (rooms, connections, event-loop delay, memory) and writes
 * a report to tools/loadtest/results/. Never point it at the live server:
 * it needs GATE_MODE=open (see docs/runbook-launch.md, "Load test").
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const url = (process.env.LT_URL ?? "http://localhost:2567").replace(/\/$/, "");
const matches = Number(process.env.LT_MATCHES ?? 200);
const seconds = Number(process.env.LT_SECONDS ?? 600);
const procs = Number(process.env.LT_PROCS ?? 8);
const here = resolve(import.meta.dirname);

interface Match { ok: boolean; err?: string; queueMs?: number; matchMs?: number; rtt?: number; rollbacks?: number; maxDepth?: number; snaps?: number; desyncs?: number }
const done: Match[] = [];
const health: object[] = [];
const started = Date.now();

const children = Array.from({ length: procs }, (_, i) => {
  const pairs = Math.floor(matches / procs) + (i < matches % procs ? 1 : 0);
  const c = spawn(process.execPath, ["--import", "tsx", resolve(here, "bots.ts")], {
    env: { ...process.env, LT_URL: url, LT_PAIRS: String(pairs), LT_SECONDS: String(seconds), LT_ID: String(i) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  createInterface({ input: c.stdout! }).on("line", (l) => {
    try {
      const o = JSON.parse(l) as { match?: Match };
      if (o.match) done.push(o.match);
    } catch {
      /* not ours */
    }
  });
  return new Promise<void>((r) => c.on("exit", () => r()));
});

const poll = setInterval(async () => {
  try {
    const h = (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) })).json()) as Record<string, unknown>;
    const s = { t: Math.round((Date.now() - started) / 1000), ...h };
    health.push(s);
    const ok = done.filter((m) => m.ok).length;
    console.log(`[${s.t}s] rooms ${h.rooms} ccu ${h.ccu} load ${JSON.stringify(h.load)} · matches done ${ok} ok / ${done.length - ok} failed`);
  } catch (e) {
    health.push({ t: Math.round((Date.now() - started) / 1000), error: String(e) });
    console.log("health check failed:", String(e));
  }
}, 5000);

// Matches still running at the deadline finish; a bot left alone in the queue gives up after 120 s.
await Promise.all(children);
clearInterval(poll);

const ok = done.filter((m) => m.ok);
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] : 0);
const loads = health.flatMap((h) => ("load" in h ? [(h as { load: { loopP99Ms: number; loopMaxMs: number; rssMb: number } }).load] : []));
const summary = {
  url,
  matchesTarget: matches,
  peckEvery: Number(process.env.LT_PECK_EVERY ?? 40),
  seconds,
  /** Each match is reported by both of its bots. */
  matchesFinished: Math.floor(ok.length / 2),
  seatsFailed: done.length - ok.length,
  failures: Object.entries(done.filter((m) => !m.ok).reduce<Record<string, number>>((a, m) => ((a[m.err ?? "?"] = (a[m.err ?? "?"] ?? 0) + 1), a), {})),
  peakRooms: Math.max(0, ...health.map((h) => Number((h as { rooms?: number }).rooms ?? 0))),
  peakCcu: Math.max(0, ...health.map((h) => Number((h as { ccu?: number }).ccu ?? 0))),
  loopP99MsWorst: Math.max(0, ...loads.map((l) => l.loopP99Ms)),
  loopMaxMsWorst: Math.max(0, ...loads.map((l) => l.loopMaxMs)),
  rssMbPeak: Math.max(0, ...loads.map((l) => l.rssMb)),
  queueMsP50: pct(ok.map((m) => m.queueMs ?? 0), 50),
  queueMsP95: pct(ok.map((m) => m.queueMs ?? 0), 95),
  rttP50: pct(ok.map((m) => m.rtt ?? 0), 50),
  rttP95: pct(ok.map((m) => m.rtt ?? 0), 95),
  snapsTotal: ok.reduce((a, m) => a + (m.snaps ?? 0), 0),
  desyncsTotal: ok.reduce((a, m) => a + (m.desyncs ?? 0), 0),
  maxRollbackDepth: Math.max(0, ...ok.map((m) => m.maxDepth ?? 0)),
};
mkdirSync(resolve(here, "results"), { recursive: true });
const file = resolve(here, "results", `loadtest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ summary, health }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log("report:", file);
