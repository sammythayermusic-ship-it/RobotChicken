/**
 * Presentation events, derived by diffing two consecutive states. Events are
 * not part of the state and never hashed; the renderer, audio and camera react
 * to them. Pure, so a replay produces exactly the same event stream.
 */
import { idiv } from "./fixed";
import { HitKind, Mv, Phase, Reason, St, type FighterState, type MatchState, type MvId, type ReasonId } from "./types";

export type SimEvent =
  | { kind: "countdown"; n: number }
  | { kind: "fight"; round: number; suddenDeath: boolean }
  | { kind: "attack"; side: 0 | 1; move: MvId }
  | { kind: "hit"; side: 0 | 1; by: 0 | 1; move: MvId; blocked: boolean; damage: number; x: number; y: number }
  | { kind: "jump"; side: 0 | 1 }
  | { kind: "land"; side: 0 | 1; heavy: boolean }
  | { kind: "dash"; side: 0 | 1; back: boolean }
  | { kind: "heatFull"; side: 0 | 1 }
  | { kind: "ko"; side: 0 | 1 }
  | { kind: "ringOut"; side: 0 | 1 }
  | { kind: "suddenDeath" }
  | { kind: "roundEnd"; winner: number; reason: ReasonId; round: number }
  | { kind: "roundStart"; round: number }
  | { kind: "matchEnd"; winner: number };

export type SimEventKind = SimEvent["kind"];
export const SIM_EVENT_KINDS: readonly SimEventKind[] = [
  "countdown",
  "fight",
  "attack",
  "hit",
  "jump",
  "land",
  "dash",
  "heatFull",
  "ko",
  "ringOut",
  "suddenDeath",
  "roundEnd",
  "roundStart",
  "matchEnd",
];

const side = (i: number) => (i === 0 ? 0 : 1);

export function deriveEvents(prev: MatchState, next: MatchState, heatMax: number): SimEvent[] {
  const ev: SimEvent[] = [];

  if (next.round !== prev.round && next.phase === Phase.countdown) ev.push({ kind: "roundStart", round: next.round });
  if (next.phase === Phase.countdown) {
    // 3, 2, 1 on the second boundaries of the countdown.
    const secs = (t: number) => idiv(t + 59, 60);
    // The first number shows on the countdown's first tick (match start or a new round).
    if (secs(next.phaseT) !== secs(prev.phaseT) || next.round !== prev.round || prev.tick === 0) {
      const n = secs(next.phaseT);
      if (n >= 1 && n <= 3) ev.push({ kind: "countdown", n });
    }
  }
  if (prev.phase === Phase.countdown && next.phase === Phase.fighting) {
    ev.push({ kind: "fight", round: next.round, suddenDeath: false });
  }
  if (!prev.sd && next.sd) ev.push({ kind: "suddenDeath" });

  for (let i = 0; i < 2; i++) {
    const a = prev.f[i] as FighterState;
    const b = next.f[i] as FighterState;
    const o = next.f[1 - i] as FighterState;
    if (b.st === St.attack && (a.st !== St.attack || a.move !== b.move || b.stTick < a.stTick)) {
      ev.push({ kind: "attack", side: side(i), move: b.move });
    }
    if (b.hitT !== a.hitT && b.hitT === next.tick && b.hitKind !== HitKind.none) {
      ev.push({
        kind: "hit",
        side: side(i),
        by: side(1 - i),
        move: b.hitMv,
        blocked: b.hitKind === HitKind.block,
        damage: Math.max(0, a.hp - b.hp),
        x: (b.x + o.x) >> 1,
        y: b.y + 800,
      });
    }
    if (b.st === St.jump && a.st !== St.jump) ev.push({ kind: "jump", side: side(i) });
    if (a.grounded === 0 && b.grounded === 1) {
      ev.push({ kind: "land", side: side(i), heavy: b.st === St.knockdown || (a.st === St.attack && a.move === Mv.dive_kick) });
    }
    if ((b.st === St.dashF || b.st === St.dashB) && b.stTick === 1) ev.push({ kind: "dash", side: side(i), back: b.st === St.dashB });
    if (a.heat < heatMax && b.heat >= heatMax) ev.push({ kind: "heatFull", side: side(i) });
    if (b.st === St.ko && a.st !== St.ko) ev.push({ kind: "ko", side: side(i) });
    if (b.st === St.ringOut && a.st !== St.ringOut) ev.push({ kind: "ringOut", side: side(i) });
  }

  if (prev.phase === Phase.fighting && next.phase === Phase.roundEnd) {
    ev.push({ kind: "roundEnd", winner: next.roundWinner, reason: next.reason, round: next.round });
  }
  if (prev.phase !== Phase.matchEnd && next.phase === Phase.matchEnd) ev.push({ kind: "matchEnd", winner: next.matchWinner });
  return ev;
}

/** Human label for a round-end reason (HUD banners). */
export function reasonLabel(r: ReasonId): string {
  switch (r) {
    case Reason.ko:
      return "K.O.";
    case Reason.ringout:
      return "RING OUT";
    case Reason.timeout:
      return "TIME";
    case Reason.suddenDeath:
      return "SUDDEN DEATH";
    case Reason.doubleKo:
      return "DOUBLE K.O.";
    case Reason.sdExpired:
      return "DRAW";
    default:
      return "";
  }
}
