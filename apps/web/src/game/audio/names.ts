/**
 * Every sound the game can play. Procedural recipes cover all of them; a file
 * at public/audio/<name>.m4a (listed in public/audio/manifest.json) overrides
 * the recipe once Sammy's sound pack lands.
 */
export const SOUND_NAMES = [
  "hit_light",
  "hit_heavy",
  "hit_slam",
  "hit_super",
  "block",
  "whiff_light",
  "whiff_heavy",
  "scream_light",
  "scream_medium",
  "scream_heavy",
  "scream_ko",
  "crowd_loop",
  "crowd_swell",
  "crowd_roar",
  "ko_horn",
  "round_bell",
  "countdown_tick",
  "fight",
  "ringout",
  "super_start",
  "heat_full",
  "dash",
  "jump",
  "land",
  "timeout",
  "win_jingle",
  "ui_move",
  "ui_select",
  "ui_back",
  "pause",
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export type Bus = "sfx" | "crowd" | "ui";

export interface SoundSpec {
  bus: Bus;
  gain: number;
  /** +-fraction of playbackRate jitter per play (deterministic). */
  pitchJitter: number;
  maxVoices: number;
  loop?: boolean;
}

export const SOUND_SPECS: Record<SoundName, SoundSpec> = {
  hit_light: { bus: "sfx", gain: 0.8, pitchJitter: 0.05, maxVoices: 4 },
  hit_heavy: { bus: "sfx", gain: 0.95, pitchJitter: 0.05, maxVoices: 4 },
  hit_slam: { bus: "sfx", gain: 1, pitchJitter: 0.03, maxVoices: 2 },
  hit_super: { bus: "sfx", gain: 1, pitchJitter: 0.02, maxVoices: 2 },
  block: { bus: "sfx", gain: 0.7, pitchJitter: 0.06, maxVoices: 4 },
  whiff_light: { bus: "sfx", gain: 0.35, pitchJitter: 0.08, maxVoices: 4 },
  whiff_heavy: { bus: "sfx", gain: 0.45, pitchJitter: 0.06, maxVoices: 3 },
  scream_light: { bus: "sfx", gain: 0.55, pitchJitter: 0.07, maxVoices: 2 },
  scream_medium: { bus: "sfx", gain: 0.65, pitchJitter: 0.06, maxVoices: 2 },
  scream_heavy: { bus: "sfx", gain: 0.75, pitchJitter: 0.05, maxVoices: 2 },
  scream_ko: { bus: "sfx", gain: 0.85, pitchJitter: 0.03, maxVoices: 1 },
  crowd_loop: { bus: "crowd", gain: 0.35, pitchJitter: 0, maxVoices: 1, loop: true },
  crowd_swell: { bus: "crowd", gain: 0.6, pitchJitter: 0.04, maxVoices: 2 },
  crowd_roar: { bus: "crowd", gain: 0.8, pitchJitter: 0.03, maxVoices: 1 },
  ko_horn: { bus: "sfx", gain: 0.8, pitchJitter: 0, maxVoices: 1 },
  round_bell: { bus: "sfx", gain: 0.7, pitchJitter: 0, maxVoices: 1 },
  countdown_tick: { bus: "ui", gain: 0.5, pitchJitter: 0, maxVoices: 1 },
  fight: { bus: "ui", gain: 0.7, pitchJitter: 0, maxVoices: 1 },
  ringout: { bus: "sfx", gain: 0.85, pitchJitter: 0, maxVoices: 1 },
  super_start: { bus: "sfx", gain: 0.9, pitchJitter: 0, maxVoices: 1 },
  heat_full: { bus: "ui", gain: 0.6, pitchJitter: 0, maxVoices: 2 },
  dash: { bus: "sfx", gain: 0.4, pitchJitter: 0.08, maxVoices: 2 },
  jump: { bus: "sfx", gain: 0.35, pitchJitter: 0.08, maxVoices: 2 },
  land: { bus: "sfx", gain: 0.45, pitchJitter: 0.08, maxVoices: 2 },
  timeout: { bus: "ui", gain: 0.7, pitchJitter: 0, maxVoices: 1 },
  win_jingle: { bus: "ui", gain: 0.7, pitchJitter: 0, maxVoices: 1 },
  ui_move: { bus: "ui", gain: 0.4, pitchJitter: 0, maxVoices: 2 },
  ui_select: { bus: "ui", gain: 0.5, pitchJitter: 0, maxVoices: 2 },
  ui_back: { bus: "ui", gain: 0.45, pitchJitter: 0, maxVoices: 2 },
  pause: { bus: "ui", gain: 0.45, pitchJitter: 0, maxVoices: 1 },
};
