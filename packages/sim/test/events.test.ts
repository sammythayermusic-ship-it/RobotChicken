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
