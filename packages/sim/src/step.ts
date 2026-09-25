import { applyHits, checkFinish, decayHeat, detect } from "./combat";
import { updateFighter } from "./fighter";
import { readInput } from "./input";
import { faceOpponents, integrate, resolvePush } from "./physics";
import { tickClock } from "./round";
import { RULES, type Rules } from "./rules";
import { clone } from "./state";
import { Phase, type FighterState, type MatchState } from "./types";

/**
 * Advance the match one tick (1/60 s). Pure: `prev` is never mutated and the
 * result shares no objects with it, so callers may keep a history of states
 * for rollback and replays.
 *
 * Order: inputs -> hit-stop -> fighter transitions/actions -> movement ->
 * push separation -> facing -> hits (both directions detected, then applied)
 * -> ring-out / KO -> heat decay -> round clock.
 */
export function step(prev: MatchState, b1: number, b2: number, R: Rules = RULES): MatchState {
  const s = clone(prev);
  s.tick += 1;
  if (s.phase === Phase.matchEnd) return s;
  const live = s.phase === Phase.fighting;
  const f0 = s.f[0];
  const f1 = s.f[1];

  // Hit-stop freezes a fighter completely (edges are still read, the buffer holds).
  const frozen0 = f0.hitstop > 0;
  const frozen1 = f1.hitstop > 0;
  readInput(f0, live ? b1 : 0, frozen0, R);
  readInput(f1, live ? b2 : 0, frozen1, R);

  advance(f0, frozen0, live, R);
  advance(f1, frozen1, live, R);
  resolvePush(s, R);
  faceOpponents(s);

  if (live) {
    const hits: [boolean, boolean] = [detect(f0, f1, frozen0, R), detect(f1, f0, frozen1, R)];
    if (hits[0] || hits[1]) applyHits(s, hits, R);
    checkFinish(s, R);
  }
  if (s.phase === Phase.fighting) {
    decayHeat(s, R);
    tickClock(s, R);
  } else if (!live) {
    tickClock(s, R);
  }
  // A round that ended by KO / ring-out this tick starts its 120-tick clock next tick,
  // exactly like a timeout.
  return s;
}

function advance(f: FighterState, frozen: boolean, live: boolean, R: Rules): void {
  if (frozen) {
    f.hitstop -= 1;
    return;
  }
  updateFighter(f, live, R);
  integrate(f, R);
}
