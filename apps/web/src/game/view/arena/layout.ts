import type { Object3D } from "three";

/**
 * Where things are in the junkyard, in game units (sim mu / 1000). The fight
 * plane is z = 0 and the camera looks from +z, so "back" is -z.
 *
 * Everything the rest of the game cares about is an ANCHOR (fire clusters,
 * crowd rows, the two ring edges). The procedural arena is built from
 * PROCEDURAL_ANCHORS; Sammy's arena.glb supplies the same anchors as named
 * empties (see README.md and anchorsFromScene), so fires, crowd and lights
 * keep working when the procedural geometry is swapped out.
 */

/** Ring-out edge (moves.json `ringEdge` = 10000 mu). The lip's outer edge sits exactly here. */
export const RING_EDGE = 10;
/** Walking stops at 9.5 (moves.json `wallEdge`); the hazard band starts just inside. */
export const HAZARD_IN = 9.05;
/**
 * Inner edge of the lip: a striped steel strip FLUSH with the pit floor. A
 * ring-out shove that falls short leaves a fighter standing anywhere up to
 * x = 10 (walls stop outward motion only), so nothing inside the ring edge may
 * be raised: a curb there would bury the feet and the blob shadow.
 */
export const LIP_IN = 9.78;
/** The drop-off beyond the lip: its far wall, and how deep the dark goes. */
export const CHASM_FAR = 12.6;
export const CHASM_DEPTH = 34;
/**
 * The pit floor runs from the car wall at the back to well past the camera. A
 * portrait phone (aspect 0.45) pulls the camera ~94 u back to fit both
 * fighters at the walls, and its bottom edge meets the floor ~19 u in front
 * of the lens (z ~ 75); 130 leaves room for narrower screens.
 */
export const PIT_BACK = -7.4;
export const PIT_FRONT = 130;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A row of seated crowd: `count` chickens spread from `from` to `to` (feet positions). */
export interface CrowdRow {
  from: Vec3Like;
  to: Vec3Like;
  count: number;
}

export interface FireCluster {
  /** Light / glow centre (above the drums). */
  light: Vec3Like;
  /** Drum base positions; the flames sit on top of each. */
  drums: Vec3Like[];
}

export interface Floodlight {
  /** Lamp bank centre. */
  pos: Vec3Like;
  /** Where the beam lands. */
  target: Vec3Like;
}

export interface ArenaAnchors {
  /** Left (-x) cluster first. Each cluster drives one flickering PointLight. */
  fires: [FireCluster, FireCluster];
  crowd: CrowdRow[];
  floods: Floodlight[];
  /** x of the ring edges; must be -RING_EDGE / +RING_EDGE (the sim decides ring-outs, not the art). */
  ringEdge: [number, number];
}

const v = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });

/** Amber warning beacons on posts at the back corners of the lip (they mark the ring edge). */
export const BEACONS: readonly Vec3Like[] = [
  { x: -(RING_EDGE + 0.3), y: 1.25, z: PIT_BACK + 0.45 },
  { x: RING_EDGE + 0.3, y: 1.25, z: PIT_BACK + 0.45 },
];

/** Bleacher rows: first seat, rise and depth per row. */
export const BLEACH = { rows: 8, z0: -12.2, dz: -0.95, y0: 2.3, dy: 0.5, halfW: 20, crowdHalfW: 17 } as const;

export const PROCEDURAL_ANCHORS: ArenaAnchors = {
  fires: [
    { light: v(-7.3, 2.1, -5.7), drums: [v(-8.35, 0, -5.55), v(-7.3, 0, -6.35), v(-6.35, 0, -5.45)] },
    { light: v(7.3, 2.1, -5.7), drums: [v(6.35, 0, -5.45), v(7.3, 0, -6.35), v(8.35, 0, -5.55)] },
  ],
  crowd: Array.from({ length: BLEACH.rows }, (_, i) => {
    const y = BLEACH.y0 + BLEACH.dy * i;
    const z = BLEACH.z0 + BLEACH.dz * i - 0.15;
    return { from: v(-BLEACH.crowdHalfW, y, z), to: v(BLEACH.crowdHalfW, y, z), count: 30 };
  }),
  floods: [
    { pos: v(-14.6, 8.6, -10.6), target: v(-2.6, 0, -0.8) },
    { pos: v(14.6, 8.6, -10.6), target: v(2.6, 0, -0.8) },
  ],
  ringEdge: [-RING_EDGE, RING_EDGE],
};

/**
 * Read anchors from a loaded arena.glb (the swap path in README.md). Empties:
 * `fire_L*` / `fire_R*` (one per drum; the cluster light sits 2.1 above their
 * mean), `crowd_<n>_a` / `crowd_<n>_b` (row endpoints, `count` custom property,
 * default 30), `flood_<n>` with a child `flood_<n>_target`, and `ringedge_L` /
 * `ringedge_R`. Missing groups fall back to the procedural layout.
 */
export function anchorsFromScene(root: Object3D): ArenaAnchors {
  root.updateMatrixWorld(true);
  const at = (o: Object3D): Vec3Like => {
    const e = o.matrixWorld.elements;
    return v(e[12] as number, e[13] as number, e[14] as number);
  };
  const byName = new Map<string, Object3D>();
  root.traverse((o) => {
    if (o.name) byName.set(o.name, o);
  });
  const named = (re: RegExp) =>
    [...byName.entries()]
      .filter(([n]) => re.test(n))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, o]) => o);

  const cluster = (side: "L" | "R", fallback: FireCluster): FireCluster => {
    const drums = named(new RegExp(`^fire_${side}`)).map(at);
    if (!drums.length) return fallback;
    const c = drums.reduce((a, d) => v(a.x + d.x / drums.length, a.y + d.y / drums.length, a.z + d.z / drums.length), v(0, 0, 0));
    return { light: v(c.x, c.y + 2.1, c.z), drums };
  };

  const crowd: CrowdRow[] = [];
  for (const a of named(/^crowd_\d+_a$/)) {
    const b = byName.get(a.name.replace(/_a$/, "_b"));
    if (!b) continue;
    const count = Number((a.userData as { count?: unknown }).count ?? 30);
    crowd.push({ from: at(a), to: at(b), count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 30 });
  }

  const floods: Floodlight[] = [];
  for (const f of named(/^flood_\d+$/)) {
    const t = byName.get(`${f.name}_target`);
    if (t) floods.push({ pos: at(f), target: at(t) });
  }

  const edgeL = byName.get("ringedge_L");
  const edgeR = byName.get("ringedge_R");
  return {
    fires: [cluster("L", PROCEDURAL_ANCHORS.fires[0]), cluster("R", PROCEDURAL_ANCHORS.fires[1])],
    crowd: crowd.length ? crowd : PROCEDURAL_ANCHORS.crowd,
    floods: floods.length ? floods : PROCEDURAL_ANCHORS.floods,
    ringEdge: [edgeL ? at(edgeL).x : -RING_EDGE, edgeR ? at(edgeR).x : RING_EDGE],
  };
}

/** The art must put the ring edges where the sim does; a glb that disagrees is rejected. */
export function checkRingEdges(a: ArenaAnchors, tolerance = 0.05): string | null {
  const [l, r] = a.ringEdge;
  if (Math.abs(l + RING_EDGE) > tolerance || Math.abs(r - RING_EDGE) > tolerance) {
    return `ringedge_L/R must sit at x = ∓${RING_EDGE} (got ${l.toFixed(2)}, ${r.toFixed(2)})`;
  }
  return null;
}
