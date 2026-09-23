/**
 * Voice bookkeeping and deterministic pitch jitter: pure, no WebAudio, so the
 * policies are unit-tested in node.
 */

/**
 * Fixed slots per sound. A new play takes a free slot, or steals the one
 * that started first (the most decayed, least noticeable to cut). Order is a
 * counter, not a timestamp: two plays in the same tick have the same
 * AudioContext time but still have an order.
 */
export class VoicePool {
  readonly capacity: number;
  /** Start order of the voice in each slot; 0 = free. */
  private readonly order: Float64Array;
  private seq = 0;
  /** True if the last acquire() had to steal a playing voice. */
  stole = false;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.order = new Float64Array(this.capacity);
  }

  acquire(): number {
    let oldest = 0;
    for (let i = 0; i < this.capacity; i++) {
      const o = this.order[i] as number;
      if (o === 0) {
        this.stole = false;
        this.order[i] = ++this.seq;
        return i;
      }
      if (o < (this.order[oldest] as number)) oldest = i;
    }
    this.stole = true;
    this.order[oldest] = ++this.seq;
    return oldest;
  }

  release(slot: number): void {
    if (slot >= 0 && slot < this.capacity) this.order[slot] = 0;
  }

  busy(slot: number): boolean {
    return (this.order[slot] ?? 0) !== 0;
  }

  get active(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.order[i] !== 0) n++;
    return n;
  }
}

/** 32-bit mix of two integers (murmur3 finalizer). */
export function mix32(a: number, b: number): number {
  let h = (a ^ Math.imul((b + 0x632be5ab) | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * playbackRate for one play: 1 +- `jitter`, chosen from the event seed so a
 * replay sounds identical. `salt` (the sound's index) decorrelates sounds
 * fired by the same event (a hit and its scream share a seed).
 */
export function pitchRate(jitter: number, seed: number, salt: number): number {
  if (!(jitter > 0)) return 1;
  const u = mix32(seed >>> 0, salt) / 4294967296;
  return 1 + jitter * (2 * u - 1);
}
