/**
 * FNV-1a 64-bit computed in two 32-bit lanes (no BigInt, ~4x faster).
 * prime = 2^40 + 0x1b3, so h * prime = h * 0x1b3 + (lo << 40) mod 2^64.
 */
const OFF_HI = 0xcbf29ce4;
const OFF_LO = 0x84222325;

export interface Fnv64 {
  hi: number;
  lo: number;
}

export function fnvInit(): Fnv64 {
  return { hi: OFF_HI, lo: OFF_LO };
}

function byte(h: Fnv64, b: number): void {
  const lo = (h.lo ^ b) >>> 0;
  const m = lo * 0x1b3;
  const nlo = m >>> 0;
  // Exact: m < 2^41, so m / 2^32 is exact in a double and >>> 0 truncates it.
  // eslint-disable-next-line no-restricted-syntax -- not gameplay arithmetic
  const carry = (m / 4294967296) >>> 0;
  h.hi = (Math.imul(h.hi, 0x1b3) + carry + (lo << 8)) >>> 0;
  h.lo = nlo;
}

/** Feed one int32 as 4 little-endian bytes. */
export function fnvInt(h: Fnv64, v: number): void {
  const u = v >>> 0;
  byte(h, u & 0xff);
  byte(h, (u >>> 8) & 0xff);
  byte(h, (u >>> 16) & 0xff);
  byte(h, (u >>> 24) & 0xff);
}

export function fnvInts(h: Fnv64, a: ArrayLike<number>): void {
  for (let i = 0; i < a.length; i++) fnvInt(h, a[i] as number);
}

/** 16 hex chars, big-endian (hi then lo). */
export function fnvHex(h: Fnv64): string {
  return h.hi.toString(16).padStart(8, "0") + h.lo.toString(16).padStart(8, "0");
}

export function hashInts(a: ArrayLike<number>): string {
  const h = fnvInit();
  fnvInts(h, a);
  return fnvHex(h);
}

/** Byte-level variant (for tests against a reference implementation). */
export function hashBytes(bytes: ArrayLike<number>): string {
  const h = fnvInit();
  for (let i = 0; i < bytes.length; i++) byte(h, (bytes[i] as number) & 0xff);
  return fnvHex(h);
}
