/**
 * Server → client frame batching. Each frames message costs a socket write
 * per client, which is most of what a match costs the game server (a CPU
 * profile of 100 matches put socket writes far ahead of the sim itself).
 * Sending every FRAMES_EVERY ticks halves that for at most one extra tick
 * (~17 ms) before a confirmed input reaches the other player; prediction
 * covers it, and the net harness runs every netcode test through it.
 */
import { SYNC_EVERY, encodeFrames } from "./protocol";

/** Ticks per frames message. SYNC_EVERY is a multiple, so a batch never straddles a sync. */
export const FRAMES_EVERY = 2;

export class FrameBatcher {
  readonly every: number;
  private first = 0;
  private b1: number[] = [];
  private b2: number[] = [];

  constructor(every: number = FRAMES_EVERY) {
    if (!Number.isInteger(every) || every < 1 || SYNC_EVERY % every !== 0) throw new Error(`FrameBatcher: every must divide SYNC_EVERY (${SYNC_EVERY})`);
    this.every = every;
  }

  /** Add one stepped tick. True when the batch is due: full, or on a sync tick (frames go before the sync). */
  push(out: { tick: number; b1: number; b2: number }): boolean {
    if (this.b1.length === 0) this.first = out.tick;
    this.b1.push(out.b1);
    this.b2.push(out.b2);
    return this.b1.length >= this.every || out.tick % SYNC_EVERY === 0;
  }

  get pending(): boolean {
    return this.b1.length > 0;
  }

  /** Encode the pending ticks with this client's margin. Call once per client, then clear(). */
  encode(margin: number): Uint8Array {
    return encodeFrames({ first: this.first, b1: this.b1, b2: this.b2, margin });
  }

  clear(): void {
    this.b1 = [];
    this.b2 = [];
  }
}
