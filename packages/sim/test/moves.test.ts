import { describe, expect, it } from "vitest";
import {
  B, HitKind, Mv, Phase, RULES, Reason, St, clone, detect, isInvulnerable, step, type FighterState, type MatchState, type MoveRules, type MvId,
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

describe("cancels and the Space buffer", () => {
  /**
   * P1 pecks P2 (blocking or not) with Heat just short of full, then presses Space
   * again on peck frame 8. Did the super replace the peck mid-move (a cancel)?
   */
  function peckThenSpace(b2: number): { cancelled: boolean; heatFull: boolean; contact: number } {
    let s = placed(1100, "cancel");
    s.f[0].heat = RULES.heat.max - 100; // the peck's +480 (or +180 when blocked) fills it
    s = attack(s, 0, b2);
    let cancelled = false;
    let heatFull = false;
    for (let t = 0; t < 40; t++) {
      const inPeck = s.f[0].st === St.attack && s.f[0].move === Mv.peck;
      const press = inPeck && s.f[0].stTick === 8 && s.f[0].hitstop === 0;
      const next = step(s, press ? B.S : 0, b2);
      if (inPeck && next.f[0].st === St.attack && next.f[0].move === Mv.super) cancelled = true;
      heatFull ||= next.f[0].heat >= RULES.heat.max;
      s = next;
    }
    return { cancelled, heatFull, contact: s.f[1].hitKind };
  }

  it("a peck that hits cancels into the super inside frames 5-10", () => {
    const r = peckThenSpace(0);
    expect(r.contact).toBe(HitKind.hit);
    expect(r.cancelled).toBe(true);
  });

  it("a blocked peck does not cancel (cancels are on hit only)", () => {
    const r = peckThenSpace(B.D);
    expect(r.contact).toBe(HitKind.block);
    expect(r.heatFull).toBe(true); // the block filled the meter, so only the on-hit rule stops the cancel
    expect(r.cancelled).toBe(false);
  });

  it("a buffered press fires the move held when Space went down, not what is held when it fires", () => {
    // Full Heat, down+Space buffered in a shove's recovery, down released 2 ticks later: slam, and the meter is kept.
    let s = placed(8000, "buf");
    s.f[0].heat = RULES.heat.max;
    s = attack(s, B.R);
    expect(s.f[0].move).toBe(Mv.shove);
    while (s.f[0].stTick < mv(Mv.shove).total - 3) s = step(s, 0, 0);
    s = step(s, B.D | B.S, 0);
    s = step(s, B.D, 0);
    while (s.f[0].st === St.attack && s.f[0].move === Mv.shove) s = step(s, 0, 0);
    expect(s.f[0].move).toBe(Mv.slam);
    expect(s.f[0].heat).toBe(RULES.heat.max);

    // Toward+Space pressed late in a whiffed peck, toward held for a single tick: a shove, not a second peck.
    let p = placed(8000, "buf2");
    p = attack(p, 0);
    while (p.f[0].stTick < mv(Mv.peck).total - 2) p = step(p, 0, 0);
    p = step(p, B.R | B.S, 0);
    while (p.f[0].st === St.attack && p.f[0].move === Mv.peck) p = step(p, 0, 0);
    expect(p.f[0].move).toBe(Mv.shove);
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

  it("the first actionable ticks after get-up are still invulnerable (no guaranteed meaty)", () => {
    let s = placed(1200);
    s = attack(s, B.D);
    while (s.f[1].st !== St.getup) s = step(s, 0, 0);
    while (s.f[1].st === St.getup) s = step(s, 0, 0);
    // First actionable tick: the waker can already act...
    expect(s.f[1].st).toBe(St.idle);
    const inv: boolean[] = [];
    for (let k = 0; k < F.wakeInvuln + 2; k++) {
      inv.push(isInvulnerable(s.f[1], RULES));
      s = step(s, 0, 0);
    }
    // ...and cannot be hit for `wakeInvuln` ticks.
    expect(inv).toEqual([...Array<boolean>(F.wakeInvuln).fill(true), false, false]);
  });

  it("a meaty dive kick after a slam knockdown never beats every wake-up option", () => {
    // P1 slams P2 from the start spot, then jumps J ticks after the hit and presses Space D ticks
    // later. Every timing that lands the dive on P2's first actionable ticks must be escapable by
    // one of: dash forward (under it), jump straight up, jump back.
    let base = fightingMatch("meaty");
    while (base.f[1].x - base.f[0].x > 1250) base = step(base, B.R, 0);
    base = step(base, B.D | B.S, 0);
    while (base.f[1].st !== St.launched) base = step(base, 0, 0);
    const hitAt = base.tick;
    let w = clone(base);
    while (w.f[1].st !== St.idle) w = step(w, 0, 0);
    const wake = w.tick;
    const fwd = (f: FighterState) => (f.facing > 0 ? B.R : B.L);
    const answers: ((f: FighterState) => number)[] = [
      (f) => (f.st === St.getup && (f.stTick === F.getup - 3 || f.stTick === F.getup) ? fwd(f) : 0),
      () => B.U,
      (f) => B.U | (f.facing > 0 ? B.L : B.R),
    ];
    const diveHits = (J: number, D: number, answer: (f: FighterState) => number): number => {
      let s = clone(base);
      for (let i = 0; i < 160; i++) {
        const k = s.tick - hitAt;
        const b1 = k < J ? fwd(s.f[0]) : k === J ? B.U | fwd(s.f[0]) : k === J + D ? B.S : 0;
        s = step(s, b1, answer(s.f[1]));
        if (s.f[1].hitT === s.tick && s.f[1].hitMv === Mv.dive_kick && s.f[1].hitKind === HitKind.hit) return s.tick;
      }
      return -1;
    };
    let meaties = 0;
    for (let J = wake - hitAt - 40; J <= wake - hitAt - 12; J++) {
      for (let D = 1; D <= 20; D++) {
        const t = diveHits(J, D, () => 0);
        if (t < wake || t > wake + 2) continue; // not a meaty on the wake-up
        meaties++;
        expect(answers.some((a) => diveHits(J, D, a) < 0), `meaty J=${J} D=${D}`).toBe(true);
      }
    }
    expect(meaties).toBeGreaterThan(0);
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

  it("the last step of a shove is not walled: from 8.1 units it rings out", () => {
    for (const x of [8001, 8100, 8200]) {
      let s = placed(1200, `edge-${x}`);
      s.f[1].x = x;
      s.f[0].x = x - 1200;
      s = attack(s, B.R);
      for (let t = 0; t < 60 && s.phase === Phase.fighting; t++) s = step(s, 0, 0);
      expect(s.reason, `shove hit at ${x}`).toBe(Reason.ringout);
      expect(s.f[1].st).toBe(St.ringOut);
    }
  });

  it("a shove that falls short still moves exactly 2 units, and the fighter stays beyond the wall", () => {
    let s = placed(1200);
    s.f[1].x = 7600;
    s.f[0].x = 6400;
    s = attack(s, B.R);
    for (let t = 0; t < 20 && s.f[1].hitKind === 0; t++) s = step(s, 0, 0);
    const x0 = s.f[1].x;
    s = run(s, 40);
    expect(s.phase).toBe(Phase.fighting);
    expect(s.f[1].x - x0).toBe(2000);
    expect(s.f[1].x).toBeGreaterThan(M.wallEdge);
    expect(s.f[1].roAble).toBe(0);
    // ...and can walk back in (but not further out).
    s = run(s, 10, 0, B.R);
    expect(s.f[1].x).toBe(x0 + 2000);
    s = run(s, 10, 0, B.L);
    expect(s.f[1].x).toBeLessThan(x0 + 2000);
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

  it("dive kick: from the gate air tick on, once per jump, 45 degrees, then its landing recovery", () => {
    const dk = mv(Mv.dive_kick);
    let s = placed(8000);
    s = step(s, B.U, 0);
    const airTick1 = s.tick;
    // A press early in the jump is not lost: it waits for the gate and the dive starts exactly there.
    s = step(s, B.S, 0); // air tick 2
    while (s.f[0].st === St.jump) s = step(s, 0, 0);
    expect(s.f[0].st).toBe(St.attack);
    expect(s.f[0].move).toBe(Mv.dive_kick);
    expect(s.tick - airTick1 + 1).toBe(dk.minAirTick); // (the height gate, minY, is long met by then)
    expect(s.f[0].y).toBeGreaterThanOrEqual(dk.minY);
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

  it("a dive kick can be answered on reaction: 16 ticks after the jump, a dash under or a back jump still escapes", () => {
    // Every gap a jump-in dive connects from, every dive timing: the defender (P2, facing left) starts
    // its answer 16 ticks (~0.27 s) after the jump press. With the dive allowed from air tick 4 the
    // same held for 8-13 ticks at most, which no one reacts in.
    const dived = (gap: number, d: number, answer: (t: number) => number) => {
      let s = placed(gap, "dive-react");
      for (let t = 0; t < 80; t++) {
        s = step(s, t === 0 ? B.U | B.R : t === d ? B.S : 0, answer(t));
        if (s.f[1].hitT === s.tick && s.f[1].hitMv === Mv.dive_kick && s.f[1].hitKind === HitKind.hit) return true;
      }
      return false;
    };
    const r = 16;
    const dashUnder = (t: number) => (t === r || t === r + 2 ? B.L : 0);
    const jumpBack = (t: number) => (t >= r ? B.U | B.R : 0);
    for (let gap = 1500; gap <= 3100; gap += 200) {
      expect(dived(gap, 1, () => 0), `a dive from ${gap} connects`).toBe(true);
      let dash = true;
      let jump = true;
      for (let d = 1; d <= 34; d++) {
        dash &&= !dived(gap, d, dashUnder);
        jump &&= !dived(gap, d, jumpBack);
      }
      expect(dash || jump, `an answer at tick ${r} escapes every dive from ${gap}`).toBe(true);
    }
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
  it("at full Heat, away+Space (walking back too) is a peck and keeps the meter; up+Space is still the super", () => {
    let s = full(placed(8000), 0);
    s = attack(s, B.L);
    expect(s.f[0].move).toBe(Mv.peck);
    expect(s.f[0].heat).toBe(RULES.heat.max);

    let w = full(placed(8000, "walkback"), 0);
    w = run(w, 10, B.L, 0);
    expect(w.f[0].st).toBe(St.walkB);
    w = attack(w, B.L);
    expect(w.f[0].move).toBe(Mv.peck);
    expect(w.f[0].heat).toBe(RULES.heat.max);

    let u = full(placed(8000, "up"), 0);
    u = attack(u, B.U);
    expect(u.f[0].move).toBe(Mv.super);
  });
  it("at full Heat, an away+Space peck that hits cancels into the super with a plain Space", () => {
    let s = full(placed(1100, "away-cancel"), 0);
    s = attack(s, B.L);
    expect(s.f[0].move).toBe(Mv.peck);
    let cancelled = false;
    for (let t = 0; t < 30 && !cancelled; t++) {
      const press = s.f[0].st === St.attack && s.f[0].stTick === 7 && s.f[0].hitstop === 0;
      s = step(s, press ? B.S : 0, 0);
      cancelled = s.f[0].move === Mv.super;
    }
    expect(s.f[1].hitKind).toBe(HitKind.hit);
    expect(cancelled).toBe(true);
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
