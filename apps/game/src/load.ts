/**
 * Server load, reported on /health: how late the event loop runs (every fight
 * room steps its sim on it, so a busy machine shows up here first), memory,
 * and connected clients. The load test (tools/loadtest) reads it; so can an
 * uptime monitor.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** Sampling period. The histogram measures time between samples, so the period itself is subtracted. */
const RES_MS = 10;
let hist: IntervalHistogram | null = null;
let since = Date.now();

export interface LoadSample {
  /** Event-loop delay (how late a timer fires) over the window since the last sample, in ms. */
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
  rssMb: number;
  windowS: number;
}

/** Read and reset the window. The first call starts the monitor. */
export function loadSample(): LoadSample {
  if (!hist) {
    hist = monitorEventLoopDelay({ resolution: RES_MS });
    hist.enable();
  }
  const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - RES_MS) * 10) / 10);
  const now = Date.now();
  const s: LoadSample = {
    loopP50Ms: hist.count ? ms(hist.percentile(50)) : 0,
    loopP99Ms: hist.count ? ms(hist.percentile(99)) : 0,
    loopMaxMs: hist.count ? ms(hist.max) : 0,
    rssMb: Math.round(process.memoryUsage.rss() / 1e6),
    windowS: Math.round((now - since) / 100) / 10,
  };
  hist.reset();
  since = now;
  return s;
}
