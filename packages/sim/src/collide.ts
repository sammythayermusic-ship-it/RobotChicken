/**
 * Integer collision tests. All inputs are mu. Products stay below 2^53 thanks
 * to the bounding-box early-out (without it, cross-arena cross products reach
 * ~2.6e16).
 */

/** Capsule segment (ax,ay)-(bx,by) with radius r vs circle (cx,cy) radius q. */
export function capsuleHitsCircle(
  ax: number, ay: number, bx: number, by: number, r: number,
  cx: number, cy: number, q: number,
): boolean {
  const R = r + q;
  if (cx < Math.min(ax, bx) - R || cx > Math.max(ax, bx) + R) return false;
  if (cy < Math.min(ay, by) - R || cy > Math.max(ay, by) + R) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const wx = cx - ax;
  const wy = cy - ay;
  const wd = wx * dx + wy * dy;
  if (wd <= 0) return wx * wx + wy * wy <= R * R;
  const dd = dx * dx + dy * dy;
  if (wd >= dd) {
    const ex = cx - bx;
    const ey = cy - by;
    return ex * ex + ey * ey <= R * R;
  }
  const cr = wx * dy - wy * dx;
  return cr * cr <= R * R * dd;
}
