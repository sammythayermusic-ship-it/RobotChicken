import type { Metadata } from "next";
import type { CpuLevel } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import PlayClient, { type PlayParams } from "./PlayClient";

export const metadata: Metadata = { title: "Fight · COCKFIGHT" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pick = <T extends string>(v: string | undefined, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);

export default async function PlayPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const mode = one(sp.mode);
  const params: PlayParams = {
    mode: mode === "cpu" || mode === "2p" || mode === "demo" ? mode : one(sp.bench) === "1" ? "demo" : null,
    difficulty: pick<CpuLevel>(one(sp.difficulty), ["easy", "normal", "hard"], "normal"),
    tier: pick<Tier>(one(sp.tier), ["rust", "chrome", "gold", "diamond"], "rust"),
    seed: one(sp.seed) ?? (one(sp.bench) === "1" ? "bench" : null),
    manual: one(sp.manual) === "1",
    debug: one(sp.debug) === "1",
    fps: one(sp.fps) === "1" || one(sp.bench) === "1",
    bench: one(sp.bench) === "1",
    quality: (["high", "medium", "low"] as const).find((q) => q === one(sp.quality)) ?? null,
    arena: one(sp.arena) !== "0",
  };
  return <PlayClient params={params} />;
}
