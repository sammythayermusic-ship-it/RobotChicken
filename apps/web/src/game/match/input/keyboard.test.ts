import { describe, expect, it } from "vitest";
import { B } from "@cockfight/sim";
import { SOLO, VERSUS } from "./bindings";
import { KeyboardInput, type KeyTarget } from "./keyboard";

class FakeTarget implements KeyTarget {
  visibilityState = "visible";
  private fns = new Map<string, ((e: Event) => void)[]>();
  addEventListener(type: string, fn: (e: Event) => void) {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.fns.set(type, (this.fns.get(type) ?? []).filter((f) => f !== fn));
  }
  fire(type: string, init: Partial<KeyboardEvent> = {}) {
    let prevented = false;
    const e = { type, repeat: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, ...init, preventDefault: () => (prevented = true) };
    for (const f of this.fns.get(type) ?? []) f(e as unknown as Event);
    return prevented;
  }
}

describe("KeyboardInput", () => {
  it("maps held keys to the right player's bits", () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(VERSUS, t, t);
    t.fire("keydown", { code: "KeyD" });
    t.fire("keydown", { code: "ArrowLeft" });
    expect(kb.sample(0)).toBe(B.R);
    expect(kb.sample(1)).toBe(B.L);
  });
  it("a tap shorter than a tick still registers once (press latch)", () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(SOLO, t, t);
    t.fire("keydown", { code: "Space" });
    t.fire("keyup", { code: "Space" });
    expect(kb.sample(0)).toBe(B.S);
    expect(kb.sample(0)).toBe(0);
  });
  it("ignores auto-repeat, modifier chords and unbound keys; prevents default on bound keys", () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(SOLO, t, t);
    expect(t.fire("keydown", { code: "KeyQ" })).toBe(false);
    t.fire("keydown", { code: "KeyW", metaKey: true });
    expect(kb.sample(0)).toBe(0);
    expect(t.fire("keydown", { code: "ArrowUp" })).toBe(true);
    t.fire("keydown", { code: "ArrowUp", repeat: true });
    expect(kb.recent.filter((c) => c === "ArrowUp").length).toBe(1);
  });
  it("releases everything on blur and when the tab is hidden", () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(SOLO, t, t);
    t.fire("keydown", { code: "ArrowRight" });
    t.fire("blur");
    expect(kb.sample(0)).toBe(0);
    t.fire("keydown", { code: "ArrowRight" });
    t.visibilityState = "hidden";
    t.fire("visibilitychange");
    expect(kb.sample(0)).toBe(0);
  });
  it("never binds Ctrl / Meta / Alt / Shift", () => {
    for (const b of [SOLO, VERSUS]) for (const code of b.keys()) expect(code).not.toMatch(/Control|Meta|Alt|Shift/);
  });
});
