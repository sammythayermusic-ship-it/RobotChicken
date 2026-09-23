/**
 * Every SoundName's procedural recipe, and the order they are rendered in.
 * Loaded with a dynamic import from createAudio(), so none of this is in the
 * /play page bundle until the FIGHT click.
 */
import type { SoundName } from "../names";
import type { Recipe } from "../synth";
import { roundBell } from "./bell";
import { crowdLoop, crowdRoar, crowdSwell } from "./crowd";
import { koHorn, superStart, timeout } from "./horn";
import { block, dash, hitHeavy, hitLight, hitSlam, hitSuper, jump, land, ringout, whiffHeavy, whiffLight } from "./metal";
import { screamHeavy, screamKo, screamLight, screamMedium } from "./scream";
import { countdownTick, fight, heatFull, pause, uiBack, uiMove, uiSelect, winJingle } from "./ui";

export const RECIPES: Record<SoundName, Recipe> = {
  hit_light: hitLight,
  hit_heavy: hitHeavy,
  hit_slam: hitSlam,
  hit_super: hitSuper,
  block,
  whiff_light: whiffLight,
  whiff_heavy: whiffHeavy,
  scream_light: screamLight,
  scream_medium: screamMedium,
  scream_heavy: screamHeavy,
  scream_ko: screamKo,
  crowd_loop: crowdLoop,
  crowd_swell: crowdSwell,
  crowd_roar: crowdRoar,
  ko_horn: koHorn,
  round_bell: roundBell,
  countdown_tick: countdownTick,
  fight,
  ringout,
  super_start: superStart,
  heat_full: heatFull,
  dash,
  jump,
  land,
  timeout,
  win_jingle: winJingle,
  ui_move: uiMove,
  ui_select: uiSelect,
  ui_back: uiBack,
  pause,
};

/**
 * Render order: what the first seconds of a fight need (countdown, FIGHT,
 * the common hit / scream / whiff / block), then the crowd bed, then rarer
 * and longer sounds. A sound played before its buffer exists is skipped, so
 * this order is what keeps the first exchange from being silent.
 */
export const RENDER_ORDER: readonly SoundName[] = [
  "countdown_tick",
  "hit_light",
  "scream_light",
  "whiff_light",
  "block",
  "fight",
  "round_bell",
  "hit_heavy",
  "scream_medium",
  "whiff_heavy",
  "dash",
  "jump",
  "land",
  "crowd_loop",
  "scream_heavy",
  "hit_slam",
  "super_start",
  "hit_super",
  "heat_full",
  "crowd_swell",
  "scream_ko",
  "ko_horn",
  "crowd_roar",
  "ringout",
  "timeout",
  "win_jingle",
  "pause",
  "ui_move",
  "ui_select",
  "ui_back",
];

/** The sounds that must be ready before the first exchange ("first hits ready" in the render log). */
export const FIRST_HITS: readonly SoundName[] = ["countdown_tick", "hit_light", "scream_light", "whiff_light", "block"];
