import { BoxGeometry, Group, Matrix4, Object3D, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { RULES } from "@cockfight/sim";
import { GeoBuilder } from "./builder";
import { buildFloor } from "./floor";
import { anchorsFromScene, checkRingEdges, HAZARD_IN, LIP_IN, PROCEDURAL_ANCHORS, RING_EDGE } from "./layout";
import { createUniforms, flicker } from "./lighting";
import { buildProps } from "./props";

describe("arena layout", () => {
  it("puts the lip's outer face exactly on the sim's ring edge, and the hazard band inside the walk limit", () => {
    expect(RING_EDGE * 1000).toBe(RULES.match.ringEdge);
    expect(PROCEDURAL_ANCHORS.ringEdge).toEqual([-RING_EDGE, RING_EDGE]);
    expect(checkRingEdges(PROCEDURAL_ANCHORS)).toBeNull();
    // Fighters walk to wallEdge (9.5): the stripes start before it, the lip after it.
    expect(HAZARD_IN * 1000).toBeLessThan(RULES.match.wallEdge);
    expect(LIP_IN * 1000).toBeGreaterThan(RULES.match.wallEdge);
  });

  it("seats about 240 in the crowd and has two fire clusters of drums", () => {
    const seats = PROCEDURAL_ANCHORS.crowd.reduce((n, r) => n + r.count, 0);
    expect(seats).toBeGreaterThanOrEqual(220);
    expect(seats).toBeLessThanOrEqual(260);
    expect(PROCEDURAL_ANCHORS.fires[0].drums.length + PROCEDURAL_ANCHORS.fires[1].drums.length).toBe(6);
    expect(PROCEDURAL_ANCHORS.fires[0].light.x).toBeLessThan(0);
    expect(PROCEDURAL_ANCHORS.fires[1].light.x).toBeGreaterThan(0);
  });
});

describe("arena.glb swap path (named empties)", () => {
  const empty = (name: string, x: number, y: number, z: number, parent: Object3D, userData: Record<string, unknown> = {}) => {
    const o = new Object3D();
    o.name = name;
    o.position.set(x, y, z);
    o.userData = userData;
    parent.add(o);
    return o;
  };

  it("reads fire, crowd, flood and ring-edge anchors in world space", () => {
    const root = new Group();
    const arena = new Group();
    arena.position.set(0, 0, -1); // parents are respected
    root.add(arena);
    empty("fire_L1", -8, 0, -5, arena);
    empty("fire_L2", -6, 0, -5, arena);
    empty("fire_R1", 7, 0, -5, arena);
    empty("crowd_0_a", -10, 3, -12, arena, { count: 12 });
    empty("crowd_0_b", 10, 3, -12, arena);
    empty("crowd_1_a", -10, 4, -13, arena); // no count: default 30
    empty("crowd_1_b", 10, 4, -13, arena);
    empty("crowd_2_a", -10, 5, -14, arena); // no _b partner: ignored
    const flood = empty("flood_0", -14, 9, -10, arena);
    empty("flood_0_target", 12, -9, 9, flood); // child of the lamp: local offset
    empty("ringedge_L", -10, 0, 0, root);
    empty("ringedge_R", 10, 0, 0, root);

    const a = anchorsFromScene(root);
    expect(a.fires[0].drums).toEqual([
      { x: -8, y: 0, z: -6 },
      { x: -6, y: 0, z: -6 },
    ]);
    expect(a.fires[0].light).toEqual({ x: -7, y: 2.1, z: -6 });
    expect(a.fires[1].drums).toHaveLength(1);
    expect(a.crowd.map((r) => r.count)).toEqual([12, 30]);
    expect(a.crowd[0]?.from).toEqual({ x: -10, y: 3, z: -13 });
    expect(a.floods).toEqual([{ pos: { x: -14, y: 9, z: -11 }, target: { x: -2, y: 0, z: -2 } }]);
    expect(a.ringEdge).toEqual([-10, 10]);
    expect(checkRingEdges(a)).toBeNull();
  });

  it("falls back to the procedural layout for missing groups and rejects a misplaced ring edge", () => {
    const root = new Group();
    empty("ringedge_L", -9, 0, 0, root);
    const a = anchorsFromScene(root);
    expect(a.fires).toEqual(PROCEDURAL_ANCHORS.fires);
    expect(a.crowd).toEqual(PROCEDURAL_ANCHORS.crowd);
    expect(a.floods).toEqual(PROCEDURAL_ANCHORS.floods);
    expect(checkRingEdges(a)).toMatch(/ringedge_L\/R/);
  });
});

describe("arena geometry", () => {
  it("merges copies with transforms and keeps mirrored copies front-facing", () => {
    const b = new GeoBuilder({ tag: 1 });
    const box = new BoxGeometry(1, 1, 1);
    b.add(box, new Matrix4().makeTranslation(5, 0, 0), (p, _n, out) => {
      out.tag[0] = p.x;
    });
    b.add(box, new Matrix4().makeScale(-1, 1, 1), () => {});
    const g = b.build();
    expect(b.triangleCount).toBe(24);
    const tag = g.getAttribute("tag");
    expect(tag.getX(0)).toBeGreaterThanOrEqual(4.5);
    // Every triangle's winding agrees with its normal (a mirror must not turn faces inside out).
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const idx = g.getIndex();
    if (!idx) throw new Error("expected an index");
    const [a, bb, c, n] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i));
      bb.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      n.fromBufferAttribute(nor, idx.getX(i));
      const face = bb.sub(a).cross(c.sub(a));
      expect(face.dot(n)).toBeGreaterThan(0);
    }
  });

  it("stays inside the triangle budget (arena <= 60k)", () => {
    const u = createUniforms(PROCEDURAL_ANCHORS);
    const floor = buildFloor(u, PROCEDURAL_ANCHORS.floods.length);
    const props = buildProps(u, PROCEDURAL_ANCHORS);
    const crowd = PROCEDURAL_ANCHORS.crowd.reduce((n, r) => n + r.count, 0) * 4;
    const total = floor.triangles + props.triangles + crowd;
    expect(props.triangles).toBeGreaterThan(5000); // it is actually a junkyard
    expect(total).toBeLessThan(60_000);
    // Vertex attributes line up with the bake contract.
    const g = props.mesh.geometry;
    const n = g.getAttribute("position").count;
    expect(g.getAttribute("color").count).toBe(n);
    expect(g.getAttribute("aLight").count).toBe(n);
    expect(g.getAttribute("aFire").itemSize).toBe(2);
    floor.mesh.geometry.dispose();
    floor.mesh.material.dispose();
    g.dispose();
    props.mesh.material.dispose();
  });

  it("builds the same junkyard every time (seeded)", () => {
    const u = createUniforms(PROCEDURAL_ANCHORS);
    const a = buildProps(u, PROCEDURAL_ANCHORS).mesh.geometry.getAttribute("position");
    const b = buildProps(u, PROCEDURAL_ANCHORS).mesh.geometry.getAttribute("position");
    expect(a.count).toBe(b.count);
    expect(Array.from(a.array as Float32Array).slice(0, 300)).toEqual(Array.from(b.array as Float32Array).slice(0, 300));
  });
});

describe("fire flicker", () => {
  it("is deterministic in t and stays in a sane range", () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 20; t += 0.013) {
      const f = flicker(11, t);
      expect(f).toBe(flicker(11, t));
      lo = Math.min(lo, f);
      hi = Math.max(hi, f);
    }
    expect(lo).toBeGreaterThan(0.55);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.2); // it actually flickers
  });
});
