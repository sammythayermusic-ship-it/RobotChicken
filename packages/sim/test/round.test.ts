import { describe, expect, it } from "vitest";
import { B, Mv, Phase, RULES, Reason, St, createMatch, step, type MatchState } from "../src/index";
import { run } from "./helpers/run";

const M = RULES.match;

function stepUntil(s: MatchState, pred: (s: MatchState) => boolean, max = 100000): MatchState {
  for (let i = 0; i < max && !pred(s); i++) s = step(s, 0, 0);
  return s;
}

describe("round machine", () => {
  it("counts down exactly 180 ticks, fights for exactly 3600", () => {
    let s = createMatch({ matchId: "r" });
    s = run(s, M.countdown - 1);
    expect(s.phase).toBe(Phase.countdown);
    s = step(s, 0, 0);
    expect(s.phase).toBe(Phase.fighting);
    expect(s.tick).toBe(M.countdown);
    expect(s.timer).toBe(M.round);
    s = run(s, M.round - 1);
    expect(s.phase).toBe(Phase.fighting);
    expect(s.timer).toBe(1);
    s = step(s, 0, 0);
    // equal HP at timeout -> sudden death, not round end
    expect(s.phase).toBe(Phase.fighting);
    expect(s.sd).toBe(1);
    expect(s.timer).toBe(M.suddenDeath);
  });

  it("sudden death expiry is a draw; roundEnd lasts 120 ticks", () => {
    let s = stepUntil(createMatch({ matchId: "r" }), (x) => x.phase === Phase.roundEnd);
    expect(s.reason).toBe(Reason.sdExpired);
    expect(s.roundWinner).toBe(2);
    expect(s.tick).toBe(M.countdown + M.round + M.suddenDeath);
    const endTick = s.tick;
    s = stepUntil(s, (x) => x.phase !== Phase.roundEnd);
    expect(s.tick - endTick).toBe(M.roundEnd);
    expect(s.phase).toBe(Phase.countdown);
    expect(s.round).toBe(2);
  });

  it("timeout with unequal HP awards the round to the healthier fighter", () => {
    let s = createMatch({ matchId: "r" });
    s.f[1].hp -= 1;
    s = stepUntil(s, (x) => x.phase === Phase.roundEnd);
    expect(s.reason).toBe(Reason.timeout);
    expect(s.roundWinner).toBe(0);
    expect(s.w1).toBe(1);
  });

  it("ends after maxRounds of draws with a drawn match", () => {
    const s = stepUntil(createMatch({ matchId: "r" }), (x) => x.phase === Phase.matchEnd);
    expect(s.round).toBe(M.maxRounds);
    expect(s.matchWinner).toBe(2);
    expect(s.tick).toBe(M.maxRounds * (M.countdown + M.round + M.suddenDeath + M.roundEnd));
    const again = step(s, 31, 31);
    expect(again.phase).toBe(Phase.matchEnd);
  });

  it("a winner hit by a shove in a trade stays in the pit, in the win pose", () => {
    // P2 (left, facing right) shoves P1 toward the edge on the same tick P1's peck KOs P2.
    let s = createMatch({ matchId: "trade" });
    while (s.phase !== Phase.fighting) s = step(s, 0, 0);
    s.f[1].x = 7400;
    s.f[0].x = 8400;
    s.f[1].hp = 1;
    s = step(s, 0, 0); // both turn to face each other
    s = step(s, 0, B.R | B.S);
    expect(s.f[1].move).toBe(Mv.shove);
    s = run(s, 3);
    s = step(s, B.S, 0);
    s = stepUntil(s, (x) => x.phase !== Phase.fighting, 30);
    expect(s.reason).toBe(Reason.ko);
    expect(s.roundWinner).toBe(0);
    expect(s.f[0].hitKind).toBe(1); // the shove did land on the winner
    expect(s.f[0].st).toBe(St.win);
    expect(s.f[0].stTick).toBe(1);
    for (let t = 0; t < M.roundEnd - 1; t++) {
      s = step(s, 0, 0);
      expect(s.f[0].x).toBeLessThanOrEqual(M.wallEdge);
      expect(s.f[0].grounded).toBe(1);
      expect(s.f[0].st).toBe(St.win);
    }
  });

  it("two wins end the match", () => {
    let s = createMatch({ matchId: "r" });
    for (let r = 0; r < 2; r++) {
      s.f[1].hp = 1;
      s = stepUntil(s, (x) => x.phase === Phase.roundEnd);
      s = stepUntil(s, (x) => x.phase !== Phase.roundEnd);
    }
    expect(s.phase).toBe(Phase.matchEnd);
    expect(s.matchWinner).toBe(0);
    expect(s.w1).toBe(2);
  });
});
