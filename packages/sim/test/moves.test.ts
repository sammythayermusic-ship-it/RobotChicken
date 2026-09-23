import { describe, expect, it } from "vitest";
import {
  B, HitKind, Mv, Phase, RULES, Reason, St, clone, detect, step, type FighterState, type MatchState, type MoveRules, type MvId,
} from "../src/index";
import { fightingMatch, run } from "./helpers/run";

const F = RULES.fighter;
const M = RULES.match;
const mv = (id: MvId) => RULES.moves[id] as MoveRules;

/** Fighters placed `gap` mu apart around the centre, P1 on the left, both idle and facing each other. */
function placed(gap: number, id = "moves"): MatchState {
  const s = fightingMatch(id);
  s.f[0].x = -(gap >> 1);
  s.f[1].x = gap - (gap >> 1);
  return s;
}

/** Start P1's attack with the given held buttons (Space press edge this tick). */
function attack(s: MatchState, hold: number, b2 = 0): MatchState {
  return step(s, hold | B.S, b2);
}

/** Number of ticks until fighter `i` is actionable (idle) again. */
function ticksUntilIdle(s: MatchState, i: 0 | 1, b1 = 0, b2 = 0, max = 400): number {
  for (let t = 1; t <= max; t++) {
    s = step(s, b1, b2);
    if (s.f[i].st === St.idle || s.f[i].st === St.walkF || s.f[i].st === St.walkB) return t;
  }
  return -1;
}

describe("attack timing (whiff)", () => {
  for (const id of [Mv.peck, Mv.shove, Mv.slam] as const) {
    it(`${mv(id).name}: whiff lasts exactly startup+active+recovery ticks`, () => {
      let s = placed(8000);
      const hold = id === Mv.slam ? B.D : id === Mv.shove ? B.R : 0;
      s = attack(s, hold);
      expect(s.f[0].st).toBe(St.attack);
      expect(s.f[0].move).toBe(id);
      expect(s.f[0].stTick).toBe(1);
      // the tick it becomes idle again is total ticks after the start tick
      expect(ticksUntilIdle(s, 0)).toBe(mv(id).total);
    });
  }
});

describe("active frames (detection sweep)", () => {
  // Stand the defender where every ground attack connects during its active window only.
  const GAP = 1250;
  for (const id of [Mv.peck, Mv.shove, Mv.slam] as const) {
    it(`${mv(id).name}: connects on frames ${mv(id).startup + 1}..${mv(id).startup + mv(id).active} only`, () => {
      const m = mv(id);
      const s = placed(GAP);
      const a = s.f[0];
      a.st = St.attack;
      a.move = id;
      const hitFrames: number[] = [];
      for (let f = 1; f <= m.total; f++) {
        a.stTick = f;
        a.hitDone = 0;
        if (detect(a, s.f[1], false, RULES)) hitFrames.push(f);
      }
      const expected = Array.from({ length: m.active }, (_, k) => m.startup + 1 + k);
      expect(hitFrames).toEqual(expected);
    });
  }
  it("super connects anywhere on the screen during its active frames", () => {
    const m = mv(Mv.super);
    const s = placed(15000);
    const a = s.f[0];
    a.st = St.attack;
    a.move = Mv.super;
    const hitFrames: number[] = [];
    for (let f = 1; f <= m.total; f++) {
      a.stTick = f;
      if (detect(a, s.f[1], false, RULES)) hitFrames.push(f);
    }
    expect(hitFrames).toEqual(Array.from({ length: m.active }, (_, k) => m.startup + 1 + k));
  });
});

describe("peck on hit and on block", () => {
  it("hit: 600 damage, hitstun 14, 3 frozen ticks for both, +480 Heat, one hit per move", () => {
    let s = placed(1100);
    s = attack(s, 0);
    let hitTick = -1;
    for (let t = 0; t < 20 && hitTick < 0; t++) {
      s = step(s, 0, 0);
      if (s.f[1].hitKind === HitKind.hit) hitTick = s.tick;
    }
    expect(s.f[0].stTick).toBe(mv(Mv.peck).startup + 1);
    expect(s.f[1].hp).toBe(F.hpMax - 600);
    expect(s.f[1].st).toBe(St.hitStun);
    expect(s.f[1].stun).toBe(14);
    expect(s.f[0].heat).toBe(480);
    expect(s.f[0].hitstop).toBe(3);
    expect(s.f[1].hitstop).toBe(3);
    const frozen = clone(s);
    s = run(s, 3);
    // frozen: neither fighter moved or advanced
    expect(s.f[0].stTick).toBe(frozen.f[0].stTick);
    expect(s.f[1].x).toBe(frozen.f[1].x);
    expect(s.f[1].stun).toBe(frozen.f[1].stun);
    s = step(s, 0, 0);
    expect(s.f[0].stTick).toBe(frozen.f[0].stTick + 1);
    // still one hit only
    s = run(s, 20);
    expect(s.f[1].hp).toBe(F.hpMax - 600);
  });

  it("frame advantage: +5 on hit, -1 on block", () => {
    const adv = (b2: number) => {
      let s = placed(1100);
      s = attack(s, 0, b2);
      for (let t = 0; t < 10 && s.f[1].hitKind === 0; t++) s = step(s, 0, b2);
      let a = -1;
      let d = -1;
      for (let t = 1; t < 60 && (a < 0 || d < 0); t++) {
        s = step(s, 0, 0);
        if (a < 0 && s.f[0].st === St.idle) a = t;
        if (d < 0 && s.f[1].st === St.idle) d = t;
      }
      return d - a;
    };
    expect(adv(0)).toBe(5);
    expect(adv(B.D)).toBe(-1);
  });

  it("block: chip is exactly 10%, blockstun 8, +180 Heat to the attacker", () => {
    let s = placed(1100);
    s = attack(s, 0, B.D);
    for (let t = 0; t < 10 && s.f[1].hitKind === 0; t++) s = step(s, 0, B.D);
    expect(s.f[1].hitKind).toBe(HitKind.block);
    expect(s.f[1].hp).toBe(F.hpMax - 60);
    expect(s.f[1].st).toBe(St.blockStun);
    expect(s.f[1].stun).toBe(8);
    expect(s.f[0].heat).toBe(180);
  });

  it("chip damage can KO", () => {
    let s = placed(1100);
    s.f[1].hp = 50;
    s = attack(s, 0, B.D);
    for (let t = 0; t < 10 && s.phase === Phase.fighting; t++) s = step(s, 0, B.D);
    expect(s.f[1].st).toBe(St.ko);
    expect(s.phase).toBe(Phase.roundEnd);
    expect(s.reason).toBe(Reason.ko);
  });

  it("a buffered press survives hit-stop", () => {
    let s = placed(1100);
    s = attack(s, 0);
    for (let t = 0; t < 10 && s.f[1].hitKind === 0; t++) s = step(s, 0, 0);
    expect(s.f[1].hitstop).toBe(3);
    // Defender presses Space during hit-stop: the buffer must not drain while frozen.
    s = step(s, 0, B.S);
    expect(s.f[1].bufS).toBe(F.inputBuffer);
    s = run(s, 2, 0, 0);
    expect(s.f[1].bufS).toBe(F.inputBuffer);
  });
});

describe("slam", () => {
  it("is unblockable, launches, then knockdown 40 and an invulnerable get-up of 20", () => {
    let s = placed(1200);
    s = attack(s, B.D, B.D);
    for (let t = 0; t < 30 && s.f[1].hitKind === 0; t++) s = step(s, 0, B.D);
    expect(s.f[1].hitKind).toBe(HitKind.hit);
    expect(s.f[1].hp).toBe(F.hpMax - 1800);
    expect(s.f[1].st).toBe(St.launched);
    expect(s.f[0].hitstop).toBe(8);
    while (s.f[1].st === St.launched) s = step(s, 0, 0);
    expect(s.f[1].st).toBe(St.knockdown);
    let lie = 0;
    while (s.f[1].st === St.knockdown) {
      s = step(s, 0, 0);
      lie++;
    }
    expect(lie).toBe(F.knockdownLie);
    expect(s.f[1].st).toBe(St.getup);
    let up = 0;
    while (s.f[1].st === St.getup) {
      s = step(s, 0, 0);
      up++;
    }
    expect(up).toBe(F.getup);
  });

  it("only hits grounded targets", () => {
    const s = placed(1200);
    s.f[0].st = St.attack;
    s.f[0].move = Mv.slam;
    s.f[0].stTick = mv(Mv.slam).startup + 1;
    s.f[1].grounded = 0;
    s.f[1].y = 300;
    s.f[1].st = St.jump;
    expect(detect(s.f[0], s.f[1], false, RULES)).toBe(false);
  });
});

describe("shove and ring-outs", () => {
  it("moves the defender exactly 2 units in open space, 1 unit on block", () => {
    for (const [b2, dist] of [[0, 2000], [B.D, 1000]] as const) {
      let s = placed(1200);
      s = attack(s, B.R, b2);
      for (let t = 0; t < 20 && s.f[1].hitKind === 0; t++) s = step(s, 0, b2);
      const x0 = s.f[1].x;
      s = run(s, 40, 0, b2);
      expect(s.f[1].x - x0).toBe(dist);
    }
  });

  it("blocked near the wall: the attacker is pushed back instead", () => {
    let s = placed(1200);
    s.f[1].x = M.wallEdge - 300;
    s.f[0].x = s.f[1].x - 1200;
    s = attack(s, B.R, B.D);
    for (let t = 0; t < 20 && s.f[1].hitKind === 0; t++) s = step(s, 0, B.D);
    const a0 = s.f[0].x;
    s = run(s, 40, 0, B.D);
    expect(s.f[1].x).toBe(M.wallEdge);
    expect(a0 - s.f[0].x).toBe(1000 - 300);
  });

  it("shove from 8.5 units rings out; peck at the wall never does", () => {
    let s = placed(1200);
    s.f[1].x = 8500;
    s.f[0].x = 7300;
    s = attack(s, B.R);
    for (let t = 0; t < 60 && s.phase === Phase.fighting; t++) s = step(s, 0, 0);
    expect(s.f[1].st).toBe(St.ringOut);
    expect(s.reason).toBe(Reason.ringout);
    expect(s.roundWinner).toBe(0);

    let p = placed(1100);
    p.f[1].x = M.wallEdge;
    p.f[0].x = M.wallEdge - 1100;
    for (let k = 0; k < 6; k++) {
      p = attack(p, 0);
      p = run(p, 30, 0, 0);
    }
    expect(p.f[1].x).toBeLessThanOrEqual(M.wallEdge);
    expect(p.f[1].st).not.toBe(St.ringOut);
  });

  it("slam from 6.5 units rings out", () => {
    let s = placed(1200);
    s.f[1].x = 6500;
    s.f[0].x = 5300;
    s = attack(s, B.D);
    for (let t = 0; t < 120 && s.phase === Phase.fighting; t++) s = step(s, 0, 0);
    expect(s.f[1].st).toBe(St.ringOut);
  });
});

describe("jump and dive kick", () => {
  it("is airborne exactly 36 ticks with a 2565 mu apex on ticks 18-19", () => {
    let s = placed(8000);
    let air = 0;
    let apex = 0;
    const apexTicks: number[] = [];
    s = step(s, B.U, 0);
    for (let t = 1; t <= 60; t++) {
      if (!s.f[0].grounded) air++;
      if (s.f[0].y > apex) apex = s.f[0].y;
      if (s.f[0].y === 2565) apexTicks.push(t);
      s = step(s, 0, 0);
    }
    expect(air).toBe(F.jumpAirTicks);
    expect(apex).toBe(2565);
    expect(apexTicks).toEqual([18, 19]);
  });

  it("dive kick: gated by 4 air ticks and 0.9 units, once per jump, 45 degrees, 14-tick landing recovery", () => {
    let s = placed(8000);
    s = step(s, B.U, 0);
    s = step(s, B.S, 0); // air tick 2: too early
    expect(s.f[0].st).toBe(St.jump);
    s = run(s, 2, 0, 0);
    s = step(s, B.S, 0); // air tick 5 (y >= 900): dives
    expect(s.f[0].st).toBe(St.attack);
    expect(s.f[0].move).toBe(Mv.dive_kick);
    const hoverY = s.f[0].y;
    s = run(s, mv(Mv.dive_kick).startup - 1, 0, 0);
    expect(s.f[0].y).toBe(hoverY); // hover
    s = step(s, 0, 0);
    expect(Math.abs(s.f[0].vx)).toBe(Math.abs(s.f[0].vy));
    while (!s.f[0].grounded) s = step(s, 0, 0);
    expect(s.f[0].st).toBe(St.attack);
    // After the touchdown tick, exactly `recovery` ticks of recovery frames, then idle.
    let rec = 0;
    for (;;) {
      s = step(s, 0, 0);
      if (s.f[0].st !== St.attack) break;
      rec++;
    }
    expect(rec).toBe(mv(Mv.dive_kick).recovery);
  });

  it("dive kick is unblockable", () => {
    const s = placed(600);
    s.f[0].st = St.attack;
    s.f[0].move = Mv.dive_kick;
    s.f[0].grounded = 0;
    s.f[0].y = 300;
    s.f[0].stTick = mv(Mv.dive_kick).startup + 2;
    s.f[1].st = St.block;
    const next = step(s, 0, B.D);
    expect(next.f[1].hitKind).toBe(HitKind.hit);
  });
});

describe("dash", () => {
  it("is invulnerable on dash frames 3-6 only", () => {
    const d = RULES.fighter.dashInvuln;
    for (let frame = 1; frame <= F.dashDuration; frame++) {
      const s = placed(1100);
      s.f[1].st = St.dashB;
      s.f[1].stTick = frame;
      s.f[0].st = St.attack;
      s.f[0].move = Mv.peck;
      s.f[0].stTick = mv(Mv.peck).startup + 1;
      const hit = detect(s.f[0], s.f[1], false, RULES);
      expect(hit, `dash frame ${frame}`).toBe(!(frame >= d[0] && frame <= d[1]));
    }
  });
  it("forward dash covers 1.44 units in 12 ticks", () => {
    let s = placed(8000);
    s = step(s, B.R, 0); // first tap walks one tick
    s = step(s, 0, 0);
    const x0 = s.f[0].x;
    s = step(s, B.R, 0);
    expect(s.f[0].st).toBe(St.dashF);
    s = run(s, F.dashDuration - 1, 0, 0);
    expect(s.f[0].x - x0).toBe(F.dashFwdSpeed * F.dashFwdFrames);
    s = step(s, 0, 0);
    expect(s.f[0].st).toBe(St.idle);
  });
});

describe("super", () => {
  function full(s: MatchState, i: 0 | 1): MatchState {
    s.f[i].heat = RULES.heat.max;
    return s;
  }
  it("neutral Space at full Heat is a super, not a peck; it drains the meter", () => {
    let s = full(placed(8000), 0);
    s = attack(s, 0);
    expect(s.f[0].move).toBe(Mv.super);
    expect(s.f[0].heat).toBe(0);
  });
  it("without full Heat, neutral Space is a peck", () => {
    let s = placed(8000);
    s.f[0].heat = RULES.heat.max - 1;
    s = attack(s, 0);
    expect(s.f[0].move).toBe(Mv.peck);
  });
  it("its invulnerable startup beats a peck; it deals 30% across the arena", () => {
    let s = full(placed(1100), 0);
    s = step(s, B.S, B.S);
    expect(s.f[0].move).toBe(Mv.super);
    expect(s.f[1].move).toBe(Mv.peck);
    for (let t = 0; t < 30 && s.f[1].hitKind === 0; t++) s = step(s, 0, 0);
    expect(s.f[0].hp).toBe(F.hpMax);
    expect(s.f[1].hp).toBe(F.hpMax - 3000);
  });
  it("misses a fighter jumping above 1.8 units", () => {
    const s = placed(8000);
    s.f[0].st = St.attack;
    s.f[0].move = Mv.super;
    s.f[0].stTick = mv(Mv.super).startup + 1;
    s.f[1].grounded = 0;
    s.f[1].st = St.jump;
    s.f[1].y = 1900;
    expect(detect(s.f[0], s.f[1], false, RULES)).toBe(false);
    s.f[1].y = 1700;
    expect(detect(s.f[0], s.f[1], false, RULES)).toBe(true);
  });
});

describe("heat", () => {
  it("decays exactly 60 per second, latches at full, resets each round", () => {
    let s = placed(8000);
    s.f[0].heat = 3000;
    s = run(s, 60);
    expect(s.f[0].heat).toBe(2940);
    s.f[0].heat = RULES.heat.max;
    s = run(s, 120);
    expect(s.f[0].heat).toBe(RULES.heat.max);
    s.f[1].hp = 1;
    s.f[1].x = s.f[0].x + 1100;
    s.f[0].heat = 1000;
    s = attack(s, 0);
    while (s.phase === Phase.fighting) s = step(s, 0, 0);
    while (s.phase !== Phase.countdown) s = step(s, 0, 0);
    expect(s.f[0].heat).toBe(0);
  });
});

describe("round endings", () => {
  it("a simultaneous KO (trade) is a drawn round", () => {
    let s = placed(1100);
    s.f[0].hp = 100;
    s.f[1].hp = 100;
    s = step(s, B.S, B.S);
    for (let t = 0; t < 10 && s.phase === Phase.fighting; t++) s = step(s, 0, 0);
    expect(s.reason).toBe(Reason.doubleKo);
    expect(s.roundWinner).toBe(2);
    expect(s.w1 + s.w2).toBe(0);
  });
  it("sudden death: the first clean hit wins the round", () => {
    let s = placed(1100);
    s.sd = 1;
    s.timer = M.suddenDeath;
    s = attack(s, 0);
    for (let t = 0; t < 10 && s.phase === Phase.fighting; t++) s = step(s, 0, 0);
    expect(s.reason).toBe(Reason.suddenDeath);
    expect(s.roundWinner).toBe(0);
  });
  it("hits are off during round end", () => {
    let s = placed(1100);
    s.f[1].hp = 1;
    s = attack(s, 0);
    while (s.phase === Phase.fighting) s = step(s, 0, 0);
    const hp0 = s.f[0].hp;
    // P2 is KO'd; P1 pecking the air changes nothing
    s = run(s, 60, B.S, 0);
    expect(s.f[0].hp).toBe(hp0);
    expect(s.phase === Phase.roundEnd || s.phase === Phase.countdown).toBe(true);
  });
  it("trades are symmetric", () => {
    let s = placed(1100);
    s = step(s, B.S, B.S);
    for (let t = 0; t < 30; t++) s = step(s, 0, 0);
    const [a, b] = s.f as [FighterState, FighterState];
    expect(a.hp).toBe(b.hp);
    expect(a.x).toBe(-b.x);
    expect(a.st).toBe(b.st);
  });
});

describe("baked hitboxes", () => {
  it("every move uses the baked rig helpers (no static-box fallbacks)", () => {
    expect(RULES.fallbacks).toEqual([]);
    for (const c of RULES.clips) expect(c.hurt, c.name).not.toBeNull();
  });
  it("walking in from the start positions, a peck lands", () => {
    let s = fightingMatch("walk-in");
    while (s.f[1].x - s.f[0].x > 1100) s = step(s, B.R, 0);
    s = attack(s, 0);
    for (let t = 0; t < 10 && s.f[1].hitKind === 0; t++) s = step(s, 0, 0);
    expect(s.f[1].hitKind).toBe(HitKind.hit);
    expect(s.f[1].hp).toBe(F.hpMax - 600);
  });
  it("at pushbox contact every ground attack reaches during its active frames", () => {
    for (const id of [Mv.peck, Mv.shove, Mv.slam] as const) {
      const s = placed(2 * F.pushHalfW);
      const a = s.f[0];
      a.st = St.attack;
      a.move = id;
      let hit = false;
      for (let f = mv(id).startup + 1; f <= mv(id).startup + mv(id).active; f++) {
        a.stTick = f;
        hit ||= detect(a, s.f[1], false, RULES);
      }
      expect(hit, mv(id).name).toBe(true);
    }
  });
});
