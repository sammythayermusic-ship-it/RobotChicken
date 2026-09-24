/**
 * Height (CSS px) of the fight HUD's top band (components/hud/FightHud.tsx):
 * names and round pips, HP bar, Heat bar and "SUPER READY" on each side, the
 * timer and round label in the middle. The HUD picks its size from the fight
 * area's box (container queries, app/globals.css), not the window:
 *  - wide:   640 px wide and 480 px tall or more (desktops, tablets);
 *  - short:  640 px wide but under 480 px tall (phones held sideways), a
 *            compact band so the fight keeps most of a short screen;
 *  - narrow: under 640 px wide (portrait phones).
 * The camera keeps every fighter below this band; e2e/arena.spec.ts measures
 * the real HUD against these numbers so they can't drift from the layout.
 */
export const HUD_BAND_PX = { narrow: 88, short: 72, wide: 112 } as const;
/** The container-query breakpoints (globals.css `hud-wide` / `hud-short` must match). */
export const HUD_WIDE_MIN_W = 640;
export const HUD_WIDE_MIN_H = 480;

export function hudBandPx(widthPx: number, heightPx = Infinity): number {
  if (widthPx < HUD_WIDE_MIN_W) return HUD_BAND_PX.narrow;
  return heightPx < HUD_WIDE_MIN_H ? HUD_BAND_PX.short : HUD_BAND_PX.wide;
}

/** Share of the viewport height the HUD band covers (0..0.4). */
export function hudFraction(widthPx: number, heightPx: number): number {
  if (!(heightPx > 0)) return 0.14;
  return Math.min(0.4, hudBandPx(widthPx, heightPx) / heightPx);
}

/**
 * The share of on-screen buttons' height (over the bottom of the canvas) the
 * camera keeps clear. The buttons sit in the bottom corners, so the whole
 * height would cost far more than it saves: the chickens would shrink by a
 * quarter on a phone held sideways.
 */
export const INSET_SHARE = 0.6;

/** Bottom share of the viewport the camera keeps the fighters' feet above (0..0.3). */
export function insetFraction(insetPx: number, heightPx: number): number {
  if (!(heightPx > 0) || !(insetPx > 0)) return 0;
  return Math.min(0.3, (INSET_SHARE * insetPx) / heightPx);
}
