import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { RULES } from "@cockfight/sim";
import { BODY, FightCamera, VFOV } from "./FightCamera";
import { HUD_BAND_PX, INSET_SHARE, hudBandPx, hudFraction, insetFraction } from "./hudBand";

const WALL = RULES.match.wallEdge / 1000;
/** Apex of a standing jump, from the sim's own integer arc (2.565 u). */
function jumpArc(): number[] {
  const vy0 = RULES.fighter.jumpVy;
  const g = RULES.fighter.gravity;
  const ys: number[] = [];
  let y = 0;
  let vy = vy0;
  do {
    y += vy;
    vy -= g;
    ys.push(Math.max(0, y) / 1000);
  } while (y > 0);
  return ys;
}
const APEX = Math.max(...jumpArc());

/** Real viewports: desktop 16:9 / 16:10 / 4:3 / 21:9, a landscape phone (Pixel 7), portrait phones. */
const VIEWPORTS: [string, number, number][] = [
  ["16:9", 1280, 720],
  ["16:10", 1280, 800],
  ["4:3", 1024, 768],
  ["21:9", 2560, 1080],
  ["phone landscape", 915, 412],
  ["9:16", 720, 1280],
  ["phone portrait", 412, 915],
];

/** Roots (x, y) in units. */
const SCENES: [string, [number, number], [number, number]][] = [
  ["both at the walk limits", [-WALL, 0], [WALL, 0]],
  ["both at the walk limits, both at the jump apex", [-WALL, APEX], [WALL, APEX]],
  ["close range, P1 at the jump apex", [-0.64, APEX], [0.64, 0]],
  ["cornered at the right wall, P1 jumping in", [WALL - 0.6, APEX], [WALL, 0]],
  ["a short shove left P2 standing past the wall", [-WALL, 0], [10, 0]],
  ["start positions", [-2.5, 0], [2.5, 0]],
  // The highest anything goes: a super (launch vy 180) catching a fighter at the top of a jump.
  ["a super launched P2 off the top of a jump", [-1, 0], [1.2, APEX + 1.2]],
];

/** Every corner of a body box around a root: the extent the camera promises to keep in frame. */
function corners(x: number, y: number, half = BODY.half, top = BODY.top, depth = BODY.depth): Vector3[] {
  const out: Vector3[] = [];
  for (const dx of [-half, half]) for (const hy of [0, top]) for (const dz of [-depth, depth]) out.push(new Vector3(x + dx, y + hy, dz));
  return out;
}

function settle(cam: FightCamera, a: [number, number], b: [number, number], ticks = 600): void {
  for (let i = 0; i < ticks; i++) cam.tick(a[0], b[0], a[1], b[1]);
  cam.render(1);
  cam.camera.updateMatrixWorld();
}

function ndc(cam: FightCamera, p: Vector3): Vector3 {
  return p.clone().project(cam.camera);
}

describe("FightCamera framing", () => {
  for (const [label, w, h] of VIEWPORTS) {
    const hud = hudFraction(w, h);
    const hudLine = 1 - 2 * hud;
    for (const [scene, a, b] of SCENES) {
      it(`${label} (${w}x${h}): ${scene} — both bodies in frame and below the HUD band`, () => {
        const cam = new FightCamera(w / h, 3);
        cam.setViewport(w, h);
        settle(cam, a, b);
        for (const [x, y] of [a, b]) {
          for (const p of corners(Math.min(10, x), y)) {
            const q = ndc(cam, p);
            expect(Math.abs(q.x), `x of ${p.toArray()}`).toBeLessThan(0.98);
            expect(q.y, `bottom of ${p.toArray()}`).toBeGreaterThan(-0.98);
            expect(q.y, `top of ${p.toArray()} vs the HUD line ${hudLine}`).toBeLessThan(hudLine);
          }
        }
      });
    }
  }

  it("roots at the walls plus the body extent land inside |NDC x| < 0.98 (the reviewed repro: 0.45, 1.6, 2.22)", () => {
    for (const [w, h] of [[412, 915], [1280, 800], [915, 412]] as const) {
      const cam = new FightCamera(w / h);
      cam.setViewport(w, h);
      settle(cam, [-WALL, 0], [WALL, 0]);
      for (const x of [-WALL - 0.9, WALL + 0.9]) {
        for (const y of [0, 1.4]) expect(Math.abs(ndc(cam, new Vector3(x, y, 0)).x)).toBeLessThan(0.98);
      }
    }
  });

  it("keeps the jumper's head below the HUD band on every tick of a real jump arc, not just once settled", () => {
    for (const [w, h] of [[1280, 800], [915, 412], [412, 915]] as const) {
      const hudLine = 1 - 2 * hudFraction(w, h);
      const cam = new FightCamera(w / h);
      cam.setViewport(w, h);
      settle(cam, [-0.64, 0], [0.64, 0], 300);
      for (const y of [...jumpArc(), 0, 0, 0]) {
        cam.tick(-0.64, 0.64, y, 0);
        cam.render(1);
        cam.camera.updateMatrixWorld();
        for (const p of corners(-0.64, y)) {
          const q = ndc(cam, p);
          expect(q.y).toBeLessThan(hudLine);
          expect(q.y).toBeGreaterThan(-0.98);
        }
      }
    }
  });

  it("keeps both fighters in frame while the camera is still easing (a dash to the wall)", () => {
    const cam = new FightCamera(16 / 9);
    cam.setViewport(1280, 720);
    settle(cam, [-1, 0], [1, 0], 300);
    // Both back-dash apart at full speed: the eased target lags, the hard fit must not.
    let x1 = -1;
    let x2 = 1;
    for (let i = 0; i < 90; i++) {
      x1 = Math.max(-WALL, x1 - 0.15);
      x2 = Math.min(WALL, x2 + 0.15);
      cam.tick(x1, x2);
      cam.render(1);
      cam.camera.updateMatrixWorld();
      for (const p of [...corners(x1, 0), ...corners(x2, 0)]) expect(Math.abs(ndc(cam, p).x)).toBeLessThan(0.98);
    }
  });

  it("refits at once on a resize, without waiting for a tick", () => {
    const cam = new FightCamera(16 / 9);
    cam.setViewport(1280, 720);
    settle(cam, [-WALL, 0], [WALL, 0]);
    cam.setViewport(412, 915);
    cam.render(1);
    cam.camera.updateMatrixWorld();
    for (const p of [...corners(-WALL, 0), ...corners(WALL, 0)]) expect(Math.abs(ndc(cam, p).x)).toBeLessThan(0.98);
  });

  it("keeps the grounded composition: look height 1.5 and 3.5 u of pit around the pair", () => {
    const cam = new FightCamera(1.6);
    cam.setViewport(1280, 800);
    settle(cam, [-2.5, 0], [2.5, 0]);
    expect(cam.framing.lookY).toBeCloseTo(1.5, 6);
    expect(cam.framing.d).toBeCloseTo(FightCamera.distanceFor(12, 1.6), 3);
    expect(cam.framing.x).toBeCloseTo(0, 6);
  });

  it("cranes up for a jump before it pulls back, and settles back down after landing", () => {
    const cam = new FightCamera(1.6);
    cam.setViewport(1280, 800);
    settle(cam, [-0.64, 0], [0.64, 0]);
    const ground = { ...cam.framing };
    settle(cam, [-0.64, APEX], [0.64, 0]);
    expect(cam.framing.lookY).toBeGreaterThan(ground.lookY + 0.3);
    expect(cam.framing.d).toBeCloseTo(ground.d, 6); // 16:10 has the room: no pull-back needed
    settle(cam, [-0.64, 0], [0.64, 0]);
    expect(cam.framing.lookY).toBeCloseTo(ground.lookY, 6);
  });

  it("composes tighter on upright and square screens (the width sets the scale there), without a jump", () => {
    expect(FightCamera.wantWidth(-2.5, 2.5, 412 / 539)).toBe(9);
    expect(FightCamera.wantWidth(-0.64, 0.64, 0.7)).toBe(6.5);
    expect(FightCamera.wantWidth(-WALL, WALL, 0.7)).toBe(FightCamera.wantWidth(-WALL, WALL));
    // An iPhone upright in Safari: the fight area is about square (390 x 370).
    expect(FightCamera.wantWidth(-2.5, 2.5, 390 / 370)).toBeLessThan(10.5);
    // Landscape desktops and phones: unchanged.
    for (const a of [4 / 3, 16 / 10, 16 / 9, 915 / 412]) expect(FightCamera.wantWidth(-2.5, 2.5, a)).toBe(12);
    // Continuous in aspect: a pixel of height never jumps the framing.
    for (let a = 0.6; a < 1.6; a += 0.01) {
      expect(Math.abs(FightCamera.wantWidth(-2.5, 2.5, a + 0.01) - FightCamera.wantWidth(-2.5, 2.5, a))).toBeLessThan(0.1);
    }
    const up = new FightCamera(412 / 539);
    up.setViewport(412, 539);
    settle(up, [-2.5, 0], [2.5, 0]);
    expect(up.framing.d).toBeCloseTo(FightCamera.distanceFor(9, 412 / 539), 3);
  });

  it("widens the composed width up to the walls with room for the bodies", () => {
    expect(FightCamera.wantWidth(0, 0)).toBe(9);
    expect(FightCamera.wantWidth(-6, 6)).toBe(19);
    expect(FightCamera.wantWidth(-WALL, WALL)).toBeCloseTo(2 * (WALL + BODY.half + 0.35), 9);
    for (const aspect of [16 / 9, 4 / 3, 21 / 9, 1.2]) {
      const w = FightCamera.wantWidth(-6, 6);
      const d = FightCamera.distanceFor(w, aspect);
      const hfov = 2 * Math.atan(Math.tan((VFOV * Math.PI) / 360) * aspect);
      expect(2 * d * Math.tan(hfov / 2)).toBeCloseTo(w, 5);
    }
  });
});

describe("HUD band tiers", () => {
  it("wide on desktops, short on phones held sideways, narrow in portrait", () => {
    expect(hudBandPx(1280, 800)).toBe(HUD_BAND_PX.wide);
    expect(hudBandPx(1280)).toBe(HUD_BAND_PX.wide);
    expect(hudBandPx(915, 412)).toBe(HUD_BAND_PX.short);
    expect(hudBandPx(734, 343)).toBe(HUD_BAND_PX.short);
    expect(hudBandPx(640, 479)).toBe(HUD_BAND_PX.short);
    expect(hudBandPx(640, 480)).toBe(HUD_BAND_PX.wide);
    expect(hudBandPx(412, 915)).toBe(HUD_BAND_PX.narrow);
    expect(hudBandPx(412, 539)).toBe(HUD_BAND_PX.narrow);
    expect(hudBandPx(639, 300)).toBe(HUD_BAND_PX.narrow);
  });
});

describe("FightCamera bottom inset (on-screen buttons)", () => {
  /**
   * Landscape phones, with the buttons' reach up into the canvas (px). The
   * page reports the reach; FightView keeps INSET_SHARE of it clear, which is
   * what setViewport takes.
   */
  const PHONES: [string, number, number, number][] = [
    ["Pixel 7 sideways", 915, 412, 140],
    ["iPhone SE sideways", 667, 375, 134],
    ["iPhone 15 sideways", 734, 343, 134],
    ["a tablet sideways", 1180, 820, 134],
  ];

  it("a zero inset keeps the old bottom edge and the same framing", () => {
    for (const [w, h] of [[1280, 800], [915, 412], [412, 915]] as const) {
      const a = new FightCamera(w / h, 5);
      const b = new FightCamera(w / h, 5);
      a.setViewport(w, h);
      b.setViewport(w, h, 0);
      settle(a, [-2.5, 0], [2.5, 0]);
      settle(b, [-2.5, 0], [2.5, 0]);
      expect(b.framing).toEqual(a.framing);
      expect(b.bottomFrac).toBe(0);
    }
    expect(FightCamera.bottomLimit(0.2, 0)).toBe(-0.94);
  });

  it("never squeezes the usable frame under 0.6 of NDC height", () => {
    for (const hud of [0, 0.1, 0.2, 0.3, 0.4]) {
      const top = FightCamera.topLimit(hud);
      expect(top - FightCamera.bottomLimit(hud, 0.3)).toBeGreaterThanOrEqual(Math.min(0.6, top + 0.94) - 1e-9);
    }
  });

  for (const [label, w, h, inset] of PHONES) {
    for (const [scene, a, b] of SCENES) {
      it(`${label} (${w}x${h}, ${inset} px of buttons): ${scene} — feet above the inset, heads below the HUD`, () => {
        const hud = hudFraction(w, h);
        const frac = insetFraction(inset, h);
        const hudLine = 1 - 2 * hud;
        const bot = FightCamera.bottomLimit(hud, frac);
        expect(bot).toBeGreaterThan(-0.94);
        const cam = new FightCamera(w / h, 3);
        cam.setViewport(w, h, inset * INSET_SHARE);
        settle(cam, a, b);
        for (const [x, y] of [a, b]) {
          for (const p of corners(Math.min(10, x), y)) {
            const q = ndc(cam, p);
            expect(Math.abs(q.x), `x of ${p.toArray()}`).toBeLessThan(0.98);
            expect(q.y, `bottom of ${p.toArray()} vs the inset line ${bot}`).toBeGreaterThan(bot - 0.04);
            expect(q.y, `top of ${p.toArray()} vs the HUD line ${hudLine}`).toBeLessThan(hudLine);
          }
        }
      });
    }
  }

  it("keeps a grounded close-range fight the same size (the inset only bites when the fit is tight)", () => {
    const [w, h, inset] = [734, 343, 134];
    const a = new FightCamera(w / h);
    const b = new FightCamera(w / h);
    a.setViewport(w, h);
    b.setViewport(w, h, inset * INSET_SHARE);
    settle(a, [-0.64, 0], [0.64, 0]);
    settle(b, [-0.64, 0], [0.64, 0]);
    expect(b.framing.d).toBeCloseTo(a.framing.d, 6);
  });
});

describe("FightCamera shake", () => {
  it("is deterministic for a seed and decays to zero", () => {
    const a = new FightCamera(16 / 9, 42);
    const b = new FightCamera(16 / 9, 42);
    a.addTrauma(1);
    b.addTrauma(1);
    for (let i = 0; i < 20; i++) {
      a.tick(-2, 2);
      b.tick(-2, 2);
      expect(a.shakeOffsets()).toEqual(b.shakeOffsets());
    }
    for (let i = 0; i < 120; i++) a.tick(-2, 2);
    expect(a.traumaLevel).toBe(0);
  });

  it("reduced shake scales the offsets and the per-hit kick", () => {
    const a = new FightCamera(16 / 9, 7);
    const b = new FightCamera(16 / 9, 7);
    b.shake.amount = 0.3;
    for (const c of [a, b]) {
      c.addTrauma(1);
      c.onHit(15, 1);
      c.tick(0, 3);
    }
    expect(Math.abs(b.shakeOffsets().y)).toBeLessThanOrEqual(Math.abs(a.shakeOffsets().y));
    expect(Math.abs(b.shakeOffsets().x)).toBeLessThan(Math.abs(a.shakeOffsets().x));
  });

  it("shake Off moves nothing: no offsets, no kick, no punch zoom, no FOV kick", () => {
    const still = new FightCamera(16 / 9, 9);
    const off = new FightCamera(16 / 9, 9);
    off.shake.amount = 0;
    for (const c of [still, off]) settle(c, [-2, 0], [2, 0], 200);
    off.addTrauma(1);
    off.onHit(25, -1);
    off.onHit(15, 1);
    off.onSuper();
    for (let i = 0; i < 12; i++) {
      still.tick(-2, 2);
      off.tick(-2, 2);
      const sh = off.shakeOffsets();
      expect(Math.abs(sh.x)).toBe(0);
      expect(Math.abs(sh.y)).toBe(0);
      expect(Math.abs(sh.roll)).toBe(0);
      expect(off.framing).toEqual(still.framing);
      off.render(0.5);
      still.render(0.5);
      expect(off.camera.fov).toBe(VFOV);
      expect(off.camera.position.distanceTo(still.camera.position)).toBe(0);
    }
  });
});
