import type { MatchState, SimEvent } from "@cockfight/sim";
import type { NetSession } from "../net/session";
import type { MatchDriver } from "./driver";

/**
 * An online match as the engine sees it: the session's prediction (with its
 * correction blending) is what gets drawn, and this player's buttons are
 * sampled once per predicted tick.
 */
export class OnlineMatch implements MatchDriver {
  readonly net: NetSession;
  private readonly sample: (s: MatchState, side: 0 | 1) => number;

  constructor(net: NetSession, sample: (s: MatchState, side: 0 | 1) => number) {
    this.net = net;
    this.sample = sample;
  }

  get prev(): MatchState {
    return this.net.pred.prev;
  }

  get cur(): MatchState {
    return this.net.pred.cur;
  }

  get events(): SimEvent[] {
    return this.net.pred.events;
  }

  get side(): 0 | 1 {
    return this.net.side;
  }

  tick(): SimEvent[] {
    this.net.tick((s) => this.sample(s, this.net.side));
    return this.net.pred.events;
  }
}
