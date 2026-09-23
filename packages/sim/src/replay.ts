import { Rng } from "./rng";
import { RULES, type Rules } from "./rules";
import { stateHash } from "./serialize";
import { createMatch } from "./state";
import { step } from "./step";
import { BUTTON_MASK, Phase, type MatchState } from "./types";

/** Input change event: buttons `b` apply from step `t` (1-based tick) until the next event. */
export interface InputEvent {
  t: number;
  b: number;
}

/** Seeded random inputs: each player holds a random mask for hold[0]..hold[1] ticks. */
export interface InputGen {
  kind: "xorshift";
  seed: number;
  hold: [number, number];
}

export interface Replay {
  v: 1;
  name?: string;
  rulesHash: string;
  matchId: string;
  /** Number of steps to run. */
  ticks: number;
  p1?: InputEvent[];
  p2?: InputEvent[];
  gen?: InputGen;
  finalHash: string;
  /** [tick, hash] checkpoints, every 60 ticks by default. */
  cp?: [number, string][];
}

export interface ReplayResult {
  state: MatchState;
  hash: string;
  ticks: number;
  cps: [number, string][];
}

/** Expand change events into one button mask per step (index 0 = step 1). */
export function expandInputs(events: readonly InputEvent[] | undefined, ticks: number): Uint8Array {
  const out = new Uint8Array(ticks);
  if (!events) return out;
  let cur = 0;
  let k = 0;
  for (let t = 1; t <= ticks; t++) {
    while (k < events.length && (events[k] as InputEvent).t <= t) {
      cur = (events[k] as InputEvent).b & BUTTON_MASK;
      k++;
    }
    out[t - 1] = cur;
  }
  return out;
}

/** Generate the two players' input events for a seeded random replay. */
export function generateInputs(gen: InputGen, ticks: number): [InputEvent[], InputEvent[]] {
  const out: [InputEvent[], InputEvent[]] = [[], []];
  for (let p = 0; p < 2; p++) {
    const rng = new Rng((gen.seed ^ (p === 0 ? 0x2545f491 : 0x6c8e9cf5)) >>> 0);
    const span = gen.hold[1] - gen.hold[0] + 1;
    let t = 1;
    while (t <= ticks) {
      const b = rng.int(BUTTON_MASK + 1);
      (out[p] as InputEvent[]).push({ t, b });
      t += gen.hold[0] + rng.int(span);
    }
  }
  return out;
}

/** Compress per-step masks back into change events. */
export function compressInputs(masks: ArrayLike<number>): InputEvent[] {
  const ev: InputEvent[] = [];
  let prev = -1;
  for (let i = 0; i < masks.length; i++) {
    const b = (masks[i] as number) & BUTTON_MASK;
    if (b !== prev) {
      ev.push({ t: i + 1, b });
      prev = b;
    }
  }
  return ev;
}

export function replayInputs(r: Replay): [Uint8Array, Uint8Array] {
  if (r.gen) {
    const [a, b] = generateInputs(r.gen, r.ticks);
    return [expandInputs(a, r.ticks), expandInputs(b, r.ticks)];
  }
  return [expandInputs(r.p1, r.ticks), expandInputs(r.p2, r.ticks)];
}

/**
 * Run a replay from a fresh match. Throws if the replay was recorded against
 * different rules. Stops early at matchEnd.
 */
export function runReplay(r: Replay, R: Rules = RULES, opts: { every?: number; allowRulesMismatch?: boolean } = {}): ReplayResult {
  if (!opts.allowRulesMismatch && r.rulesHash !== R.hash) {
    throw new Error(`replay ${r.name ?? r.matchId}: rulesHash ${r.rulesHash} != current ${R.hash} (re-bless if the change is intended)`);
  }
  const every = opts.every ?? 60;
  const [i1, i2] = replayInputs(r);
  let s = createMatch({ matchId: r.matchId }, R);
  const cps: [number, string][] = [];
  let t = 0;
  for (; t < r.ticks; t++) {
    s = step(s, i1[t] as number, i2[t] as number, R);
    if (every > 0 && s.tick % every === 0) cps.push([s.tick, stateHash(s)]);
    if (s.phase === Phase.matchEnd) {
      t++;
      break;
    }
  }
  return { state: s, hash: stateHash(s), ticks: t, cps };
}
