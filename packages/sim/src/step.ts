import { updateFighter } from "./fighter";
import { readInput } from "./input";
import { faceOpponents, integrate, resolvePush } from "./physics";
import { tickClock } from "./round";
import { RULES, type Rules } from "./rules";
import { clone } from "./state";
import { Phase, type MatchState } from "./types";

/**
 * Advance the match one tick (1/60 s). Pure: `prev` is never mutated and the
 * result shares no objects with it, so callers may keep a history of states.
 *
 * Order: inputs -> fighter transitions -> movement -> push separation ->
 * facing -> (Phase 1: hits, damage, ring-out/KO) -> heat -> round clock.
 */
export function step(prev: MatchState, b1: number, b2: number, R: Rules = RULES): MatchState {
  const s = clone(prev);
  s.tick += 1;
  if (s.phase === Phase.matchEnd) return s;
  const live = s.phase === Phase.fighting;
  const [f0, f1] = s.f;

  readInput(f0, live ? b1 : 0, f0.hitstop > 0, R);
  readInput(f1, live ? b2 : 0, f1.hitstop > 0, R);

  updateFighter(f0, live, R);
  updateFighter(f1, live, R);

  integrate(f0, R);
  integrate(f1, R);
  resolvePush(s, R);
  faceOpponents(s);

  tickClock(s, R);
  return s;
}
