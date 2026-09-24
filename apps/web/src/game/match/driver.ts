import type { MatchState, SimEvent } from "@cockfight/sim";

/**
 * What the fight engine needs from a match: the last two shown states (the
 * renderer blends between them) and the presentation events of the latest
 * tick. LocalMatch runs the sim in the browser; OnlineMatch shows the
 * prediction of an online match.
 */
export interface MatchDriver {
  readonly prev: MatchState;
  readonly cur: MatchState;
  readonly events: SimEvent[];
  /** Advance one 60 Hz loop tick; returns this tick's events. */
  tick(): SimEvent[];
}
