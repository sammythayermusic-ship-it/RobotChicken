import { BoxGeometry, Group, Matrix4, Object3D, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { RULES } from "@cockfight/sim";
import { buildBeams, SHAFT_FADE } from "./beams";
import { GeoBuilder } from "./builder";
import { advanceCrowd, flapRate, hopRate, type CrowdClock } from "./crowd";
import { buildFires } from "./fires";
import { buildFloor } from "./floor";
import { anchorsFromScene, checkRingEdges, HAZARD_IN, LIP_IN, PROCEDURAL_ANCHORS, RING_EDGE } from "./layout";
import { createUniforms, flicker, FLOOD_CONE } from "./lighting";
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

  it("is flush wherever a fighter can stand: nothing inside the ring edge rises above the floor", () => {
    // A ring-out shove that falls short leaves the defender standing anywhere up to x = 10.
    const floor = buildFloor(createUniforms(PROCEDURAL_ANCHORS), PROCEDURAL_ANCHORS.floods.length);
    const pos = floor.mesh.geometry.getAttribute("position");
    let highest = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i)) <= RING_EDGE + 1e-6) highest = Math.max(highest, pos.getY(i));
    }
    expect(highest).toBeLessThanOrEqual(1e-6);
    floor.mesh.geometry.dispose();
    floor.mesh.material.dispose();
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

describe("crowd motion", () => {
  /** Wrapped distance between two phases on a circle of length `period`. */
  const step = (a: number, b: number, period: number) => {
    const d = Math.abs(b - a) % period;
    return Math.min(d, period - d);
  };

  it("keeps the hop and wing phases continuous when hype jumps late in a match", () => {
    const dt = 1 / 60;
    const c: CrowdClock = { bob: 0, flap: 0 };
    // 100 s of a bored crowd, then a KO slams hype from 0.2 to 1 and it eases back down.
    for (let i = 0; i < 6000; i++) advanceCrowd(c, dt, 0.2);
    let hype = 1;
    let worstFlap = 0;
    let worstBob = 0;
    for (let i = 0; i < 600; i++) {
      const before = { ...c };
      advanceCrowd(c, dt, hype);
      worstFlap = Math.max(worstFlap, step(before.flap, c.flap, 1));
      worstBob = Math.max(worstBob, step(before.bob, c.bob, Math.PI * 2));
      hype = Math.max(0.2, hype - 0.01);
    }
    // A frame never moves further than the fastest rate allows. (The old shader form,
    // fract(uTime * rate(hype)), jumped by t * d(rate): 272 wing cycles in the KO frame here.)
    expect(worstFlap).toBeLessThanOrEqual(flapRate(1) * dt + 1e-9);
    expect(worstBob).toBeLessThanOrEqual(hopRate(1) * dt + 1e-9);
    expect(c.flap).toBeGreaterThanOrEqual(0);
    expect(c.flap).toBeLessThan(1);
    expect(c.bob).toBeLessThan(Math.PI * 2);
  });

  it("stands still while paused (dt = 0) whatever hype does", () => {
    const c: CrowdClock = { bob: 1.2, flap: 0.4 };
    advanceCrowd(c, 0, 1);
    expect(c).toEqual({ bob: 1.2, flap: 0.4 });
  });
});

describe("floodlight shafts", () => {
  const coneStats = () => {
    const { mesh } = buildBeams(PROCEDURAL_ANCHORS.floods, [], { value: 0 });
    const g = mesh.geometry;
    const params = g.getAttribute("aParams");
    const pos = g.getAttribute("position");
    const idx = g.getIndex();
    if (!idx) throw new Error("expected an index");
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < params.count; i++) {
      if (params.getX(i) !== 0) continue; // cones only
      lo = Math.min(lo, params.getZ(i));
      hi = Math.max(hi, params.getZ(i));
    }
    let area = 0;
    const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
    for (let i = 0; i < idx.count; i += 3) {
      if (params.getX(idx.getX(i)) !== 0) continue;
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i + 1)).sub(a);
      c.fromBufferAttribute(pos, idx.getX(i + 2)).sub(a);
      area += b.cross(c).length() / 2;
    }
    g.dispose();
    mesh.material.dispose();
    return { lo, hi, area };
  };

  it("end where they have faded out, with the same fade from the lamp", () => {
    const { lo, hi } = coneStats();
    const f = PROCEDURAL_ANCHORS.floods[0]!;
    const len = new Vector3(f.pos.x, f.pos.y, f.pos.z).distanceTo(new Vector3(f.target.x, f.target.y, f.target.z));
    expect(hi).toBeCloseTo(SHAFT_FADE[1], 6); // nothing is built past full transparency
    expect(lo).toBeCloseTo(0.5 / len, 6); // the lamp ring is where it always was
  });

  it("skip the dead wide end: about a quarter less cone surface than lamp-to-floor", () => {
    const { area } = coneStats();
    // The full-length open cone of the old build, per flood: pi * (r0 + r1) * slant.
    const half = Math.acos(FLOOD_CONE.x) * 0.92;
    let full = 0;
    for (const f of PROCEDURAL_ANCHORS.floods) {
      const len = new Vector3(f.pos.x, f.pos.y, f.pos.z).distanceTo(new Vector3(f.target.x, f.target.y, f.target.z));
      const r1 = 0.5 + Math.tan(half) * len;
      full += Math.PI * (0.5 + r1) * Math.hypot(len, r1 - 0.5);
    }
    expect(area / full).toBeLessThan(0.8);
    expect(area / full).toBeGreaterThan(0.6);
  });
});

describe("quality tiers", () => {
  it("fires: 'low' draws a prefix of flames and halos and drops the smoke and embers", () => {
    const fires = buildFires(PROCEDURAL_ANCHORS.fires, createUniforms(PROCEDURAL_ANCHORS));
    const g = fires.mesh.geometry;
    const params = g.getAttribute("aParams");
    const drums = PROCEDURAL_ANCHORS.fires[0].drums.length + PROCEDURAL_ANCHORS.fires[1].drums.length;
    expect(fires.counts.core).toBe(drums * 11); // 10 tongues + a halo per drum
    expect(fires.counts.all).toBe(fires.counts.core + 2 * (7 + 16)); // + smoke and embers per cluster
    expect(g.instanceCount).toBe(fires.counts.all);
    for (let i = 0; i < fires.counts.all; i++) expect(params.getX(i) <= 1, `instance ${i} kind`).toBe(i < fires.counts.core);
    fires.setAmbient(false);
    expect(g.instanceCount).toBe(fires.counts.core);
    fires.setAmbient(true);
    expect(g.instanceCount).toBe(fires.counts.all);
    g.dispose();
    fires.mesh.material.dispose();
  });

  it("beams: 'low' skips the haze sheet and nothing else", () => {
    const beams = buildBeams(PROCEDURAL_ANCHORS.floods, [{ x: 0, y: 4, z: -9 }], { value: 0 });
    const g = beams.mesh.geometry;
    const idx = g.getIndex();
    if (!idx) throw new Error("expected an index");
    const kind = g.getAttribute("aParams");
    beams.setHaze(false);
    const kept = g.drawRange.count;
    expect(kept).toBe(idx.count - 6); // one quad
    for (let i = 0; i < idx.count; i++) expect(kind.getX(idx.getX(i)) === 2, `index ${i}`).toBe(i >= kept);
    beams.setHaze(true);
    expect(g.drawRange.count).toBe(Infinity);
    g.dispose();
    beams.mesh.material.dispose();
  });
});
