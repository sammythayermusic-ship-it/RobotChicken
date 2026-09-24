import { describe, expect, it } from "vitest";
import { Phase } from "@cockfight/sim";
import { MAX_LEAD } from "../src/protocol";
import { ServerMatch } from "../src/server";

function toFighting(m: ServerMatch) {
  while (m.state.phase !== Phase.fighting) m.step();
}

describe("ServerMatch", () => {
  it("uses buffered inputs on their tick and repeats the last buttons when one is missing", () => {
    const m = new ServerMatch("srv-1");
    toFighting(m);
    const t = m.tick;
    m.receive(0, { first: t + 1, masks: [2, 2] });
    m.receive(1, { first: t + 1, masks: [1] });
    expect(m.step()).toEqual({ tick: t + 1, b1: 2, b2: 1 });
    // P2's input for t+2 is missing: its last buttons repeat and it counts as missed.
    expect(m.step()).toEqual({ tick: t + 2, b1: 2, b2: 1 });
    expect(m.stats[1].missed).toBe(1);
    expect(m.stats[0].missed).toBe(0);
    expect(m.quality(1)).toBeLessThan(1);
  });

  it("drops late inputs and rejects ones too far ahead, counting both", () => {
    const m = new ServerMatch("srv-2");
    for (let i = 0; i < 10; i++) m.step();
    m.receive(0, { first: 5, masks: [16, 16] });
    expect(m.stats[0].late).toBe(2);
    m.receive(0, { first: m.tick + MAX_LEAD + 1, masks: [16] });
    expect(m.stats[0].ahead).toBe(1);
    m.receive(0, { first: m.tick + MAX_LEAD, masks: [16] });
    expect(m.stats[0].received).toBe(1);
  });

  it("the first copy of a tick's input wins", () => {
    const m = new ServerMatch("srv-3");
    m.receive(0, { first: 1, masks: [4] });
    m.receive(0, { first: 1, masks: [8] });
    expect(m.step().b1).toBe(4);
  });

  it("reports the smallest margin since the last read, -1 when an input was missing", () => {
    const m = new ServerMatch("srv-4");
    m.receive(0, { first: 1, masks: [0, 0, 0] }); // arrive 1..3 ticks early
    m.step();
    m.step();
    expect(m.takeMargin(0)).toBe(1);
    m.step();
    expect(m.takeMargin(0)).toBe(3);
    m.step(); // nothing buffered for tick 4
    expect(m.takeMargin(0)).toBe(-1);
    expect(m.takeMargin(1)).toBe(-1);
  });

  it("missed inputs only count while fighting (the sim ignores buttons otherwise)", () => {
    const m = new ServerMatch("srv-5");
    m.step();
    expect(m.stats[0].missed).toBe(0);
    expect(m.quality(0)).toBe(1);
  });
});
