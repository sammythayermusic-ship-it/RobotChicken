import { Color, MeshPhysicalMaterial, MeshStandardMaterial, type Material } from "three";
import type { Tier } from "@cockfight/shared";

/**
 * Cosmetic tiers are material swaps on the one chicken mesh (cosmetics only,
 * never stats). Only the tier slots change; beak and comb keep the authored look.
 */
export const TIER_SLOTS = ["cf_shell", "cf_trim", "cf_eye"] as const;

interface Look {
  shell: { color: number; metalness: number; roughness: number; iridescence?: number; clearcoat?: number };
  trim: { color: number; metalness: number; roughness: number };
  eye: { color: number; emissive: number };
}

export const TIER_LOOKS: Record<Tier, Look> = {
  rust: {
    shell: { color: 0x8a3b22, metalness: 0.6, roughness: 0.8 },
    trim: { color: 0x4a3a30, metalness: 0.7, roughness: 0.7 },
    eye: { color: 0x551111, emissive: 0x991a0a },
  },
  chrome: {
    shell: { color: 0xd8dde6, metalness: 1, roughness: 0.12 },
    trim: { color: 0x9aa4b2, metalness: 1, roughness: 0.2 },
    eye: { color: 0x113355, emissive: 0x2a8cff },
  },
  gold: {
    shell: { color: 0xffc757, metalness: 1, roughness: 0.25 },
    trim: { color: 0xb8862b, metalness: 1, roughness: 0.3 },
    eye: { color: 0x553300, emissive: 0xffc23a },
  },
  diamond: {
    shell: { color: 0xe8f4ff, metalness: 0.2, roughness: 0.05, iridescence: 1, clearcoat: 1 },
    trim: { color: 0xbfd8ff, metalness: 0.9, roughness: 0.1 },
    eye: { color: 0x220044, emissive: 0xc27bff },
  },
};

/** Build the three tier materials; `hueShift` gives P2 a readable alternate palette in mirror matches. */
export function tierMaterials(tier: Tier, hueShift = 0): Record<(typeof TIER_SLOTS)[number], Material> {
  const look = TIER_LOOKS[tier];
  // Mirror matches need two readable chickens. A hue shift works for colourful
  // tiers; greys (chrome, diamond) don't have a hue, so tint them copper instead.
  const hsl = { h: 0, s: 0, l: 0 };
  const shift = (hex: number) => {
    const c = new Color(hex);
    if (!hueShift) return c;
    c.getHSL(hsl);
    if (hsl.s < 0.25) c.lerp(new Color(0xd9824f), 0.45);
    else c.offsetHSL(hueShift, 0, 0);
    return c;
  };
  const shell =
    look.shell.iridescence !== undefined
      ? new MeshPhysicalMaterial({
          color: shift(look.shell.color),
          metalness: look.shell.metalness,
          roughness: look.shell.roughness,
          iridescence: look.shell.iridescence,
          iridescenceIOR: 1.6,
          clearcoat: look.shell.clearcoat ?? 0,
        })
      : new MeshStandardMaterial({ color: shift(look.shell.color), metalness: look.shell.metalness, roughness: look.shell.roughness });
  shell.name = "cf_shell";
  const trim = new MeshStandardMaterial({ color: shift(look.trim.color), metalness: look.trim.metalness, roughness: look.trim.roughness });
  trim.name = "cf_trim";
  const eye = new MeshStandardMaterial({ color: look.eye.color, emissive: shift(look.eye.emissive), emissiveIntensity: 2.2, roughness: 0.3 });
  eye.name = "cf_eye";
  return { cf_shell: shell, cf_trim: trim, cf_eye: eye };
}
