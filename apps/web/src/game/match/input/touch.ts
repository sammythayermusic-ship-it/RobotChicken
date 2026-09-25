import { B } from "@cockfight/sim";
import type { KeyTarget } from "./keyboard";

/** The d-pad's bits: world-space directions, exactly the arrow keys'. */
export const DPAD_MASK = B.L | B.R | B.U | B.D;

export type TouchButton = "peck" | "ctx";

/** What the context button does for the current press (fixed from its first tick until release). */
export const CtxMode = { none: 0, jump: 1, slam: 2, dive: 3 } as const;
export type CtxModeId = (typeof CtxMode)[keyof typeof CtxMode];

/** Direction levels waiting to be sent, one per tick. More than a finger can make between two ticks. */
const LEVEL_QUEUE = 8;
/** Space presses waiting to be sent. */
const PULSE_QUEUE = 2;

/**
 * On-screen buttons -> P1's button mask, the same 5 bits the keyboard makes.
 *
 * Thumbs are fast and ticks are 16.7 ms, so this does not latch like the
 * keyboard does:
 *  - D-pad changes are queued and sent one per tick. A tap and a re-tap
 *    between two ticks still reach the sim as R, 0, R: the two raw press
 *    edges a dash needs.
 *  - Space is a one-tick pulse per press, never held, with a zero tick
 *    between pulses. The sim only reads Space's press edge, so a pulse is a
 *    press, and a second button press always makes a new edge (holding PECK
 *    and then pressing DIVE would otherwise send nothing new).
 *  - The context button is resolved on the first tick after it goes down:
 *    in the air it is a Space pulse (the dive kick); on the ground with ↓
 *    held when the finger landed it is ↓ + Space on that one tick (the
 *    slam, with ↑ stripped because ↑ + ↓ cancel); otherwise it holds ↑ (the
 *    jump) until released, and a tap shorter than a tick still jumps.
 *
 * Framework-free: the React controls call setDpad / press / release, the
 * engine samples once per tick. Disabled (the pause menu) it ignores input
 * and drops everything; blur, a hidden tab and pagehide release everything.
 */
export class TouchInput {
  private enabled = true;
  private dpad = 0;
  /** Direction levels queued for the next ticks. */
  private readonly levels: number[] = [];
  /** The level sent last tick (and every tick until the queue has something new). */
  private out = 0;
  /** Extra bits for each pending Space pulse (↓ for a slam). */
  private readonly pulses: number[] = [];
  /** The last tick sent Space: this one must not, or two presses would merge into one. */
  private gap = false;
  private ctxDown = false;
  private ctxPending = false;
  private ctxDownAtPress = false;
  private mode: CtxModeId = CtxMode.none;
  /** A JUMP tap released before its first tick: send ↑ once anyway. */
  private jumpTap = false;
  /** The mask sampled last tick (debug and tests). */
  lastMask = 0;

  private readonly target: KeyTarget | undefined;
  private readonly doc: (KeyTarget & { visibilityState?: string }) | undefined;

  constructor(target?: KeyTarget, doc?: KeyTarget & { visibilityState?: string }) {
    this.target = target;
    this.doc = doc;
    target?.addEventListener("blur", this.releaseAll);
    target?.addEventListener("pagehide", this.releaseAll);
    doc?.addEventListener("visibilitychange", this.onVisibility);
  }

  /** The context button's mode for the current press (CtxMode.none when up or not yet resolved). */
  get ctxMode(): CtxModeId {
    return this.mode;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The d-pad now: any of L / R / U / D (other bits are ignored). */
  setDpad(bits: number): void {
    if (!this.enabled) return;
    this.dpad = bits & DPAD_MASK;
    this.pushLevel();
  }

  press(b: TouchButton): void {
    if (!this.enabled) return;
    if (b === "peck") {
      if (this.pulses.length < PULSE_QUEUE) this.pulses.push(0);
      return;
    }
    if (this.ctxDown) {
      // Another finger on the context button while one holds it: one more
      // press of what it is doing (a JUMP held in the air plus a tap dives,
      // like holding ↑ and pressing Space). Not yet resolved: the first press stands.
      if (this.mode !== CtxMode.none && this.pulses.length < PULSE_QUEUE) this.pulses.push(this.mode === CtxMode.slam ? B.D : 0);
      return;
    }
    this.ctxDown = true;
    this.ctxPending = true;
    this.ctxDownAtPress = (this.dpad & B.D) !== 0;
    this.mode = CtxMode.none;
  }

  release(b: TouchButton): void {
    if (!this.enabled || b !== "ctx" || !this.ctxDown) return;
    this.ctxDown = false;
    if (this.mode === CtxMode.jump) this.pushLevel();
    // Not resolved yet: the press still counts (sample() resolves it as a tap).
    if (!this.ctxPending) this.mode = CtxMode.none;
  }

  /**
   * Off while the game is paused. Either way everything held or queued is
   * dropped, so nothing touched on the menu fires after resuming.
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.releaseAll();
  }

  /** P1's buttons for the next tick. `grounded`: the fighter is on the floor this tick. */
  sample(grounded: boolean): number {
    if (!this.enabled) {
      this.lastMask = 0;
      return 0;
    }
    if (this.ctxPending) this.resolveCtx(grounded);
    const next = this.levels.shift();
    if (next !== undefined) this.out = next;
    let mask = this.out;
    if (this.jumpTap) {
      mask |= B.U;
      this.jumpTap = false;
    }
    if (this.gap) this.gap = false;
    else {
      const extra = this.pulses.shift();
      if (extra !== undefined) {
        mask |= B.S | extra;
        if (extra & B.D) mask &= ~B.U;
        this.gap = true;
      }
    }
    this.lastMask = mask;
    return mask;
  }

  readonly releaseAll = (): void => {
    this.dpad = 0;
    this.levels.length = 0;
    this.out = 0;
    this.pulses.length = 0;
    this.gap = false;
    this.ctxDown = false;
    this.ctxPending = false;
    this.ctxDownAtPress = false;
    this.mode = CtxMode.none;
    this.jumpTap = false;
  };

  dispose(): void {
    this.target?.removeEventListener("blur", this.releaseAll);
    this.target?.removeEventListener("pagehide", this.releaseAll);
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.releaseAll();
  }

  private resolveCtx(grounded: boolean): void {
    this.ctxPending = false;
    if (!grounded) {
      this.mode = CtxMode.dive;
      if (this.pulses.length < PULSE_QUEUE) this.pulses.push(0);
    } else if (this.ctxDownAtPress) {
      this.mode = CtxMode.slam;
      if (this.pulses.length < PULSE_QUEUE) this.pulses.push(B.D);
    } else {
      this.mode = CtxMode.jump;
      if (this.ctxDown) this.pushLevel();
      else this.jumpTap = true;
    }
    if (!this.ctxDown) this.mode = CtxMode.none;
  }

  /** Queue the current level (d-pad plus a held JUMP) if it differs from the last one queued or sent. */
  private pushLevel(): void {
    const level = this.dpad | (this.ctxDown && this.mode === CtxMode.jump ? B.U : 0);
    const tail = this.levels.length > 0 ? this.levels[this.levels.length - 1] : this.out;
    if (level === tail) return;
    if (this.levels.length < LEVEL_QUEUE) this.levels.push(level);
    else this.levels[this.levels.length - 1] = level;
  }

  private readonly onVisibility = (): void => {
    if (this.doc?.visibilityState === "hidden") this.releaseAll();
  };
}

/** The d-pad's eight sectors, degrees counter-clockwise from +x (screen right). Left and right are the widest. */
const SECTORS: readonly (readonly [from: number, to: number, bits: number])[] = [
  [330, 30, B.R],
  [30, 62.5, B.U | B.R],
  [62.5, 117.5, B.U],
  [117.5, 150, B.U | B.L],
  [150, 210, B.L],
  [210, 242.5, B.D | B.L],
  [242.5, 297.5, B.D],
  [297.5, 330, B.D | B.R],
];
/** Neutral inside this share of the pad's radius; a held direction lets go only inside the smaller one. */
export const DEAD_ZONE = 0.28;
export const DEAD_ZONE_HELD = 0.16;
/** A held direction stays until the thumb is this many degrees past its sector's edge. */
export const SECTOR_HYSTERESIS = 7;

const mod360 = (a: number) => ((a % 360) + 360) % 360;
function inSector(deg: number, from: number, to: number, pad: number): boolean {
  const width = mod360(to - from) + 2 * pad;
  return mod360(deg - (from - pad)) < width;
}

/**
 * The d-pad's bits for a thumb at (dx, dy) px from its centre (screen axes:
 * +y is down), on a pad of radius r px. `prev` is what it gave last time:
 * the dead zone and the sector edges are sticky, so a thumb resting on a
 * border doesn't flicker (a flicker through neutral would be a double tap: a
 * dash). A diagonal also stays a diagonal while the thumb stays on its side
 * (↘ back to ↓ keeps ↘): the sim counts every raw → press toward a dash, so a
 * blocking thumb wobbling between ↓ and ↘ would otherwise dash forward.
 * There is no outer limit: a thumb that slides off the pad keeps its
 * direction.
 */
export function dpadBits(dx: number, dy: number, r: number, prev = 0): number {
  const dist = Math.hypot(dx, dy);
  if (dist < r * (prev ? DEAD_ZONE_HELD : DEAD_ZONE)) return 0;
  const deg = mod360((Math.atan2(-dy, dx) * 180) / Math.PI);
  if (prev) {
    const held = SECTORS.find((s) => s[2] === prev);
    if (held && inSector(deg, held[0], held[1], SECTOR_HYSTERESIS)) return prev;
  }
  let bits: number = B.R; // (the sectors cover the circle)
  for (const [from, to, b] of SECTORS) {
    if (inSector(deg, from, to, 0)) {
      bits = b;
      break;
    }
  }
  const vert = B.U | B.D;
  const horiz = B.L | B.R;
  if ((bits & horiz) === 0 && (prev & horiz) !== 0 && (bits & vert) !== 0 && (bits & vert) === (prev & vert)) return prev;
  return bits;
}
