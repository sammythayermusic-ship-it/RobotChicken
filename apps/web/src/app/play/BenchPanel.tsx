"use client";

import { useEffect, useState } from "react";
import type { FightEngine } from "@/game/engine/createFightEngine";
import type { PerfSnapshot } from "@/game/engine/perf";

/**
 * /play?bench=1: a fixed-seed CPU-vs-CPU match in real time. When it ends,
 * the frame-time percentiles are shown with a Copy button, so the numbers
 * from a real phone can be pasted into a PR or issue.
 */
export function BenchPanel({ engine, done }: { engine: FightEngine | null; done: boolean }) {
  const [result, setResult] = useState<PerfSnapshot | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!done || !engine) return;
    const id = setTimeout(() => setResult(engine.perf()), 0);
    return () => clearTimeout(id);
  }, [done, engine]);
  if (!result) {
    return (
      <div className="pointer-events-none absolute right-2 top-24 rounded bg-black/70 px-2 py-1 font-mono text-[11px] text-amber-300" data-testid="bench-running">
        BENCH RUNNING…
      </div>
    );
  }
  const text = [
    `COCKFIGHT bench · ${navigator.userAgent}`,
    `gpu: ${result.gpu}`,
    `tier ${result.tier} · dpr ${result.dpr.toFixed(2)} · ${result.frames} frames`,
    `fps ${result.fps.toFixed(1)} · p50 ${result.p50.toFixed(2)} ms · p95 ${result.p95.toFixed(2)} ms · p99 ${result.p99.toFixed(2)} ms`,
    `frames over budget: ${(result.over16 * 100).toFixed(1)}%`,
    `draw calls ${result.drawCalls} · triangles ${result.triangles} · programs ${result.programs}`,
  ].join("\n");
  return (
    <div className="absolute inset-x-4 top-24 mx-auto max-w-lg rounded-lg border border-zinc-600 bg-zinc-950/95 p-4 font-mono text-xs text-zinc-200" data-testid="bench-result">
      <pre className="whitespace-pre-wrap">{text}</pre>
      <button
        type="button"
        className="mt-3 rounded bg-amber-400 px-3 py-1 font-display text-black"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? "COPIED" : "COPY RESULTS"}
      </button>
    </div>
  );
}
