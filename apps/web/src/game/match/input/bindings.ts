import { B } from "@cockfight/sim";

/** Physical key (KeyboardEvent.code) -> [player, button bit]. */
export type Bindings = ReadonlyMap<string, readonly [0 | 1, number]>;

function map(entries: [string, 0 | 1, number][]): Bindings {
  return new Map(entries.map(([code, p, bit]) => [code, [p, bit] as const]));
}

/**
 * vs CPU: the spec's arrows + Space, with WASD + J as aliases.
 * Never bind Ctrl / Meta / Alt / Shift: Cmd+W closes the tab and five Shift
 * presses open Sticky Keys on Windows.
 */
export const SOLO: Bindings = map([
  ["ArrowLeft", 0, B.L],
  ["ArrowRight", 0, B.R],
  ["ArrowUp", 0, B.U],
  ["ArrowDown", 0, B.D],
  ["Space", 0, B.S],
  ["KeyA", 0, B.L],
  ["KeyD", 0, B.R],
  ["KeyW", 0, B.U],
  ["KeyS", 0, B.D],
  ["KeyJ", 0, B.S],
]);

/** Two players on one keyboard: P1 = WASD + Space (F), P2 = arrows + / (. Enter Numpad0). */
export const VERSUS: Bindings = map([
  ["KeyA", 0, B.L],
  ["KeyD", 0, B.R],
  ["KeyW", 0, B.U],
  ["KeyS", 0, B.D],
  ["Space", 0, B.S],
  ["KeyF", 0, B.S],
  ["ArrowLeft", 1, B.L],
  ["ArrowRight", 1, B.R],
  ["ArrowUp", 1, B.U],
  ["ArrowDown", 1, B.D],
  ["Slash", 1, B.S],
  ["Period", 1, B.S],
  ["Enter", 1, B.S],
  ["NumpadEnter", 1, B.S],
  ["Numpad0", 1, B.S],
]);

/** Human-readable labels for the controls panel. */
export const CONTROL_LABELS = {
  solo: { move: "← →", jump: "↑", block: "↓ (hold)", peck: "Space", alt: "WASD + J" },
  p1: { move: "A D", jump: "W", block: "S (hold)", peck: "Space / F" },
  p2: { move: "← →", jump: "↑", block: "↓ (hold)", peck: "/ . Enter" },
} as const;
