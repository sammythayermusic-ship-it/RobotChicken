/**
 * HUD state, split in two channels so React never re-renders at 60 Hz:
 *  - hot values (HP, damage trail, Heat) are written straight to registered
 *    DOM elements as compositor-only transforms;
 *  - cold values (phase, timer seconds, round wins, banners, pause, winner)
 *    live in this tiny external store, read with useSyncExternalStore.
 * Framework-free: the engine writes, components under src/components/hud read.
 */
export interface HudCold {
  mode: "cpu" | "2p" | "demo";
  names: [string, string];
  phase: number;
  round: number;
  timerSec: number;
  sd: boolean;
  wins: [number, number];
  heatFull: [boolean, boolean];
  /**
   * P1 against the CPU (the on-screen buttons' player) is off the floor: the
   * context button reads DIVE. Only published in CPU fights: each change
   * re-renders the page.
   */
  air: boolean;
  /** ...and Space now would dive (or wait in the rise for it): DIVE is live, not dimmed. */
  dive: boolean;
  /** Banner text and a key that changes each time a banner is shown (restarts its animation). */
  banner: { text: string; key: number; tone: "info" | "ko" | "win" };
  paused: boolean;
  /** -1 = match running, 0 / 1 = winner, 2 = draw. */
  matchWinner: number;
  loading: boolean;
  error: string | null;
}

export type HotBar = "hp0" | "hp1" | "trail0" | "trail1" | "heat0" | "heat1";

const HOT_BARS: readonly HotBar[] = ["hp0", "hp1", "trail0", "trail1", "heat0", "heat1"];

type Listener = () => void;

/** The HUD before a fight's first tick. */
function fresh(): HudCold {
  return {
    mode: "cpu",
    names: ["P1", "P2"],
    phase: 0,
    round: 1,
    timerSec: 60,
    sd: false,
    wins: [0, 0],
    heatFull: [false, false],
    air: false,
    dive: false,
    banner: { text: "", key: 0, tone: "info" },
    paused: false,
    matchWinner: -1,
    loading: true,
    error: null,
  };
}

export class HudStore {
  private state: HudCold;
  private readonly listeners = new Set<Listener>();
  private readonly bars = new Map<HotBar, HTMLElement>();
  private readonly flashEls = new Map<number, HTMLElement>();
  private bannerKey = 0;

  constructor(init: Partial<HudCold> = {}) {
    this.state = { ...fresh(), ...init };
  }

  readonly subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly get = (): HudCold => this.state;

  /** Shallow-merge a patch; notifies only when something changed. */
  set(patch: Partial<HudCold>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof HudCold)[]) {
      const a = this.state[k];
      const b = patch[k];
      if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /**
   * Back to the start of a fight: every cold value to its default (then
   * `patch`), health and damage trails full, Heat empty, no hit flash. A new
   * engine calls this because the store outlives engines: without it a
   * restart inherits the last fight's pause flag, winner, wins and bars.
   */
  reset(patch: Partial<HudCold> = {}): void {
    this.state = { ...fresh(), ...patch };
    for (const key of HOT_BARS) this.setBar(key, key.startsWith("heat") ? 0 : 1);
    for (const el of this.flashEls.values()) el.classList.remove("hud-flash");
    for (const fn of this.listeners) fn();
  }

  banner(text: string, tone: HudCold["banner"]["tone"] = "info"): void {
    this.set({ banner: { text, key: ++this.bannerKey, tone } });
  }

  registerBar(key: HotBar, el: HTMLElement | null): void {
    if (el) this.bars.set(key, el);
    else this.bars.delete(key);
  }

  registerFlash(side: number, el: HTMLElement | null): void {
    if (el) this.flashEls.set(side, el);
    else this.flashEls.delete(side);
  }

  /** Hot path: scaleX a registered bar (0..1). */
  setBar(key: HotBar, frac: number): void {
    const el = this.bars.get(key);
    if (!el) return;
    const v = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const t = `scaleX(${v.toFixed(4)})`;
    if (el.style.transform === t) return;
    el.style.transform = t;
    // Keep the meter's accessible value in step (whole percent, so it rarely changes).
    if (!key.startsWith("trail")) {
      const meter = el.parentElement;
      const pct = String(Math.round(v * 100));
      if (meter && meter.getAttribute("aria-valuenow") !== pct) meter.setAttribute("aria-valuenow", pct);
    }
  }

  /** Restart the white hit-flash animation on a side's HP bar. */
  flash(side: number): void {
    const el = this.flashEls.get(side);
    if (!el) return;
    el.classList.remove("hud-flash");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add("hud-flash");
  }
}
