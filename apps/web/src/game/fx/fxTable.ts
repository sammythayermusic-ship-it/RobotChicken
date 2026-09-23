/**
 * One table from sim events to presentation: sounds, particles, camera
 * trauma / punch and crowd hype. The director applies it; nothing else
 * decides what a hit looks or sounds like.
 */
import { Mv, type MvId, type SimEvent, type SimEventKind } from "@cockfight/sim";
import type { SoundName } from "../audio/names";

export type ParticleKind = "spark" | "screw" | "feather" | "dust" | "flash" | "trail";

export interface Burst {
  kind: ParticleKind;
  count: number;
}

export interface FxRecipe {
  sounds: SoundName[];
  bursts: Burst[];
  /** Camera trauma added (0..1). */
  trauma: number;
  /** Camera dolly-in punch (units). */
  punch: number;
  /** Crowd hype spike (0..1). */
  hype: number;
}

const none: FxRecipe = { sounds: [], bursts: [], trauma: 0, punch: 0, hype: 0 };

/** Scream tier by damage in HP% (spec: a chicken scream per damage tier). */
export function screamFor(damagePct: number, move: MvId): SoundName {
  if (move === Mv.slam || move === Mv.super || damagePct > 15) return "scream_heavy";
  if (damagePct >= 8) return "scream_medium";
  return "scream_light";
}

/** Presentation for a hit event. */
export function hitRecipe(e: Extract<SimEvent, { kind: "hit" }>, hpMax: number): FxRecipe {
  const pct = (e.damage * 100) / hpMax;
  if (e.blocked) {
    return { sounds: ["block"], bursts: [{ kind: "spark", count: 10 }, { kind: "flash", count: 1 }], trauma: 0.12, punch: 0.1, hype: 0.05 };
  }
  const heavy = e.move === Mv.slam || e.move === Mv.super;
  const hitSound: SoundName = e.move === Mv.super ? "hit_super" : e.move === Mv.slam ? "hit_slam" : pct >= 8 ? "hit_heavy" : "hit_light";
  return {
    sounds: [hitSound, screamFor(pct, e.move)],
    bursts: [
      { kind: "spark", count: heavy ? 48 : 22 },
      { kind: "screw", count: heavy ? 8 : 3 },
      { kind: "feather", count: heavy ? 14 : 6 },
      { kind: "flash", count: 1 },
    ],
    trauma: e.move === Mv.super ? 0.7 : e.move === Mv.slam ? 0.7 : pct >= 8 ? 0.45 : 0.25,
    punch: Math.min(1.2, 0.04 * pct + (heavy ? 0.4 : 0.1)),
    hype: heavy ? 0.5 : 0.15,
  };
}

/** Presentation for every non-hit event kind. */
export const FX_TABLE: Record<Exclude<SimEventKind, "hit">, (e: SimEvent) => FxRecipe> = {
  countdown: () => ({ ...none, sounds: ["countdown_tick"] }),
  fight: () => ({ ...none, sounds: ["fight", "round_bell"], hype: 0.3 }),
  attack: (e) => {
    const move = e.kind === "attack" ? e.move : Mv.none;
    if (move === Mv.super) return { ...none, sounds: ["super_start"], trauma: 0.2, hype: 0.4 };
    return { ...none, sounds: [move === Mv.slam || move === Mv.shove ? "whiff_heavy" : "whiff_light"] };
  },
  jump: () => ({ ...none, sounds: ["jump"], bursts: [{ kind: "dust", count: 6 }] }),
  land: (e) => {
    const heavy = e.kind === "land" && e.heavy;
    return { ...none, sounds: ["land"], bursts: [{ kind: "dust", count: heavy ? 18 : 8 }], trauma: heavy ? 0.2 : 0 };
  },
  dash: () => ({ ...none, sounds: ["dash"], bursts: [{ kind: "dust", count: 8 }] }),
  heatFull: () => ({ ...none, sounds: ["heat_full", "crowd_swell"], hype: 0.4 }),
  ko: () => ({ ...none, sounds: ["scream_ko", "ko_horn", "crowd_roar"], bursts: [{ kind: "screw", count: 20 }, { kind: "feather", count: 30 }], trauma: 1, punch: 0.6, hype: 1 }),
  ringOut: () => ({ ...none, sounds: ["ringout", "crowd_roar"], trauma: 0.6, hype: 1 }),
  suddenDeath: () => ({ ...none, sounds: ["round_bell"], hype: 0.6 }),
  roundEnd: (e) => ({ ...none, sounds: e.kind === "roundEnd" && e.reason === 3 ? ["timeout"] : [] }),
  roundStart: () => none,
  matchEnd: () => ({ ...none, sounds: ["win_jingle"], hype: 0.8 }),
};

export function recipeFor(e: SimEvent, hpMax: number): FxRecipe {
  if (e.kind === "hit") return hitRecipe(e, hpMax);
  return FX_TABLE[e.kind](e);
}
