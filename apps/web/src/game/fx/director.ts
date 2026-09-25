import { Mv, Phase, RULES, St, reasonLabel, type FighterState, type MatchState, type MoveRules, type SimEvent } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import type { SoundName } from "../audio/names";
import type { HudStore } from "../hud/hudStore";
import type { FightCamera } from "../view/camera/FightCamera";
import type { KoPulse } from "./KoPulse";
import type { Particles } from "./Particles";
import { recipeFor } from "./fxTable";

/** Audio as the director sees it; the WebAudio engine implements this. */
export interface AudioSink {
  play(name: SoundName, opts?: { pan?: number; seed?: number }): void;
  setHype(h: number): void;
}

/** Crowd / arena reaction; the junkyard arena implements this. */
export interface HypeSink {
  setHype(h: number): void;
}

const MU = 1000;

/** Space pressed now would dive: the sim's dive rule (fighter.ts), with a press in the rise waiting for it. */
function canDive(f: FighterState): boolean {
  const dive = RULES.moves[Mv.dive_kick] as MoveRules;
  return f.st === St.jump && f.grounded === 0 && f.diveUsed === 0 && (f.vy > 0 || f.y >= dive.minY);
}

/**
 * Turns sim events into juice: particles, sound, camera, crowd and HUD. Runs
 * once per sim tick (fixed dt) so the result is deterministic from the event
 * stream; per-frame work (fx clocks) happens in frame().
 */
export class Director {
  audio: AudioSink | null = null;
  hype: HypeSink | null = null;
  private hypeLevel = 0.2;
  private spike = 0;
  private readonly recent: SoundName[] = [];
  private lastTimerSec = -1;
  private readonly seed: number;
  private readonly camera: FightCamera;
  private readonly particles: Particles;
  private readonly ko: KoPulse;
  private readonly hud: HudStore;
  private readonly tiers: [Tier, Tier];

  constructor(opts: { camera: FightCamera; particles: Particles; ko: KoPulse; hud: HudStore; seed: number; tiers?: [Tier, Tier] }) {
    this.tiers = opts.tiers ?? ["rust", "rust"];
    this.camera = opts.camera;
    this.particles = opts.particles;
    this.ko = opts.ko;
    this.hud = opts.hud;
    this.seed = opts.seed >>> 0;
  }

  /** Recently played sounds, newest last (debug / e2e). */
  get recentSounds(): readonly SoundName[] {
    return this.recent;
  }

  private play(name: SoundName, pan: number, seed: number): void {
    this.recent.push(name);
    if (this.recent.length > 32) this.recent.shift();
    this.audio?.play(name, { pan, seed });
  }

  tick(s: MatchState, events: readonly SimEvent[]): void {
    const hpMax = RULES.fighter.hpMax;
    const heatMax = RULES.heat.max;
    const [f0, f1] = s.f;
    for (let k = 0; k < events.length; k++) {
      const e = events[k] as SimEvent;
      const r = recipeFor(e, hpMax);
      const seed = (Math.imul(this.seed ^ s.tick, 0x9e3779b1) + k) >>> 0;
      const ex = e.kind === "hit" ? e.x / MU : e.kind === "ko" || e.kind === "ringOut" || e.kind === "land" || e.kind === "jump" || e.kind === "dash" ? (s.f[e.side].x / MU) : 0;
      const ey = e.kind === "hit" ? e.y / MU : 0.1;
      const pan = Math.max(-1, Math.min(1, ex / 10)) * 0.6;
      for (const snd of r.sounds) this.play(snd, pan, seed);
      const dir = e.kind === "hit" ? (s.f[e.by].facing) : 1;
      // Gold tier: hits throw extra sparks (cosmetic only).
      const sparkMul = e.kind === "hit" && this.tiers[e.by] === "gold" ? 2 : 1;
      for (const b of r.bursts) this.particles.burst(b.kind, b.kind === "spark" ? b.count * sparkMul : b.count, ex, ey, dir, seed ^ b.count);
      if (r.trauma) this.camera.addTrauma(r.trauma);
      if (e.kind === "hit") {
        this.camera.onHit((e.damage * 100) / hpMax, dir);
        this.hud.flash(e.side);
      }
      if (r.hype) this.spike = Math.min(1, this.spike + r.hype);
      this.onEvent(e, s);
    }

    // Chrome tier: a dash leaves a light trail.
    for (let i = 0; i < 2; i++) {
      const f = s.f[i] as MatchState["f"][0];
      if (this.tiers[i] === "chrome" && (f.st === St.dashF || f.st === St.dashB) && f.stTick <= 10 && f.hitstop === 0) {
        this.particles.burst("trail", 2, f.x / MU, f.y / MU + 0.7, 0, (this.seed ^ Math.imul(s.tick, 31) ^ i) >>> 0);
      }
    }

    // Camera and crowd follow the fight every tick.
    this.camera.tick(f0.x / MU, f1.x / MU, f0.y / MU, f1.y / MU);
    this.spike = Math.max(0, this.spike - 0.6 / 60);
    const target = Math.min(1, 0.2 + ((f0.heat + f1.heat) / (2 * heatMax)) * 0.4 + this.spike);
    this.hypeLevel += (target - this.hypeLevel) * 0.08;
    this.hype?.setHype(this.hypeLevel);
    this.audio?.setHype(this.hypeLevel);

    // HUD: hot bars every tick, cold values when they change.
    const touchP1 = this.hud.get().mode === "cpu";
    this.hud.setBar("hp0", f0.hp / hpMax);
    this.hud.setBar("hp1", f1.hp / hpMax);
    this.hud.setBar("trail0", f0.hp / hpMax);
    this.hud.setBar("trail1", f1.hp / hpMax);
    this.hud.setBar("heat0", f0.heat / heatMax);
    this.hud.setBar("heat1", f1.heat / heatMax);
    const timerSec = s.phase === Phase.fighting ? Math.ceil(s.timer / 60) : s.phase === Phase.countdown ? Math.ceil(RULES.match.round / 60) : this.lastTimerSec;
    this.lastTimerSec = timerSec;
    this.hud.set({
      phase: s.phase,
      round: s.round,
      timerSec,
      sd: s.sd === 1,
      wins: [s.w1, s.w2],
      heatFull: [f0.heat >= heatMax, f1.heat >= heatMax],
      air: touchP1 && f0.grounded === 0,
      dive: touchP1 && canDive(f0),
      matchWinner: s.matchWinner,
    });
  }

  private onEvent(e: SimEvent, s: MatchState): void {
    switch (e.kind) {
      case "countdown":
        this.hud.banner(String(e.n));
        break;
      case "fight":
        this.hud.banner(s.sd ? "SUDDEN DEATH" : "FIGHT!");
        break;
      case "roundStart":
        this.hud.banner(`ROUND ${e.round}`);
        break;
      case "suddenDeath":
        this.hud.banner("SUDDEN DEATH");
        break;
      case "attack":
        if (e.move === 5) this.camera.onSuper();
        break;
      case "ko":
      case "ringOut":
        this.ko.trigger();
        this.camera.onKo(s.f[e.side].x / MU);
        break;
      case "roundEnd": {
        const perfect = e.winner < 2 && s.f[e.winner as 0 | 1].hp === RULES.fighter.hpMax;
        const label = reasonLabel(e.reason);
        this.hud.banner(perfect && (e.reason === 1 || e.reason === 2) ? `${label} PERFECT` : label || "ROUND OVER", "ko");
        break;
      }
      case "matchEnd":
        this.hud.banner(e.winner === 2 ? "DRAW" : `${this.hud.get().names[e.winner as 0 | 1]} WINS`, "win");
        break;
      default:
        break;
    }
  }

  /** Per rendered frame (real time): fx clocks keep running through hit-stop. */
  frame(dt: number): void {
    this.particles.advance(dt);
    this.ko.advance(dt);
  }
}
