/**
 * Height (CSS px) of the fight HUD's top band (components/hud/FightHud.tsx):
 * names and round pips, HP bar, Heat bar and "SUPER READY" on each side, the
 * timer and round label in the middle. Tailwind's `sm` breakpoint (640 px)
 * switches the larger text and bars on. The camera keeps every fighter below
 * this band; e2e/arena.spec.ts measures the real HUD against these numbers so
 * they can't drift from the layout.
 */
export const HUD_BAND_PX = { narrow: 88, wide: 112 } as const;

export function hudBandPx(widthPx: number): number {
  return widthPx >= 640 ? HUD_BAND_PX.wide : HUD_BAND_PX.narrow;
}

/** Share of the viewport height the HUD band covers (0..0.4). */
export function hudFraction(widthPx: number, heightPx: number): number {
  if (!(heightPx > 0)) return 0.14;
  return Math.min(0.4, hudBandPx(widthPx) / heightPx);
}
