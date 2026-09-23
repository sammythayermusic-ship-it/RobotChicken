import { describe, expect, it } from "vitest";
import { FixedLoop, MAX_CATCH_UP, STEP_MS, type Scheduler } from "./loop";

const noSched: Scheduler = { request: () => 0, cancel: () => {} };

function loop() {
  let ticks = 0;
  const alphas: number[] = [];
  const l = new FixedLoop({ tick: () => ticks++, render: (a) => alphas.push(a) }, noSched);
  return { l, ticks: () => ticks, alphas };
}

describe("FixedLoop", () => {
  it("runs exactly one tick per 60 Hz frame (vsync snap)", () => {
    const { l, ticks } = loop();
    let t = 0;
    for (let i = 0; i < 600; i++) {
      t += STEP_MS + (i % 2 ? 0.3 : -0.3); // jittery 60 Hz display
      l.frame(t);
    }
    expect(ticks()).toBe(600);
  });
  it("runs 60 ticks per second on a 120 Hz display", () => {
    const { l, ticks } = loop();
    let t = 0;
    for (let i = 0; i < 240; i++) l.frame((t += 1000 / 120));
    expect(ticks()).toBeGreaterThanOrEqual(119);
    expect(ticks()).toBeLessThanOrEqual(121);
  });
  it("caps catch-up and drops the backlog", () => {
    const { l, ticks } = loop();
    l.frame(0);
    const before = ticks();
    const ran = l.frame(200); // 12 ticks owed
    expect(ran).toBe(MAX_CATCH_UP);
    expect(ticks() - before).toBe(MAX_CATCH_UP);
    expect(l.frame(200 + STEP_MS)).toBeLessThanOrEqual(2);
  });
  it("treats a long gap (tab return) as one tick", () => {
    const { l, ticks } = loop();
    l.frame(0);
    const before = ticks();
    l.frame(5000);
    expect(ticks() - before).toBe(1);
  });
  it("does not advance while paused or manual; stepTicks drives manual mode", () => {
    const { l, ticks } = loop();
    l.paused = true;
    for (let i = 1; i < 30; i++) l.frame(i * STEP_MS);
    expect(ticks()).toBe(0);
    l.paused = false;
    l.manual = true;
    l.frame(40 * STEP_MS);
    expect(ticks()).toBe(0);
    l.stepTicks(7);
    expect(ticks()).toBe(7);
  });
  it("passes an interpolation alpha in [0, 1]", () => {
    const { l, alphas } = loop();
    let t = 0;
    for (let i = 0; i < 100; i++) l.frame((t += 7));
    for (const a of alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });
});
