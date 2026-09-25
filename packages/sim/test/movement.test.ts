import { describe, expect, it } from "vitest";
import { B, RULES, St, cleanButtons, createMatch, step } from "../src/index";
import { fightingMatch, run } from "./helpers/run";

const F = RULES.fighter;

describe("inputs", () => {
  it("SOCD: opposite directions cancel", () => {
    expect(cleanButtons(B.L | B.R)).toBe(0);
    expect(cleanButtons(B.U | B.D | B.S)).toBe(B.S);
    expect(cleanButtons(B.L | B.U)).toBe(B.L | B.U);
  });
  it("inputs are ignored during the countdown", () => {
    let s = createMatch({ matchId: "m" });
    s = run(s, 60, B.R, B.L);
    expect(s.f[0].x).toBe(-RULES.match.startX);
    expect(s.f[1].x).toBe(RULES.match.startX);
  });
  it("a direction held through the countdown becomes a press on the first live tick", () => {
    let s = createMatch({ matchId: "m" });
    s = run(s, RULES.match.countdown, B.R, 0);
    s = step(s, B.R, 0);
    expect(s.f[0].tapR).toBe(0);
  });
  it("double tap within 12 ticks requests a dash; 13 does not; triple tap = one dash", () => {
    const dashAt = (gap: number) => {
      let s = fightingMatch();
      let seen = 0;
      for (let i = 0; i < gap + 2; i++) {
        s = step(s, i === 0 || i === gap ? B.R : 0, 0);
        if (s.f[0].dashReq === 1) seen++;
      }
      return seen;
    };
    expect(dashAt(12)).toBe(1);
    expect(dashAt(13)).toBe(0);
    let s = fightingMatch();
    let dashes = 0;
    for (let i = 0; i < 20; i++) {
      s = step(s, i === 0 || i === 4 || i === 8 ? B.R : 0, 0);
      if (s.f[0].dashReq) dashes++;
    }
    expect(dashes).toBe(1);
  });
});

describe("walking", () => {
  it("walks forward and back at the listed speeds", () => {
    let s = fightingMatch();
    const x0 = s.f[0].x;
    s = run(s, 10, B.R, 0);
    expect(s.f[0].x - x0).toBe(10 * F.walkFwd);
    expect(s.f[0].st).toBe(St.walkF);
    const x1 = s.f[0].x;
    s = run(s, 10, B.L, 0);
    expect(s.f[0].x - x1).toBe(-10 * F.walkBack);
    expect(s.f[0].st).toBe(St.walkB);
  });
  it("cannot walk past the wall", () => {
    let s = fightingMatch();
    s = run(s, 600, B.L, B.R);
    expect(s.f[0].x).toBe(-RULES.match.wallEdge);
    expect(s.f[1].x).toBe(RULES.match.wallEdge);
  });
  it("cannot walk through the opponent, and the push is symmetric", () => {
    let s = fightingMatch();
    s = run(s, 200, B.R, B.L);
    const gap = s.f[1].x - s.f[0].x;
    expect(gap).toBeGreaterThanOrEqual(2 * F.pushHalfW);
    expect(s.f[0].x).toBe(-s.f[1].x);
  });
  it("one fighter pushes the other when only one walks", () => {
    let s = fightingMatch();
    s = run(s, 200, B.R, 0);
    expect(s.f[1].x - s.f[0].x).toBeGreaterThanOrEqual(2 * F.pushHalfW - 1);
    expect(s.f[1].x).toBeGreaterThan(RULES.match.startX);
  });
  it("pinned at the wall, the walker takes the whole push", () => {
    let s = fightingMatch();
    s = run(s, 600, B.R, B.R); // both walk right: P2 walks back into the wall, P1 follows
    expect(s.f[1].x).toBe(RULES.match.wallEdge);
    expect(s.f[1].x - s.f[0].x).toBeGreaterThanOrEqual(2 * F.pushHalfW);
  });
});
