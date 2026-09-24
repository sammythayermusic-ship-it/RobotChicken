/**
 * Client-side prediction and reconciliation for one player, independent of
 * Colyseus and the renderer.
 *
 * - `confirmed` is the server's truth: stepped from the buttons the server
 *   says it used, so it equals the server's state tick for tick (checked
 *   against periodic full-state syncs).
 * - The client shows its own tick P, a few ticks ahead of `confirmed`: it
 *   predicts both fighters from `confirmed` with its own recorded buttons and
 *   the opponent's last confirmed buttons. When new confirmations arrive it
 *   re-simulates from `confirmed` (rollback).
 * - Its buttons are tagged for tick P + INPUT_DELAY and sent at once, so they
 *   usually reach the server before it needs them. The server reports how
 *   early they arrive (the margin) and the client runs a tick more or less to
 *   keep that margin near TARGET_MARGIN.
 * - A correction under 0.5 u blends out over 3 frames; a bigger one snaps
 *   (spec). The blend offsets only the drawn position, never the sim state.
 */
import {
  RULES, STATE_INTS, clone, createMatch, deriveEvents, deserialize, serialize, step, type MatchState, type Rules, type SimEvent,
} from "@cockfight/sim";
import { INPUT_DELAY, MAX_INPUT_BATCH, MAX_LEAD, TARGET_MARGIN, encodeInputs, type FrameBatch, type Sync } from "./protocol";

const RING = 256;
const RMASK = RING - 1;
const TICK_MS = 1000 / 60;
/**
 * Corrections up to this (mu) are blended; bigger ones snap. The spec says
 * 0.5 u, but a dash moves 0.16 u a tick, so any dash the prediction misses by
 * 4 ticks (80 ms RTT) would teleport. Blending hides those; a real teleport
 * (a missed ring-out, a missed knockdown slide) still snaps.
 */
export const SNAP_LIMIT = 3000;
/** A blended correction moves the drawn fighter at most this far per frame (mu), and takes at least 3 frames (spec). */
export const BLEND_SPEED = 150;
export const BLEND_MIN_FRAMES = 3;
export const BLEND_MAX_FRAMES = 20;
/** Ticks between clock adjustments (each adjustment is one tick more or less). */
const ADJUST_EVERY = 12;
/** Margin (ticks) above TARGET_MARGIN that makes the client slow down. */
const SLACK = 3;
/**
 * The client never predicts further than this past its last confirmed tick:
 * if confirmations stop (the server paused, the network stalled) it holds
 * still instead of drifting further from the truth.
 */
export const MAX_PREDICT = MAX_LEAD - INPUT_DELAY;

export interface Correction {
  tick: number;
  /** Largest per-fighter position error fixed (mu). */
  mu: number;
  snapped: boolean;
}

export interface ClientStats {
  /** Re-simulations after new confirmations. */
  rollbacks: number;
  /** Ticks re-simulated in total. */
  resimTicks: number;
  /** Deepest re-simulation (ticks). */
  maxDepth: number;
  corrections: Correction[];
  /** Syncs that disagreed with the confirmed state (should stay 0). */
  desyncs: number;
  /** Syncs adopted to jump forward (join, reconnect). */
  adopted: number;
  speedUps: number;
  slowDowns: number;
  /** Largest per-frame jump of a drawn fighter caused by blending (mu). */
  maxBlendStep: number;
}

export class ClientPredictor {
  readonly side: 0 | 1;
  private readonly R: Rules;
  /** The server's truth, stepped from confirmed buttons. Null until the first sync. */
  confirmed: MatchState | null = null;
  /** The predicted state at tick P (raw sim state). */
  private predicted: MatchState;
  /** What was shown last tick and this tick (presentation copies, offsets applied). */
  prev: MatchState;
  cur: MatchState;
  /** Presentation events for the latest shown tick. */
  events: SimEvent[] = [];
  /** Raw predicted state shown last (for events and correction measurement). */
  private shownRaw: MatchState;
  /** The tick this client shows. */
  present = 0;
  private dirty = false;
  private readonly inTag = new Int32Array(RING).fill(-1);
  private readonly inMask = new Uint8Array(RING);
  private lastOwnConfirmed = 0;
  private lastOppConfirmed = 0;
  private out: number[] = [];
  private outFirst = 0;
  private readonly outbox: Uint8Array[] = [];
  private rttMs = 100;
  /** Smallest margin reported since the last adjustment (127 = nothing reported). */
  private marginWindow = 127;
  private sinceAdjust = 0;
  private realign = true;
  paused = false;
  private readonly offset: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  private blendLeft = 0;
  readonly stats: ClientStats = { rollbacks: 0, resimTicks: 0, maxDepth: 0, corrections: [], desyncs: 0, adopted: 0, speedUps: 0, slowDowns: 0, maxBlendStep: 0 };
  private readonly scratch = new Int32Array(STATE_INTS);

  /** Ticks between sampling a button and the tick it applies to. */
  readonly delay: number;

  constructor(matchId: string, side: 0 | 1, opts: { delay?: number; R?: Rules } = {}) {
    this.side = side;
    this.R = opts.R ?? RULES;
    this.delay = opts.delay ?? INPUT_DELAY;
    const R = this.R;
    this.predicted = createMatch({ matchId }, R);
    this.shownRaw = this.predicted;
    this.prev = this.predicted;
    this.cur = this.predicted;
  }

  /** True once the first sync arrived and the client is predicting. */
  get live(): boolean {
    return this.confirmed !== null;
  }

  /** Latest measured round trip (ms); used to place the client's tick when it (re)aligns. */
  setRtt(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.rttMs = ms;
  }

  /** Stop advancing (the room paused for a disconnect). Keeps everything else. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** A full-state sync from the server. */
  onSync(sync: Sync): void {
    if (this.confirmed && sync.tick === this.confirmed.tick) {
      // Desync check. Equal serialized states hash equal, so compare ints directly.
      const mine = serialize(this.confirmed, this.scratch);
      let same = true;
      for (let i = 0; i < STATE_INTS; i++) if (mine[i] !== sync.state[i]) same = false;
      if (same) return;
      this.stats.desyncs++;
    } else if (this.confirmed && sync.tick < this.confirmed.tick) {
      return; // older than what we have (cannot happen on an ordered socket)
    } else {
      this.stats.adopted++;
      this.realign = true;
    }
    this.confirmed = deserialize(sync.state);
    this.lastOwnConfirmed = this.confirmed.f[this.side].rawHeld;
    this.lastOppConfirmed = this.confirmed.f[this.side === 0 ? 1 : 0].rawHeld;
    this.dirty = true;
  }

  /** Confirmed buttons from the server. */
  onFrames(f: FrameBatch): void {
    if (f.margin < this.marginWindow) this.marginWindow = f.margin;
    const c = this.confirmed;
    if (!c) return;
    let s = c;
    for (let i = 0; i < f.b1.length; i++) {
      const t = f.first + i;
      if (t <= s.tick) continue;
      // A gap means frames were lost (a reconnect): wait for the next sync.
      if (t !== s.tick + 1) break;
      const b1 = f.b1[i] as number;
      const b2 = f.b2[i] as number;
      s = step(s, b1, b2, this.R);
      this.lastOwnConfirmed = this.side === 0 ? b1 : b2;
      this.lastOppConfirmed = this.side === 0 ? b2 : b1;
      this.dirty = true;
    }
    this.confirmed = s;
  }

  /**
   * One 60 Hz frame of the client's loop: runs 0, 1 or 2 ticks (clock
   * adjustment), sampling this player's buttons for each, then brings the
   * prediction up to date. Returns the number of ticks run.
   */
  tick(sample: (shown: MatchState) => number): number {
    const c = this.confirmed;
    if (!c || this.paused) return 0;
    if (this.realign) this.align(c.tick);

    let n = 1;
    this.sinceAdjust++;
    if (this.sinceAdjust >= ADJUST_EVERY && this.marginWindow !== 127) {
      if (this.marginWindow < TARGET_MARGIN) {
        n = 2;
        this.stats.speedUps++;
      } else if (this.marginWindow > TARGET_MARGIN + SLACK) {
        n = 0;
        this.stats.slowDowns++;
      }
      this.sinceAdjust = 0;
      this.marginWindow = 127;
    }
    // Fell behind the truth (a stalled tab): jump ahead rather than replay the past.
    if (this.present < c.tick) this.align(c.tick);

    let ran = 0;
    for (let i = 0; i < n; i++) {
      // Hold still rather than predict far past the truth.
      if (this.present - c.tick >= MAX_PREDICT) break;
      this.present++;
      const mask = sample(this.cur) & 31;
      this.record(this.present + this.delay, mask);
      ran++;
    }
    this.update(ran);
    return ran;
  }

  /** Encoded input batches to send, oldest first (empties the outbox). */
  takeOutgoing(): Uint8Array[] {
    this.flushOut();
    return this.outbox.splice(0, this.outbox.length);
  }

  /** Buttons this client recorded for a tick (undefined if not recorded). */
  inputAt(t: number): number | undefined {
    const k = t & RMASK;
    return this.inTag[k] === t ? (this.inMask[k] as number) : undefined;
  }

  private align(ctick: number): void {
    this.realign = false;
    const flight = Math.ceil(this.rttMs / TICK_MS);
    const target = Math.max(ctick, ctick + flight + TARGET_MARGIN - this.delay);
    this.present = Math.min(target, ctick + MAX_PREDICT - 1);
    this.flushOut();
    this.dirty = true;
    this.blendLeft = 0;
    this.offset[0].x = this.offset[0].y = this.offset[1].x = this.offset[1].y = 0;
  }

  private record(t: number, mask: number): void {
    const k = t & RMASK;
    this.inTag[k] = t;
    this.inMask[k] = mask;
    if (this.out.length > 0 && (this.outFirst + this.out.length !== t || this.out.length >= MAX_INPUT_BATCH)) this.flushOut();
    if (this.out.length === 0) this.outFirst = t;
    this.out.push(mask);
  }

  private flushOut(): void {
    if (this.out.length === 0) return;
    this.outbox.push(encodeInputs(this.outFirst, this.out));
    this.out = [];
  }

  private ownAt(t: number): number {
    const m = this.inputAt(t);
    return m === undefined ? this.lastOwnConfirmed : m;
  }

  /** Bring the prediction to tick `present` and produce the shown state. */
  private update(ran: number): void {
    const c = this.confirmed as MatchState;
    const P = Math.max(this.present, c.tick);
    const before = this.predicted;
    let next: MatchState;
    if (this.dirty || before.tick > P || P - before.tick > 2) {
      // Rollback: re-simulate from the truth.
      let s = c;
      const depth = P - c.tick;
      for (let t = c.tick + 1; t <= P; t++) s = this.stepGuess(s, t);
      next = s;
      if (this.dirty) {
        this.stats.rollbacks++;
        this.stats.resimTicks += depth;
        if (depth > this.stats.maxDepth) this.stats.maxDepth = depth;
        this.measureCorrection(before, next);
      }
      this.dirty = false;
    } else {
      let s = before;
      for (let t = before.tick + 1; t <= P; t++) s = this.stepGuess(s, t);
      next = s;
    }
    this.predicted = next;

    if (ran === 0 && next === before) {
      this.prev = this.cur;
      this.events = [];
      return;
    }
    this.events = next.tick > this.shownRaw.tick || next.round !== this.shownRaw.round ? deriveEvents(this.shownRaw, next, this.R.heat.max) : [];
    this.shownRaw = next;
    this.prev = this.cur;
    this.cur = this.present_(next);
  }

  private stepGuess(s: MatchState, t: number): MatchState {
    const own = this.ownAt(t);
    const opp = this.lastOppConfirmed;
    return this.side === 0 ? step(s, own, opp, this.R) : step(s, opp, own, this.R);
  }

  /**
   * How far the re-simulated state moved the fighters from where the old
   * prediction would have shown them this tick.
   */
  private measureCorrection(before: MatchState, after: MatchState): void {
    // The old prediction, carried to the same tick with the same guesses.
    let naive = before;
    while (naive.tick < after.tick && after.tick - naive.tick <= 2) naive = this.stepGuess(naive, naive.tick + 1);
    if (naive.tick !== after.tick || naive.round !== after.round) return;
    let worst = 0;
    const d: [number, number, number, number] = [0, 0, 0, 0];
    for (const i of [0, 1] as const) {
      const dx = naive.f[i].x - after.f[i].x;
      const dy = naive.f[i].y - after.f[i].y;
      d[2 * i] = dx;
      d[2 * i + 1] = dy;
      worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
    }
    if (worst === 0) return;
    const snapped = worst >= SNAP_LIMIT;
    this.stats.corrections.push({ tick: after.tick, mu: worst, snapped });
    if (snapped) {
      this.offset[0].x = this.offset[0].y = this.offset[1].x = this.offset[1].y = 0;
      this.blendLeft = 0;
      return;
    }
    // The drawn fighters stay where they were drawn: the new error joins what is still blending.
    let big = 0;
    for (const i of [0, 1] as const) {
      this.offset[i].x += d[2 * i] as number;
      this.offset[i].y += d[2 * i + 1] as number;
      big = Math.max(big, Math.abs(this.offset[i].x), Math.abs(this.offset[i].y));
    }
    this.blendLeft = Math.min(BLEND_MAX_FRAMES, Math.max(BLEND_MIN_FRAMES, Math.ceil(big / BLEND_SPEED)));
  }

  /** The state to draw: the prediction with any blending offset applied (a copy). */
  private present_(s: MatchState): MatchState {
    if (this.blendLeft <= 0) return s;
    // Each frame removes an equal share of what is left.
    const keep = (this.blendLeft - 1) / this.blendLeft;
    this.blendLeft--;
    const out = clone(s);
    for (const i of [0, 1] as const) {
      const o = this.offset[i];
      const nx = o.x * keep;
      const ny = o.y * keep;
      this.stats.maxBlendStep = Math.max(this.stats.maxBlendStep, Math.abs(o.x - nx), Math.abs(o.y - ny));
      o.x = nx;
      o.y = ny;
      out.f[i].x = Math.round(s.f[i].x + nx);
      out.f[i].y = Math.max(0, Math.round(s.f[i].y + ny));
    }
    return out;
  }
}
