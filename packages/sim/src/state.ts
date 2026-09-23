import { RULES, type Rules } from "./rules";
import { seedFromId } from "./rng";
import { Mv, Phase, Reason, St, type FighterState, type MatchInit, type MatchState } from "./types";

export function newFighter(side: 0 | 1, R: Rules = RULES): FighterState {
  return {
    x: side === 0 ? -R.match.startX : R.match.startX,
    y: 0,
    vx: 0,
    vy: 0,
    facing: side === 0 ? 1 : -1,
    grounded: 1,
    hp: R.fighter.hpMax,
    heat: 0,
    st: St.idle,
    stTick: 0,
    move: Mv.none,
    hitstop: 0,
    stun: 0,
    invuln: 0,
    hitDone: 0,
    diveUsed: 0,
    roAble: 0,
    slideV: 0,
    slideRem: 0,
    held: 0,
    tapL: 255,
    tapR: 255,
    bufS: 0,
    dashReq: 0,
    hitT: -1,
    hitMv: Mv.none,
    hitKind: 0,
    rawHeld: 0,
    bufDir: 0,
    hitX: 0,
  };
}

export function createMatch(init: MatchInit, R: Rules = RULES): MatchState {
  return {
    v: 1,
    tick: 0,
    phase: Phase.countdown,
    phaseT: R.match.countdown,
    timer: R.match.round,
    sd: 0,
    round: 1,
    w1: 0,
    w2: 0,
    roundWinner: -1,
    reason: Reason.none,
    matchWinner: -1,
    rng: seedFromId(init.matchId),
    f: [newFighter(0, R), newFighter(1, R)],
  };
}

/** Start the next round in place: fresh fighters, new countdown. */
export function resetRound(s: MatchState, R: Rules = RULES): void {
  s.f = [newFighter(0, R), newFighter(1, R)];
  s.phase = Phase.countdown;
  s.phaseT = R.match.countdown;
  s.timer = R.match.round;
  s.sd = 0;
  s.round += 1;
  s.roundWinner = -1;
  s.reason = Reason.none;
}

/** Every field is a primitive, so a shallow copy per level is a deep copy. */
export function clone(s: MatchState): MatchState {
  return { ...s, f: [{ ...s.f[0] }, { ...s.f[1] }] };
}
