/** Protocol and product constants shared by web, game and worker. */
export const TICK_RATE = 60;
export const SNAPSHOT_HZ = 20;
/** Server-side input delay applied to both players (ticks). */
export const INPUT_DELAY = 2;
/** Per-player server input buffer (ticks). */
export const INPUT_BUFFER = 6;
/** Inputs older than this are dropped and count toward the jitter score (ticks). */
export const INPUT_MAX_AGE = 30;
/** Disconnect grace before forfeit (seconds). */
export const RECONNECT_GRACE_S = 10;

export const DEFAULT_PORTS = { web: 3000, game: 2567, worker: 8080 } as const;

/** Cosmetic holding tiers (USD value of $COCK held). Cosmetics only, never stats. */
export const TIERS = [
  { id: "rust", minUsd: 30 },
  { id: "chrome", minUsd: 250 },
  { id: "gold", minUsd: 1000 },
  { id: "diamond", minUsd: 5000 },
] as const;
export type Tier = (typeof TIERS)[number]["id"];
export const TIER_IDS: readonly Tier[] = TIERS.map((t) => t.id);

/** Highest tier whose threshold `usd` meets, or null below the entry gate. */
export function tierForUsd(usd: number): Tier | null {
  let best: Tier | null = null;
  for (const t of TIERS) if (usd >= t.minUsd) best = t.id;
  return best;
}
