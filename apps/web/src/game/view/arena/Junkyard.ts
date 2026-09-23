import { Group, Mesh, type Material, type Vector3, type WebGLRenderer } from "three";
import type { QualityTier } from "../../engine/quality";
import type { ArenaView } from "../FightView";
import { buildBeams } from "./beams";
import { buildCrowd } from "./crowd";
import { buildEnvScene, disposeEnvScene } from "./env";
import { buildFires } from "./fires";
import { buildFloor } from "./floor";
import { checkRingEdges, PROCEDURAL_ANCHORS, type ArenaAnchors } from "./layout";
import { createUniforms, FIRE_COL, FIRE_I, flicker } from "./lighting";
import { buildProps } from "./props";
import { buildSky } from "./sky";

/** Extra introspection for tests and the perf budget (not part of ArenaView). */
export interface JunkyardView extends ArenaView {
  /** What the arena draws at the current quality tier. */
  readonly stats: { triangles: number; drawCalls: number; crowd: number; fireInstances: number };
  setQuality(tier: QualityTier): void;
}

/**
 * The procedural junkyard pit (0 bytes of assets): a concrete floor with a
 * striped lip at x = +/-10 and a drop-off into darkness beyond it, walls of
 * crushed cars, tire stacks, six oil-drum fires (2 flickering PointLights),
 * floodlight towers, bleachers packed with a silhouetted robot-chicken crowd
 * that bobs with the director's hype, and a smoggy skyline.
 *
 * Seven draw calls: sky, floor, props, crowd, crowd flashes, fire, beams. update() only writes
 * uniforms and two light intensities (no allocations).
 *
 * Quality 'low' ("no particles, half-res") also drops the arena's own
 * particles: the smoke and embers (the flames and halos stay, so the drums
 * still read as fires), the crowd's camera-flash pass (one draw call) and the
 * haze sheet. Nothing is rebuilt or recompiled: an instance count, a draw
 * range and a visibility flag.
 */
export async function createJunkyard(renderer: WebGLRenderer, anchors: ArenaAnchors = PROCEDURAL_ANCHORS): Promise<JunkyardView> {
  const bad = checkRingEdges(anchors);
  if (bad) throw new Error(`[arena] ${bad}`);
  const root = new Group();
  root.name = "junkyard";
  const u = createUniforms(anchors);
  const floods = Math.max(1, anchors.floods.length);

  const sky = buildSky(u.uTime);
  const floor = buildFloor(u, floods);
  const props = buildProps(u, anchors);
  const crowd = buildCrowd(anchors.crowd, u, renderer.capabilities.getMaxAnisotropy());
  const fires = buildFires(anchors.fires, u);
  const beams = buildBeams(anchors.floods, props.bulbs, u.uTime);
  root.add(sky, floor.mesh, props.mesh, crowd.mesh, crowd.flashes, fires.mesh, beams.mesh, ...fires.lights);
  const envScene = buildEnvScene(anchors);

  const skyTris = (sky.geometry.index?.count ?? 0) / 3;
  const stats = () => {
    let drawCalls = 0;
    root.traverse((o) => {
      if (o instanceof Mesh && o.visible) drawCalls++;
    });
    const beamGeo = beams.mesh.geometry;
    const beamTris = Math.min(beamGeo.drawRange.count, beamGeo.index?.count ?? 0) / 3;
    const fireInstances = fires.mesh.geometry.instanceCount;
    // Crowd: 2 triangles per silhouette, again for the flash pass when it draws.
    const crowdTris = crowd.count * 2 * (crowd.flashes.visible ? 2 : 1);
    return {
      triangles: floor.triangles + props.triangles + crowdTris + fireInstances * 2 + beamTris + skyTris,
      drawCalls,
      crowd: crowd.count,
      fireInstances,
    };
  };

  let disposed = false;
  const [fireL, fireR] = u.uFireCol.value as [Vector3, Vector3];
  const view: JunkyardView = {
    root,
    envScene,
    get stats() {
      return stats();
    },
    setQuality(tier: QualityTier) {
      const full = tier !== "low";
      fires.setAmbient(full);
      beams.setHaze(full);
      crowd.flashes.visible = full;
    },
    setHype(h: number) {
      u.uHype.value = h < 0 ? 0 : h > 1 ? 1 : h;
    },
    update(dt: number, t: number) {
      const fl = flicker(11, t);
      const fr = flicker(23, t);
      u.uTime.value = t;
      crowd.update(dt, u.uHype.value);
      u.uFlick.value.set(fl, fr);
      fireL.set(FIRE_COL.r, FIRE_COL.g, FIRE_COL.b).multiplyScalar(FIRE_I * fl);
      fireR.set(FIRE_COL.r, FIRE_COL.g, FIRE_COL.b).multiplyScalar(FIRE_I * fr);
      fires.update(fl, fr);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          (o.material as Material).dispose();
        }
      });
      for (const l of fires.lights) l.dispose();
      crowd.texture.dispose();
      disposeEnvScene(envScene);
      root.removeFromParent();
    },
  };
  view.update(0, 0);
  return view;
}
