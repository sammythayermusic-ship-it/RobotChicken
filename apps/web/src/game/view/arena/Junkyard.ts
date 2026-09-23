import { Group, Mesh, type Material, type Vector3, type WebGLRenderer } from "three";
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
  readonly stats: { triangles: number; drawCalls: number; crowd: number };
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
  root.add(sky, floor.mesh, props.mesh, crowd.mesh, crowd.flashes, fires.mesh, beams, ...fires.lights);
  const envScene = buildEnvScene(anchors);

  const crowdTris = crowd.count * 4; // silhouettes + flash pass
  const fireTris = fires.mesh.geometry.instanceCount * 2;
  const beamTris = (beams.geometry.index?.count ?? 0) / 3;
  const skyTris = (sky.geometry.index?.count ?? 0) / 3;
  let drawCalls = 0;
  root.traverse((o) => {
    if (o instanceof Mesh) drawCalls++;
  });
  const stats = {
    triangles: floor.triangles + props.triangles + crowdTris + fireTris + beamTris + skyTris,
    drawCalls,
    crowd: crowd.count,
  };

  let disposed = false;
  const [fireL, fireR] = u.uFireCol.value as [Vector3, Vector3];
  const view: JunkyardView = {
    root,
    envScene,
    stats,
    setHype(h: number) {
      u.uHype.value = h < 0 ? 0 : h > 1 ? 1 : h;
    },
    update(_dt: number, t: number) {
      const fl = flicker(11, t);
      const fr = flicker(23, t);
      u.uTime.value = t;
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
