import { RULES, createMatch, step, Phase, type MatchState, type Rules } from "../../src/index";

/** A match already in the fighting phase (countdown skipped by stepping). */
export function fightingMatch(id = "test", R: Rules = RULES): MatchState {
  let s = createMatch({ matchId: id }, R);
  while (s.phase !== Phase.fighting) s = step(s, 0, 0, R);
  return s;
}

/** Step n ticks with constant inputs. */
export function run(s: MatchState, n: number, b1 = 0, b2 = 0, R: Rules = RULES): MatchState {
  for (let i = 0; i < n; i++) s = step(s, b1, b2, R);
  return s;
}

/** Step with per-tick input functions. */
export function runFn(s: MatchState, n: number, f1: (i: number) => number, f2: (i: number) => number = () => 0, R: Rules = RULES): MatchState {
  for (let i = 0; i < n; i++) s = step(s, f1(i), f2(i), R);
  return s;
}
