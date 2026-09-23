import { describe, expect, it } from "vitest";
import { HudStore, type HotBar } from "./hudStore";

/** Just enough of an HTMLElement for the hot path: style.transform, classList and the meter's aria value. */
function fakeBar() {
  const attrs = new Map<string, string>();
  const meter = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => attrs.set(k, v) };
  const classes = new Set<string>();
  const el = {
    style: { transform: "" },
    parentElement: meter,
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    offsetWidth: 0,
  };
  return { el: el as unknown as HTMLElement, attrs, classes };
}

describe("HudStore", () => {
  it("reset() brings back a fresh fight: not paused, no winner, no wins, no banner, full bars", () => {
    const hud = new HudStore();
    const bars = new Map<HotBar, ReturnType<typeof fakeBar>>();
    for (const k of ["hp0", "hp1", "trail0", "trail1", "heat0", "heat1"] as const) {
      const b = fakeBar();
      bars.set(k, b);
      hud.registerBar(k, b.el);
    }
    const flash = fakeBar();
    hud.registerFlash(0, flash.el);

    // The end of a match, paused on the way.
    hud.set({ loading: false, paused: true, matchWinner: 1, phase: 3, round: 3, wins: [1, 2], heatFull: [true, false], sd: true, timerSec: 4 });
    hud.banner("P2 WINS", "win");
    hud.setBar("hp0", 0);
    hud.setBar("trail0", 0.2);
    hud.setBar("heat1", 0.7);
    hud.flash(0);
    expect(flash.classes.has("hud-flash")).toBe(true);

    let notified = 0;
    hud.subscribe(() => notified++);
    hud.reset({ loading: true, mode: "2p", names: ["P1", "P2"] });

    expect(notified).toBe(1);
    expect(hud.get()).toMatchObject({
      loading: true,
      error: null,
      paused: false,
      matchWinner: -1,
      phase: 0,
      round: 1,
      wins: [0, 0],
      heatFull: [false, false],
      sd: false,
      mode: "2p",
      names: ["P1", "P2"],
    });
    expect(hud.get().banner.text).toBe("");
    expect(bars.get("hp0")?.el.style.transform).toBe("scaleX(1.0000)");
    expect(bars.get("trail0")?.el.style.transform).toBe("scaleX(1.0000)");
    expect(bars.get("heat1")?.el.style.transform).toBe("scaleX(0.0000)");
    expect(bars.get("hp0")?.attrs.get("aria-valuenow")).toBe("100");
    expect(bars.get("heat1")?.attrs.get("aria-valuenow")).toBe("0");
    expect(flash.classes.has("hud-flash")).toBe(false);

    // Banners still restart their animation after a reset (a fresh key each time).
    const before = hud.get().banner.key;
    hud.banner("3");
    expect(hud.get().banner.key).not.toBe(before);
  });
});
