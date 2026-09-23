import type { FighterState, MatchState } from "./types";
import { hashInts } from "./hash";

/** Hash / wire layout. Order is part of the format: append new fields at the end. */
export const MATCH_FIELDS = [
  "v",
  "tick",
  "phase",
  "phaseT",
  "timer",
  "sd",
  "round",
  "w1",
  "w2",
  "roundWinner",
  "reason",
  "matchWinner",
  "rng",
] as const satisfies readonly (keyof MatchState)[];

export const FIGHTER_FIELDS = [
  "x",
  "y",
  "vx",
  "vy",
  "facing",
  "grounded",
  "hp",
  "heat",
  "st",
  "stTick",
  "move",
  "hitstop",
  "stun",
  "invuln",
  "hitDone",
  "diveUsed",
  "roAble",
  "slideV",
  "slideRem",
  "held",
  "tapL",
  "tapR",
  "bufS",
  "dashReq",
  "hitT",
  "hitMv",
  "hitKind",
] as const satisfies readonly (keyof FighterState)[];

export const STATE_INTS = MATCH_FIELDS.length + 2 * FIGHTER_FIELDS.length;

type NumRecord = Record<string, number>;

export function serialize(s: MatchState, out: Int32Array = new Int32Array(STATE_INTS)): Int32Array {
  let k = 0;
  const m = s as unknown as NumRecord;
  for (const name of MATCH_FIELDS) out[k++] = (m[name] as number) | 0;
  for (const f of s.f) {
    const r = f as unknown as NumRecord;
    for (const name of FIGHTER_FIELDS) out[k++] = (r[name] as number) | 0;
  }
  return out;
}

export function deserialize(a: ArrayLike<number>): MatchState {
  if (a.length !== STATE_INTS) throw new Error(`deserialize: expected ${STATE_INTS} ints, got ${a.length}`);
  let k = 0;
  const m: NumRecord = {};
  for (const name of MATCH_FIELDS) m[name] = a[k++] as number;
  m.rng = (m.rng as number) >>> 0;
  const fs: NumRecord[] = [{}, {}];
  for (const f of fs) for (const name of FIGHTER_FIELDS) f[name] = a[k++] as number;
  return { ...(m as unknown as MatchState), f: [fs[0] as unknown as FighterState, fs[1] as unknown as FighterState] };
}

const scratch = new Int32Array(STATE_INTS);

/** FNV-1a-64 of the serialized state, 16 hex chars. */
export function stateHash(s: MatchState): string {
  return hashInts(serialize(s, scratch));
}
