/** FNV-1a 32-bit over the UTF-16 code units of an ASCII string. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error("fnv1a32: ASCII only");
    h ^= c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seed for a match id; never zero (xorshift has a zero fixed point). */
export function seedFromId(id: string): number {
  return fnv1a32(id) || 0x9e3779b9;
}

/** One xorshift32 step. Returns the next state (uint32, never 0 for non-zero input). */
export function xorshift32(x: number): number {
  let v = x >>> 0;
  v ^= v << 13;
  v >>>= 0;
  v ^= v >>> 17;
  v ^= v << 5;
  return v >>> 0;
}

/** Tiny stateful wrapper for non-sim consumers (CPU, cosmetic effects). */
export class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.s = xorshift32(this.s);
    return this.s;
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return this.next() % n;
  }
  /** True with probability pct/100. */
  chance(pct: number): boolean {
    return this.int(100) < pct;
  }
}
