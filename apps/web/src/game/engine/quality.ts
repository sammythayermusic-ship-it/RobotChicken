/**
 * Quality tiers. antialias stays on in every tier (it can't change once the
 * context exists, and MSAA is cheap on tile-based mobile GPUs), so switching
 * tiers never recreates the renderer.
 */
export type QualityTier = "high" | "medium" | "low";

export interface QualitySettings {
  tier: QualityTier;
  dprCap: number;
  particles: boolean;
}

const KEY = "cockfight:quality:1";

export function qualitySettings(tier: QualityTier, devicePixelRatio: number): QualitySettings {
  switch (tier) {
    case "high":
      return { tier, dprCap: Math.min(devicePixelRatio, 1.5), particles: true };
    case "medium":
      return { tier, dprCap: Math.min(devicePixelRatio, 1.25), particles: true };
    case "low":
      // "half-res": half the device resolution, never below 0.5.
      return { tier, dprCap: Math.max(0.5, Math.min(devicePixelRatio, 2) * 0.5), particles: false };
  }
}

export function defaultTier(coarsePointer: boolean): QualityTier {
  return coarsePointer ? "medium" : "high";
}

export function loadTier(fallback: QualityTier): QualityTier {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === "high" || v === "medium" || v === "low" ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveTier(tier: QualityTier): void {
  try {
    globalThis.localStorage?.setItem(KEY, tier);
  } catch {
    // Private mode / blocked storage: the choice just doesn't persist.
  }
}
