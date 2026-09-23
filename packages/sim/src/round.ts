import { enter } from "./fighter";
import type { Rules } from "./rules";
import { resetRound } from "./state";
import { Phase, Reason, St, type MatchState, type ReasonId } from "./types";

/** End the round. winner: 0 = P1, 1 = P2, 2 = draw. Wins count immediately. */
export function endRound(s: MatchState, winner: 0 | 1 | 2, reason: ReasonId, R: Rules): void {
  s.phase = Phase.roundEnd;
  s.phaseT = R.match.roundEnd;
  s.roundWinner = winner;
  s.reason = reason;
  s.sd = 0;
  if (winner === 0) s.w1 += 1;
  else if (winner === 1) s.w2 += 1;
  if (winner === 0 || winner === 1) {
    const w = s.f[winner];
    if (w.st !== St.ko && w.st !== St.ringOut) {
      enter(w, St.win);
      // A ring-out push or launch still carrying the winner (a trade, or the
      // timer running out mid-shove) stops at the wall: winners stay in the pit.
      w.roAble = 0;
    }
  }
}

function timeout(s: MatchState, R: Rules): void {
  const h0 = s.f[0].hp;
  const h1 = s.f[1].hp;
  if (s.sd) {
    endRound(s, 2, Reason.sdExpired, R);
  } else if (h0 !== h1) {
    endRound(s, h0 > h1 ? 0 : 1, Reason.timeout, R);
  } else {
    s.sd = 1;
    s.timer = R.match.suddenDeath;
  }
}

function endMatch(s: MatchState): void {
  s.phase = Phase.matchEnd;
  s.phaseT = 0;
  s.matchWinner = s.w1 > s.w2 ? 0 : s.w2 > s.w1 ? 1 : 2;
}

/** Advance the round clock / phase machine by one tick. */
export function tickClock(s: MatchState, R: Rules): void {
  switch (s.phase) {
    case Phase.countdown:
      s.phaseT -= 1;
      if (s.phaseT <= 0) {
        s.phase = Phase.fighting;
        s.phaseT = 0;
        s.f[0].bufS = 0;
        s.f[1].bufS = 0;
      }
      break;
    case Phase.fighting:
      s.timer -= 1;
      if (s.timer <= 0) {
        s.timer = 0;
        timeout(s, R);
      }
      break;
    case Phase.roundEnd:
      s.phaseT -= 1;
      if (s.phaseT <= 0) {
        const done = s.w1 >= R.match.winsNeeded || s.w2 >= R.match.winsNeeded || s.round >= R.match.maxRounds;
        if (done) endMatch(s);
        else resetRound(s, R);
      }
      break;
    default:
      break;
  }
}
