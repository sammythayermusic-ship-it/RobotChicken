/**
 * Integer helpers. The sim has exactly one division rule: truncate toward zero.
 * Truncation is mirror-symmetric (idiv(-a, b) === -idiv(a, b)), which keeps P1
 * and P2 behaving identically, and `| 0` also removes -0.
 */

let checks = false;
/** Enable division-by-zero assertions (tests). */
export function setFixedChecks(on: boolean): void {
  checks = on;
}

/** Whether integer / division checks are on (tests and the golden runner turn them on). */
export function fixedChecks(): boolean {
  return checks;
}

export function idiv(a: number, b: number): number {
  if (checks && b === 0) throw new Error("idiv by zero");
  // eslint-disable-next-line no-restricted-syntax -- the one division rule lives here
  return (a / b) | 0;
}

/** a * num / den, truncated. Inputs must keep a * num below 2^53. */
export function mulDiv(a: number, num: number, den: number): number {
  return idiv(a * num, den);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Sign as -1 / 0 / +1 without -0. */
export function sgn(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Normalize to an int32 with no -0. */
export function i32(v: number): number {
  return v | 0;
}
