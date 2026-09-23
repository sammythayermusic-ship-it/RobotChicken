import { describe, expect, it } from "vitest";
import { B, Mv, Phase, RULES, createMatch, deriveEvents, reasonLabel, step, type MatchState, type SimEvent } from "../src/index";

function run(ticks: number, b1: (s: MatchState) => number, b2: (s: MatchState) => number = () => 0) {
  let s = createMatch({ matchId: "events" });
  const out: { tick: number; e: SimEvent }[] = [];
  for (let t = 0; t < ticks; t++) {
    const next = step(s, b1(s), b2(s));
    for (const e of deriveEvents(s, next, RULES.heat.max)) out.push({ tick: next.tick, e });
    s = next;
  }
  return { s, out };
}

describe("deriveEvents", () => {
  it("counts down 3, 2, 1 then FIGHT on the first live tick", () => {
    const { out } = run(200, () => 0);
    const cd = out.filter((x) => x.e.kind === "countdown").map((x) => (x.e as { n: number }).n);
    expect(cd).toEqual([3, 2, 1]);
    const fight = out.find((x) => x.e.kind === "fight");
    expect(fight?.tick).toBe(RULES.match.countdown);
  });
  it("opens every round with ROUND n on its own, half a second before 3, 2, 1", () => {
    // Round 1 ends by a ring-out: P2 is shoved off from the edge.
    let s = createMatch({ matchId: "rounds" });
    const out: { tick: number; e: SimEvent }[] = [];
    let resetTick = -1;
    let endTick = -1;
    for (let t = 0; t < 700; t++) {
      if (s.phase === Phase.fighting && s.round === 1 && s.f[1].x < 8500) {
        s.f[1].x = 8500;
        s.f[0].x = 7300;
      }
      const shove = s.phase === Phase.fighting && s.round === 1 && s.f[0].st === 0 && s.f[1].hitKind === 0;
      const next = step(s, shove ? B.R | B.S : 0, 0);
      for (const e of deriveEvents(s, next, RULES.heat.max)) out.push({ tick: next.tick, e });
      if (next.phase === Phase.roundEnd && s.phase === Phase.fighting) endTick = next.tick;
      if (next.round === 2 && s.round === 1) resetTick = next.tick;
      s = next;
    }
    expect(out.find((x) => x.e.kind === "roundEnd")?.e).toMatchObject({ reason: 2 }); // ring-out
    const banners = out.filter((x) => x.e.kind === "roundStart" || x.e.kind === "countdown" || x.e.kind === "fight");
    const at = (tick0: number) =>
      banners.filter((x) => x.tick >= tick0 && x.tick <= tick0 + RULES.match.countdown).map((x) => [x.tick - tick0, x.e.kind === "countdown" ? x.e.n : x.e.kind]);
    // Round 1: the first step is tick 1. Later rounds: the reset tick itself starts the countdown.
    expect(at(0)).toEqual([[1, "roundStart"], [30, 3], [80, 2], [130, 1], [180, "fight"]]);
    expect(at(resetTick)).toEqual([[0, "roundStart"], [30, 3], [80, 2], [130, 1], [180, "fight"]]);
    // The reset replaced the fighters: nothing but the round banner on that tick, and no
    // "land" for the fighter who fell off the stage.
    expect(out.filter((x) => x.tick === resetTick).map((x) => x.e.kind)).toEqual(["roundStart"]);
    expect(out.filter((x) => x.tick > endTick && x.tick <= resetTick && x.e.kind === "land")).toEqual([]);
  });
  it("reports attacks and hits with damage and position, once each", () => {
    const { out } = run(
      400,
      (s) => (s.phase !== Phase.fighting ? 0 : s.f[1].x - s.f[0].x > 1100 ? B.R : s.tick % 40 === 0 ? B.S : 0),
    );
    const attacks = out.filter((x) => x.e.kind === "attack");
    const hits = out.filter((x) => x.e.kind === "hit");
    expect(attacks.length).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0]!.e as Extract<SimEvent, { kind: "hit" }>;
    expect(h.side).toBe(1);
    expect(h.by).toBe(0);
    expect(h.move).toBe(Mv.peck);
    expect(h.damage).toBe(600);
    expect(new Set(hits.map((x) => x.tick)).size).toBe(hits.length);
  });
  it("reports jump, land and dash", () => {
    const { out } = run(300, (s) => {
      if (s.phase !== Phase.fighting) return 0;
      const t = s.tick - RULES.match.countdown;
      return t === 1 ? B.U : t === 60 || t === 63 ? B.R : 0;
    });
    const kinds = out.map((x) => x.e.kind);
    expect(kinds).toContain("jump");
    expect(kinds).toContain("land");
    expect(kinds).toContain("dash");
  });
  it("places a hit on the defender: a full-screen super's sparks are not mid-arena", () => {
    for (const [x0, x1, heat] of [
      [-8000, 8000, RULES.heat.max],
      [-550, 550, 0],
    ] as const) {
      let s = createMatch({ matchId: "hitx" });
      while (s.phase !== Phase.fighting) s = step(s, 0, 0);
      s.f[0].x = x0;
      s.f[1].x = x1;
      s.f[0].heat = heat;
      let hit: Extract<SimEvent, { kind: "hit" }> | undefined;
      for (let t = 0; t < 30 && !hit; t++) {
        const next = step(s, t === 0 ? B.S : 0, 0);
        hit = deriveEvents(s, next, RULES.heat.max).find((e) => e.kind === "hit") as typeof hit;
        s = next;
      }
      expect(hit, `hit from ${x0}`).toBeDefined();
      expect(hit!.move).toBe(heat ? Mv.super : Mv.peck);
      // On the defender's side of the gap, within its body (hurt capsule radius ~0.35 u).
      expect(Math.abs(hit!.x - s.f[1].x)).toBeLessThan(500);
      expect(hit!.x).toBeGreaterThan(s.f[0].x);
    }
  });
  it("reports a KO, the round end and its reason", () => {
    let s = createMatch({ matchId: "ko" });
    while (s.phase !== Phase.fighting) s = step(s, 0, 0);
    s.f[0].x = -550;
    s.f[1].x = 550;
    s.f[1].hp = 1;
    const evs: SimEvent[] = [];
    for (let t = 0; t < 30 && s.phase === Phase.fighting; t++) {
      const next = step(s, t === 0 ? B.S : 0, 0);
      evs.push(...deriveEvents(s, next, RULES.heat.max));
      s = next;
    }
    expect(evs.map((e) => e.kind)).toEqual(expect.arrayContaining(["hit", "ko", "roundEnd"]));
    const end = evs.find((e) => e.kind === "roundEnd") as Extract<SimEvent, { kind: "roundEnd" }>;
    expect(end.winner).toBe(0);
    expect(reasonLabel(end.reason)).toBe("K.O.");
  });
});
