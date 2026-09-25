import {
  RULES, clone, compressInputs, createMatch, deriveEvents, step, type MatchState, type Replay, type Rules, type SimEvent,
} from "@cockfight/sim";
import type { MatchDriver } from "./driver";
import type { InputSource } from "./input/source";

/**
 * A match played entirely in this browser (vs CPU or two players on one
 * keyboard). Owns the sim state, feeds it inputs one tick at a time, records
 * the input log (for replays) and derives presentation events.
 */
export class LocalMatch implements MatchDriver {
  prev: MatchState;
  cur: MatchState;
  /** Events produced by the most recent tick. */
  events: SimEvent[] = [];
  private readonly log: [number[], number[]] = [[], []];
  readonly matchId: string;
  private readonly sources: [InputSource, InputSource];
  private readonly R: Rules;

  constructor(matchId: string, sources: [InputSource, InputSource], R: Rules = RULES) {
    this.matchId = matchId;
    this.sources = sources;
    this.R = R;
    this.cur = createMatch({ matchId }, R);
    this.prev = clone(this.cur);
  }

  tick(): SimEvent[] {
    const b1 = this.sources[0].sample(this.cur, 0);
    const b2 = this.sources[1].sample(this.cur, 1);
    this.log[0].push(b1);
    this.log[1].push(b2);
    this.prev = this.cur;
    this.cur = step(this.cur, b1, b2, this.R);
    this.events = deriveEvents(this.prev, this.cur, this.R.heat.max);
    return this.events;
  }

  /** The input log as a replay (hash filled by the caller if needed). */
  toReplay(finalHash = ""): Replay {
    return {
      v: 1,
      rulesHash: this.R.hash,
      matchId: this.matchId,
      ticks: this.log[0].length,
      p1: compressInputs(this.log[0]),
      p2: compressInputs(this.log[1]),
      finalHash,
    };
  }
}
