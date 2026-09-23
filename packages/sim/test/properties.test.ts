import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  B, FIGHTER_FIELDS, MATCH_FIELDS, Phase, RULES, Rng, St, createMatch, serialize, stateHash, step,
  type FighterState, type MatchState,
} from "../src/index";
import { deepFreeze } from "./helpers/freeze";

const SOAK = process.env.SOAK === "1";
const RUNS = SOAK ? 200 : 40;
const MAX_TICKS = SOAK ? 30000 : 6000;

/** Random held inputs: each player holds a random mask for 1..30 ticks. */
function inputs(seed: number, ticks: number): [Uint8Array, Uint8Array] {
  const out: [Uint8Array, Uint8Array] = [new Uint8Array(ticks), new Uint8Array(ticks)];
  for (let p = 0; p < 2; p++) {
    const rng = new Rng(seed * 2 + p + 1);
    let t = 0;
    while (t < ticks) {
      const b = rng.int(32);
      const hold = 1 + rng.int(30);
      for (let k = 0; k < hold && t < ticks; k++, t++) (out[p] as Uint8Array)[t] = b;
    }
  }
  return out;
}

function runAll(i1: Uint8Array, i2: Uint8Array, id = "prop"): MatchState[] {
  const states: MatchState[] = [];
  let s = createMatch({ matchId: id });
  for (let t = 0; t < i1.length; t++) {
    s = step(s, i1[t] as number, i2[t] as number);
    states.push(s);
    if (s.phase === Phase.matchEnd) break;
  }
  return states;
}

const swapLR = (b: number) => (b & ~(B.L | B.R)) | (b & B.L ? B.R : 0) | (b & B.R ? B.L : 0);

function mirrorFighter(f: FighterState): FighterState {
  return {
    ...f,
    x: -f.x || 0,
    vx: -f.vx || 0,
    facing: -f.facing,
    slideV: -f.slideV || 0,
    held: swapLR(f.held),
    tapL: f.tapR,
    tapR: f.tapL,
    dashReq: -f.dashReq || 0,
    rawHeld: swapLR(f.rawHeld),
    bufDir: swapLR(f.bufDir),
    hitX: -f.hitX || 0,
  };
}
const swapSide = (w: number) => (w === 0 ? 1 : w === 1 ? 0 : w);
function mirror(s: MatchState): MatchState {
  return {
    ...s,
    w1: s.w2,
    w2: s.w1,
    roundWinner: swapSide(s.roundWinner),
    matchWinner: swapSide(s.matchWinner),
    f: [mirrorFighter(s.f[1]), mirrorFighter(s.f[0])],
  };
}

const seedAndTicks = fc.tuple(fc.integer({ min: 1, max: 0x7fffffff }), fc.integer({ min: 200, max: MAX_TICKS }));

describe("sim properties (fast-check)", () => {
  it("every field stays an in-range integer; no NaN, no -0", () => {
    fc.assert(
      fc.property(seedAndTicks, ([seed, ticks]) => {
        const [a, b] = inputs(seed, ticks);
        for (const s of runAll(a, b)) {
          for (const k of MATCH_FIELDS) {
            const v = s[k] as number;
            if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error(`${k}=${v} at tick ${s.tick}`);
          }
          for (const f of s.f) {
            for (const k of FIGHTER_FIELDS) {
              const v = f[k] as number;
              if (!Number.isSafeInteger(v) || Object.is(v, -0) || Math.abs(v) > 0x7fffffff) {
                throw new Error(`fighter.${k}=${v} at tick ${s.tick}`);
              }
            }
            if (f.hp < 0 || f.hp > RULES.fighter.hpMax) throw new Error(`hp out of range ${f.hp}`);
            if (f.heat < 0 || f.heat > RULES.heat.max) throw new Error(`heat out of range ${f.heat}`);
            if (f.y < RULES.match.ringOutFloor) throw new Error(`y below floor ${f.y}`);
            // Beyond the ring edge mid-round means a ring-out, nothing else.
            if (s.phase === Phase.fighting && f.st !== St.ringOut && Math.abs(f.x) > RULES.match.ringEdge) {
              throw new Error(`x beyond ring ${f.x} in state ${f.st} at tick ${s.tick}`);
            }
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("is deterministic and pure (same inputs -> same hash every tick; prev never mutated)", () => {
    fc.assert(
      fc.property(seedAndTicks, ([seed, ticks]) => {
        const [a, b] = inputs(seed, Math.min(ticks, 3000));
        let s = createMatch({ matchId: "pure" });
        let s2 = createMatch({ matchId: "pure" });
        for (let t = 0; t < a.length; t++) {
          const before = stateHash(s);
          const frozen = deepFreeze(s);
          const next = step(frozen, a[t] as number, b[t] as number);
          if (stateHash(frozen) !== before) throw new Error("prev mutated");
          s2 = step(s2, a[t] as number, b[t] as number);
          if (stateHash(next) !== stateHash(s2)) throw new Error(`diverged at ${t}`);
          s = next;
        }
      }),
      { numRuns: Math.max(10, RUNS >> 2) },
    );
  });

  it("rewinding to tick k and replaying reproduces the same states (reconciliation)", () => {
    fc.assert(
      fc.property(seedAndTicks, fc.integer({ min: 0, max: 100 }), ([seed, ticks], pct) => {
        const [a, b] = inputs(seed, ticks);
        const states = runAll(a, b);
        const k = Math.floor(((states.length - 1) * pct) / 100);
        let s = states[k] as MatchState;
        for (let t = k + 1; t < states.length; t++) {
          s = step(s, a[t] as number, b[t] as number);
          if (stateHash(s) !== stateHash(states[t] as MatchState)) throw new Error(`rewind from ${k} diverged at ${t}`);
        }
      }),
      { numRuns: Math.max(10, RUNS >> 2) },
    );
  });

  it("is mirror-symmetric: swapping the players and L/R mirrors the whole match", () => {
    fc.assert(
      fc.property(seedAndTicks, ([seed, ticks]) => {
        const [a, b] = inputs(seed, ticks);
        const ma = Uint8Array.from(b, swapLR);
        const mb = Uint8Array.from(a, swapLR);
        const orig = runAll(a, b);
        const mirr = runAll(ma, mb);
        expect(mirr.length).toBe(orig.length);
        for (let t = 0; t < orig.length; t++) {
          const want = serialize(mirror(orig[t] as MatchState));
          const got = serialize(mirr[t] as MatchState);
          if (want.join() !== got.join()) throw new Error(`asymmetry at tick ${t + 1}`);
        }
      }),
      { numRuns: Math.max(10, RUNS >> 1) },
    );
  });

  it("every match ends within 5 x 5700 ticks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x7fffffff }), (seed) => {
        const [a, b] = inputs(seed, 28500);
        const states = runAll(a, b);
        expect((states[states.length - 1] as MatchState).phase).toBe(Phase.matchEnd);
      }),
      { numRuns: SOAK ? 50 : 5 },
    );
  });
});
