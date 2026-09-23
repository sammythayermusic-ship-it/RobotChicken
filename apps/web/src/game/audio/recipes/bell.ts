/**
 * The boxing-ring bell, struck twice ("ding-ding"): partials 1 / 2.0 / 2.76 /
 * 5.4 of 600 Hz (renderJuice.md §6), the low pair beating slightly the way a
 * real bell hums.
 */
import { click, modes, withReverb, type Recipe } from "../synth";

export const roundBell: Recipe = {
  seconds: 2.4,
  render(ctx, out, r) {
    const wet = withReverb(ctx, out, 1.2, 0.18, r, 0.5);
    for (const [t, level] of [
      [0.003, 1],
      [0.3, 0.85],
    ] as const) {
      click(ctx, wet, t, r, 0.35 * level, 3500, 0.003);
      modes(ctx, wet, t, 600, [1, 2.0, 2.76, 5.4, 8.1], [0.4 * level, 0.22 * level, 0.2 * level, 0.1 * level, 0.04 * level], [1.6, 1.1, 0.8, 0.35, 0.15], 0.0025);
    }
  },
};
