import { describe, expect, it } from "vitest";
import { B, Mv, Phase, RULES, St } from "@cockfight/sim";
import { LocalMatch } from "../LocalMatch";
import type { KeyTarget } from "./keyboard";
import { ScriptSource, TouchSource } from "./source";
import { CtxMode, dpadBits, TouchInput } from "./touch";

class FakeTarget implements KeyTarget {
  visibilityState = "visible";
  private fns = new Map<string, ((e: Event) => void)[]>();
  addEventListener(type: string, fn: (e: Event) => void) {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.fns.set(type, (this.fns.get(type) ?? []).filter((f) => f !== fn));
  }
  fire(type: string) {
    for (const f of this.fns.get(type) ?? []) f({ type } as Event);
  }
  count() {
    let n = 0;
    for (const l of this.fns.values()) n += l.length;
    return n;
  }
}

/** Samples n ticks on the ground (or in the air). */
const run = (t: TouchInput, n: number, grounded = true) => Array.from({ length: n }, () => t.sample(grounded));

describe("dpadBits", () => {
  const r = 100;
  it("is neutral inside the dead zone", () => {
    expect(dpadBits(0, 0, r)).toBe(0);
    expect(dpadBits(27, 0, r)).toBe(0);
    expect(dpadBits(29, 0, r)).toBe(B.R);
  });
  it("gives the eight directions (screen +y is down), left and right the widest", () => {
    const at = (deg: number) => dpadBits(80 * Math.cos((deg * Math.PI) / 180), -80 * Math.sin((deg * Math.PI) / 180), r);
    expect(at(0)).toBe(B.R);
    expect(at(29)).toBe(B.R);
    expect(at(-29)).toBe(B.R);
    expect(at(45)).toBe(B.U | B.R);
    expect(at(90)).toBe(B.U);
    expect(at(135)).toBe(B.U | B.L);
    expect(at(180)).toBe(B.L);
    expect(at(151)).toBe(B.L);
    expect(at(225)).toBe(B.D | B.L);
    expect(at(270)).toBe(B.D);
    expect(at(315)).toBe(B.D | B.R);
  });
  it("keeps a held direction a little past its sector's edge and inside the smaller dead zone", () => {
    const at = (deg: number, d: number, prev: number) =>
      dpadBits(d * Math.cos((deg * Math.PI) / 180), -d * Math.sin((deg * Math.PI) / 180), r, prev);
    expect(at(35, 80, B.R)).toBe(B.R); // 5° past R's edge: still R
    expect(at(38, 80, B.R)).toBe(B.U | B.R); // 8° past: the diagonal
    expect(at(35, 80, 0)).toBe(B.U | B.R);
    expect(at(0, 24, B.R)).toBe(B.R);
    expect(at(0, 17, B.R)).toBe(B.R);
    expect(at(0, 15, B.R)).toBe(0);
  });
  it("a diagonal stays diagonal while the thumb stays on its side: a blocking thumb's ↓/↘ wobble can't dash", () => {
    const at = (deg: number, prev: number) => dpadBits(60 * Math.cos((deg * Math.PI) / 180), -60 * Math.sin((deg * Math.PI) / 180), 100, prev);
    let bits = at(270, 0);
    expect(bits).toBe(B.D);
    const seen: number[] = [];
    for (const deg of [305, 289, 305, 289, 270, 305]) {
      bits = at(deg, bits);
      seen.push(bits);
    }
    expect(seen).toEqual([B.D | B.R, B.D | B.R, B.D | B.R, B.D | B.R, B.D | B.R, B.D | B.R]);
    expect(at(240, B.D | B.R)).toBe(B.D | B.L); // across to the other diagonal: a real change
    expect(at(0, B.D | B.R)).toBe(B.R); // up to plain →: keeps →
    expect(at(90, B.U | B.R)).toBe(B.U | B.R); // the same above
  });
  it("has no outer limit: a thumb that slid off the pad keeps its direction", () => {
    expect(dpadBits(-400, 10, r)).toBe(B.L);
  });
});

describe("TouchInput", () => {
  it("sends the d-pad as held directions", () => {
    const t = new TouchInput();
    t.setDpad(B.R);
    expect(run(t, 3)).toEqual([B.R, B.R, B.R]);
    t.setDpad(0);
    expect(t.sample(true)).toBe(0);
  });

  it("a tap and a re-tap between two ticks still reach the sim as R, 0, R (a dash needs both edges)", () => {
    const t = new TouchInput();
    t.setDpad(B.R);
    t.setDpad(0);
    t.setDpad(B.R);
    expect(run(t, 4)).toEqual([B.R, 0, B.R, B.R]);
  });

  it("drops only the bits the d-pad doesn't own", () => {
    const t = new TouchInput();
    t.setDpad(B.L | B.S);
    expect(t.sample(true)).toBe(B.L);
  });

  it("PECK is a one-tick Space pulse, with a zero tick between two presses", () => {
    const t = new TouchInput();
    t.press("peck");
    t.press("peck");
    t.release("peck");
    expect(run(t, 4)).toEqual([B.S, 0, B.S, 0]);
  });

  it("PECK keeps the d-pad's directions on its tick (toward = shove, down = slam)", () => {
    const t = new TouchInput();
    t.setDpad(B.D);
    t.press("peck");
    expect(run(t, 2)).toEqual([B.D | B.S, B.D]);
  });

  it("the context button on the ground holds ↑ (JUMP) until released", () => {
    const t = new TouchInput();
    t.press("ctx");
    expect(t.sample(true)).toBe(B.U);
    expect(t.ctxMode).toBe(CtxMode.jump);
    expect(t.sample(false)).toBe(B.U); // still JUMP in the air: the mode is fixed until release
    t.release("ctx");
    expect(t.sample(false)).toBe(0);
    expect(t.ctxMode).toBe(CtxMode.none);
  });

  it("a JUMP tap shorter than a tick still sends ↑ once", () => {
    const t = new TouchInput();
    t.press("ctx");
    t.release("ctx");
    expect(run(t, 3)).toEqual([B.U, 0, 0]);
  });

  it("with ↓ held it is a SLAM: ↓ + Space on one tick, ↑ stripped", () => {
    const t = new TouchInput();
    t.setDpad(B.D | B.R);
    t.press("ctx");
    expect(t.sample(true)).toBe(B.D | B.R | B.S);
    expect(t.ctxMode).toBe(CtxMode.slam);
    expect(t.sample(true)).toBe(B.D | B.R);
    t.release("ctx");
    expect(t.ctxMode).toBe(CtxMode.none);
  });

  it("↓ counts when the finger lands: letting go of ↓ before the tick still slams, with ↓ on that tick", () => {
    const t = new TouchInput();
    t.setDpad(B.D);
    t.press("ctx");
    t.setDpad(B.U);
    // The queue sends ↓ then ↑; the slam's tick carries ↓ + Space and no ↑.
    const first = t.sample(true);
    expect(first & (B.D | B.S)).toBe(B.D | B.S);
    expect(first & B.U).toBe(0);
  });

  it("in the air it is a DIVE: a Space pulse", () => {
    const t = new TouchInput();
    t.press("ctx");
    expect(t.sample(false)).toBe(B.S);
    expect(t.ctxMode).toBe(CtxMode.dive);
    expect(t.sample(false)).toBe(0);
  });

  it("holding PECK then pressing DIVE still makes a new Space press", () => {
    const t = new TouchInput();
    t.press("peck");
    expect(t.sample(false)).toBe(B.S);
    t.press("ctx");
    expect(run(t, 3, false)).toEqual([0, B.S, 0]);
  });

  it("ignores everything while disabled (paused), and drops what was held", () => {
    const t = new TouchInput();
    t.setDpad(B.R);
    t.press("ctx");
    t.setEnabled(false);
    t.setDpad(B.L);
    t.press("peck");
    expect(run(t, 3)).toEqual([0, 0, 0]);
    t.setEnabled(true);
    expect(run(t, 2)).toEqual([0, 0]);
  });

  it("releases everything on blur, a hidden tab and pagehide; dispose removes its listeners", () => {
    const w = new FakeTarget();
    const d = new FakeTarget();
    const t = new TouchInput(w, d);
    for (const ev of ["blur", "pagehide"]) {
      t.setDpad(B.R);
      t.press("ctx");
      w.fire(ev);
      expect(t.sample(true), ev).toBe(0);
    }
    t.setDpad(B.R);
    d.visibilityState = "hidden";
    d.fire("visibilitychange");
    expect(t.sample(true)).toBe(0);
    t.dispose();
    expect(w.count() + d.count()).toBe(0);
  });

  it("a flood of d-pad changes keeps the latest direction", () => {
    const t = new TouchInput();
    for (let i = 0; i < 20; i++) t.setDpad(i % 2 ? B.L : B.R);
    const out = run(t, 12);
    expect(out[out.length - 1]).toBe(B.L);
  });
});

/** P1 on touch, P2 scripted, played through the real sim. */
function touchMatch(id = "touch-sim") {
  const touch = new TouchInput();
  const p2 = new ScriptSource();
  const m = new LocalMatch(id, [new TouchSource(touch), p2]);
  while (m.cur.phase !== Phase.fighting) m.tick();
  return { touch, p2, m, f: () => m.cur.f[0] };
}

describe("touch through the sim", () => {
  it("a d-pad double tap dashes", () => {
    const { touch, m, f } = touchMatch();
    touch.setDpad(B.R);
    m.tick();
    touch.setDpad(0);
    m.tick();
    touch.setDpad(B.R);
    m.tick();
    m.tick();
    expect(f().st).toBe(St.dashF);
  });

  it("holding ↓ blocks", () => {
    const { touch, m, f } = touchMatch();
    touch.setDpad(B.D);
    for (let i = 0; i < 3; i++) m.tick();
    expect(f().st).toBe(St.block);
  });

  it("↓ + the context button slams", () => {
    const { touch, m, f } = touchMatch();
    touch.setDpad(B.D);
    m.tick();
    touch.press("ctx");
    m.tick();
    touch.release("ctx");
    m.tick();
    expect(f().st).toBe(St.attack);
    expect(f().move).toBe(Mv.slam);
  });

  it("the context button jumps, and pressed again in the air it dives (an early press waits for the dive)", () => {
    const { touch, m, f } = touchMatch();
    touch.press("ctx");
    m.tick();
    touch.release("ctx");
    m.tick();
    expect(f().st).toBe(St.jump);
    touch.press("ctx"); // far too early (tick 2 of the jump): buffered until the dive is legal
    m.tick();
    touch.release("ctx");
    let dove = false;
    for (let i = 0; i < 40 && !dove; i++) {
      m.tick();
      dove = f().move === Mv.dive_kick;
    }
    expect(dove).toBe(true);
  });

  it("a blocking thumb wobbling between ↓ and ↘ keeps blocking (no dash)", () => {
    const { touch, m, f } = touchMatch("touch-wobble");
    for (const bits of [B.D | B.R, B.D | B.R, B.D, B.D, B.D, B.D | B.R]) {
      // What the d-pad sends for that wobble (dpadBits keeps the diagonal).
      touch.setDpad(dpadBits(bits & B.R ? 40 : 0, 60, 100, touch.lastMask & (B.L | B.R | B.U | B.D)));
      m.tick();
    }
    for (let i = 0; i < 3; i++) m.tick();
    expect(f().st).toBe(St.block);
  });

  it("a second finger on the context button while JUMP is held dives", () => {
    const { touch, m, f } = touchMatch("touch-ctx2");
    touch.press("ctx");
    let dove = false;
    for (let i = 0; i < 20; i++) m.tick();
    expect(f().st).toBe(St.jump);
    touch.press("ctx"); // second finger
    for (let i = 0; i < 20 && !dove; i++) {
      m.tick();
      dove = f().move === Mv.dive_kick;
    }
    expect(dove).toBe(true);
    touch.release("ctx");
  });

  it("PECK at full Heat with the d-pad neutral is the super; toward + PECK is a shove", () => {
    const a = touchMatch("touch-super");
    a.m.cur.f[0].heat = RULES.heat.max;
    a.touch.press("peck");
    a.m.tick();
    a.m.tick();
    expect(a.f().move).toBe(Mv.super);

    const b = touchMatch("touch-shove");
    b.touch.setDpad(B.R); // P1 starts on the left, facing right
    b.m.tick();
    b.touch.press("peck");
    b.m.tick();
    b.m.tick();
    expect(b.f().move).toBe(Mv.shove);
  });

  it("PECK walks in and lands", () => {
    const { touch, m } = touchMatch("touch-peck");
    touch.setDpad(B.R);
    while (m.cur.f[1].x - m.cur.f[0].x > 1200) m.tick();
    touch.setDpad(0);
    m.tick();
    touch.press("peck");
    let hit = false;
    for (let i = 0; i < 20 && !hit; i++) hit = m.tick().some((e) => e.kind === "hit");
    expect(hit).toBe(true);
  });
});
