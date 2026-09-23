import { describe, expect, it } from "vitest";
import { B } from "@cockfight/sim";
import { SOLO, VERSUS } from "./bindings";
import { KeyboardInput, isControlTarget, type KeyTarget } from "./keyboard";

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
  it("leaves keys aimed at a focused control to that control (menu buttons, checkboxes, selects)", () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(VERSUS, t, t);
    const resume = fakeElement("button");
    // Enter on RESUME (a P2 peck key in 2P) and Space on the Sound checkbox: not prevented, not recorded.
    expect(t.fire("keydown", { code: "Enter", target: resume })).toBe(false);
    expect(t.fire("keyup", { code: "Enter", target: resume })).toBe(false);
    expect(t.fire("keydown", { code: "Space", target: fakeElement("input") })).toBe(false);
    expect(t.fire("keyup", { code: "Space", target: fakeElement("input") })).toBe(false);
    expect(kb.sample(0) | kb.sample(1)).toBe(0);
    // The canvas (or the page body) is the game's: bound keys are prevented and recorded.
    expect(t.fire("keydown", { code: "Space", target: fakeElement("canvas") })).toBe(true);
    expect(kb.sample(0)).toBe(B.S);
  });
  it("a key released over a control still releases", () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(SOLO, t, t);
    t.fire("keydown", { code: "ArrowRight", target: fakeElement("canvas") });
    t.fire("keyup", { code: "ArrowRight", target: fakeElement("button") });
    kb.sample(0); // consume the latch
    expect(kb.sample(0)).toBe(0);
  });
  it("disabled (paused), it ignores keys and drops what was held or latched", () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(SOLO, t, t);
    t.fire("keydown", { code: "ArrowRight" });
    kb.setEnabled(false);
    // A peck pressed on the pause menu: not prevented (the menu may use it) and not latched.
    expect(t.fire("keydown", { code: "Space" })).toBe(false);
    expect(t.fire("keyup", { code: "Space" })).toBe(false);
    kb.setEnabled(true);
    expect(kb.sample(0)).toBe(0);
    expect(t.fire("keydown", { code: "Space" })).toBe(true);
    expect(kb.sample(0)).toBe(B.S);
  });
});

describe("isControlTarget", () => {
  it("is true inside buttons, links, form fields and editable text, false elsewhere", () => {
    for (const tag of ["button", "a", "input", "select", "textarea", "editable"]) expect(isControlTarget(fakeElement(tag)), tag).toBe(true);
    for (const tag of ["canvas", "body", "div"]) expect(isControlTarget(fakeElement(tag)), tag).toBe(false);
    expect(isControlTarget(null)).toBe(false);
    expect(isControlTarget({} as EventTarget)).toBe(false);
  });
});

/** Just enough of an Element for isControlTarget: closest() answers for the element itself. */
function fakeElement(tag: string): EventTarget {
  const matches: Record<string, RegExp> = {
    button: /(^|, )button(,|$)/,
    a: /a\[href\]/,
    input: /(^|, )input(,|$)/,
    select: /(^|, )select(,|$)/,
    textarea: /(^|, )textarea(,|$)/,
    editable: /\[contenteditable\]/,
  };
  return { closest: (selector: string) => (matches[tag]?.test(selector) ? {} : null) } as unknown as EventTarget;
}
