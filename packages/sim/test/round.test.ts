import { describe, expect, it } from "vitest";
import { Phase, RULES, Reason, createMatch, step, type MatchState } from "../src/index";
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
