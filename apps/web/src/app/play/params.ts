import type { CpuLevel } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import type { PlayParams } from "./PlayClient";

const pick = <T extends string>(v: string | null | undefined, allowed: readonly T[], d: T): T =>
  allowed.includes(v as T) ? (v as T) : d;

/**
 * /play's URL options, parsed in the browser so the page itself is static
 * (it can be served from any static host, e.g. a Netlify test build).
 */
export function parsePlayParams(get: (key: string) => string | null | undefined): PlayParams {
  const mode = get("mode");
  const bench = get("bench") === "1";
  return {
    mode: mode === "cpu" || mode === "2p" || mode === "demo" || mode === "online" ? mode : bench ? "demo" : null,
    wallet: get("wallet")?.trim() || null,
    difficulty: pick<CpuLevel>(get("difficulty"), ["easy", "normal", "hard"], "normal"),
    tier: pick<Tier>(get("tier"), ["rust", "chrome", "gold", "diamond"], "rust"),
    seed: get("seed") || (bench ? "bench" : null),
    manual: get("manual") === "1",
    debug: get("debug") === "1",
    fps: get("fps") === "1" || bench,
    bench,
    quality: (["high", "medium", "low"] as const).find((q) => q === get("quality")) ?? null,
    arena: get("arena") !== "0",
    touch: get("touch") === "1" ? true : get("touch") === "0" ? false : null,
    idleCpu: get("debug") === "1" && get("cpu") === "idle",
  };
}
