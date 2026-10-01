/**
 * The shot list. Fight scripts run in the page (stringified), so each one is
 * self-contained: no imports, no closures. `t` is ticks since FIGHT, `s` the
 * sim state (positions in mu: 1000 = one unit; the ring edge is at ±10000,
 * fighters start at ∓2500), `B` the button bits. The beats are written as
 * tiny state machines off the live state, never off hard-coded tick counts,
 * so a rules change re-shoots correctly.
 */
import type { FightScript, Viewport } from "./rig";
import { DESKTOP, PHONE, PHONE_LANDSCAPE } from "./rig";

export interface FightShotDef {
  kind: "fight";
  name: string;
  /** /play query (mode=2p&manual=1&debug=1 are added). */
  query?: string;
  viewport?: Viewport;
  script: FightScript;
  ticks: number;
  /** Start capturing this many ticks after FIGHT (walk-ups are boring). */
  from?: number;
  note?: string;
}
export interface StillShotDef {
  kind: "still";
  name: string;
  url: string;
  viewport?: Viewport;
  fullPage?: boolean;
  note?: string;
}
export interface LiveShotDef {
  kind: "live";
  name: string;
  url: string;
  viewport?: Viewport;
  seconds: number;
  fps?: number;
  note?: string;
}
export interface CardShotDef {
  kind: "card";
  name: string;
  /** Relative to tools/video/cards. */
  file: string;
  frames: number;
  note?: string;
}
export type ShotDef = FightShotDef | StillShotDef | LiveShotDef | CardShotDef;

/* ---------- fight beats ---------- */

/** Walk in, one clean peck on the chin, hold the pose. */
const peck: FightScript = (t, s, B) => {
  const me = s.f[0], op = s.f[1];
  const dx = op.x - me.x;
  const toward = dx > 0 ? B.R : B.L;
  let p1 = 0;
  if (Math.abs(dx) > 1500) p1 = toward;
  else if (me.st === 0 && t % 20 === 0) p1 = B.S; // one press, no direction
  return [p1, 0];
};

/** P2 walks in; P1 meets with a shove that sends them sliding. */
const shove: FightScript = (t, s, B) => {
  const me = s.f[0], op = s.f[1];
  const dx = op.x - me.x;
  const toward = dx > 0 ? B.R : B.L;
  const away = dx > 0 ? B.L : B.R;
  const p2 = Math.abs(dx) > 1600 ? away /* P2's toward is our away */ : 0;
  let p1 = 0;
  if (Math.abs(dx) <= 1600 && Math.abs(dx) > 1000 && op.st !== 12 && op.st !== 13) p1 = toward;
  else if (Math.abs(dx) <= 1000 && me.st === 0 && t % 12 === 0) p1 = toward | B.S;
  return [p1, p2];
};

/** Dash in (double-tap toward) and peck out of the dash. */
const dashPeck: FightScript = (t, s, B) => {
  const me = s.f[0], op = s.f[1];
  const dx = op.x - me.x;
  const toward = dx > 0 ? B.R : B.L;
  // double tap: down, up, down within 12 ticks, then hold toward to close
  let p1 = 0;
  if (t < 3) p1 = toward;
  else if (t < 6) p1 = 0;
  else if (t < 18) p1 = toward;
  else if (Math.abs(dx) > 1000) p1 = toward;
  else if (me.st === 0 && t % 10 === 0) p1 = B.S;
  const p2 = t < 40 && Math.abs(dx) > 2000 ? (dx > 0 ? B.L : B.R) : 0;
  return [p1, p2];
};

/** The slam: P2 blocks low (so a peck would bounce), P1 lands the unblockable slam → launch. */
const slam: FightScript = (t, s, B) => {
  const me = s.f[0], op = s.f[1];
  const dx = op.x - me.x;
  const toward = dx > 0 ? B.R : B.L;
  const p2 = Math.abs(dx) < 2200 ? B.D : 0; // hold block: shows the slam ignores it
  let p1 = 0;
  if (Math.abs(dx) > 1200) p1 = toward;
  else if (me.st === 0 && t % 10 === 0) p1 = B.D | B.S;
  return [p1, p2];
};

/** Jump toward, dive kick from the top of the arc. */
const diveKick: FightScript = (t, s, B) => {
  const me = s.f[0], op = s.f[1];
  const dx = op.x - me.x;
  const toward = dx > 0 ? B.R : B.L;
  let p1 = 0;
  if (Math.abs(dx) > 3200 && me.grounded) p1 = toward;
  else if (me.grounded && me.st === 0) p1 = toward | B.U; // jump toward
  else if (!me.grounded) p1 = B.S; // held: the dive waits for the 14th air tick
  return [p1, 0];
};

/** Ring-out: P2 is walked to the edge by shoves; the last one carries them over. */
const ringOut: FightScript = (t, s, B) => {
  const me = s.f[0], op = s.f[1];
  const dx = op.x - me.x;
  const toward = dx > 0 ? B.R : B.L;
  let p1 = 0;
  const op_ok = op.st === 0 || op.st === 1 || op.st === 2 || op.st === 8;
  if (Math.abs(dx) > 1300) p1 = toward;
  else if (me.st === 0 && op_ok && t % 8 === 0) p1 = toward | B.S;
  // P2 tries to walk back in between shoves, so it reads as a fight, not a shove-fest
  const p2 = op.st === 0 && Math.abs(dx) > 1300 ? (dx > 0 ? B.L : B.R) : 0;
  return [p1, p2];
};

/** Build Heat with pecks on a blocking opponent, then the Rooster Rocket for the KO. */
const superKo: FightScript = (t, s, B) => {
  const me = s.f[0], op = s.f[1];
  const dx = op.x - me.x;
  const toward = dx > 0 ? B.R : B.L;
  const full = me.heat >= 6000;
  let p1 = 0;
  if (full) {
    if (Math.abs(dx) > 5000) p1 = toward; // the rocket is screen-wide, but stay in frame
    else if (me.st === 0 && t % 6 === 0) p1 = B.S; // neutral + PECK at full Heat = super
  } else if (Math.abs(dx) > 1100) p1 = toward;
  else if (me.st === 0 && t % 16 === 0) p1 = B.S;
  // P2 backs off when it can (it mostly can't: hit-stun), so it reads as a beating, not a dummy
  const p2 = Math.abs(dx) < 2500 ? (dx > 0 ? B.R : B.L) : 0; // held, never re-pressed: a walk, not a dash
  return [p1, p2];
};

/** Both chickens trade: for the wide "two fighters" shots and the loop. */
const brawl: FightScript = (t, s, B) => {
  const a = s.f[0], b = s.f[1];
  const dx = b.x - a.x;
  const tow1 = dx > 0 ? B.R : B.L;
  const tow2 = dx > 0 ? B.L : B.R;
  let p1 = 0, p2 = 0;
  if (Math.abs(dx) > 1400) { p1 = tow1; p2 = tow2; }
  else {
    if (a.st === 0 && t % 14 === 0) p1 = (t % 42 === 0 ? tow1 : 0) | B.S;
    if (b.st === 0 && t % 14 === 7) p2 = (t % 28 === 7 ? B.D : 0);
    if (b.st === 0 && t % 30 === 15) p2 = B.S;
  }
  return [p1, p2];
};

const fight = (name: string, script: FightScript, ticks: number, extra: Partial<FightShotDef> = {}): FightShotDef => ({
  kind: "fight", name, script, ticks, viewport: DESKTOP, ...extra,
});

export const SHOTS: ShotDef[] = [
  fight("peck", peck, 240, { note: "walk-in, one peck", from: 10 }),
  fight("shove", shove, 240, { note: "shove slide" }),
  fight("dash-peck", dashPeck, 200, { note: "dash in + peck" }),
  fight("slam", slam, 300, { note: "unblockable slam launch, slow-mo candidate" }),
  fight("dive-kick", diveKick, 240, { note: "jump + dive kick" }),
  fight("ring-out", ringOut, 900, { from: 560, note: "shoved to the edge and over; ends the round" }),
  fight("super-ko", superKo, 760, { note: "heat build + Rooster Rocket KO" }),
  fight("brawl", brawl, 600, { note: "trading, for wides and the loop" }),
  fight("phone-brawl", brawl, 600, { viewport: PHONE_LANDSCAPE, query: "touch=1", note: "sideways phone, buttons in the corners" }),
  fight("phone-portrait", diveKick, 240, { viewport: PHONE, query: "touch=1", note: "upright phone with the controller panel" }),
  { kind: "still", name: "home", url: "/", viewport: DESKTOP, fullPage: true, note: "front page, pool panel" },
  { kind: "live", name: "home-live", url: "/", seconds: 6, note: "pool ticking" },
  { kind: "still", name: "play-menu", url: "/play", note: "mode select" },
  { kind: "still", name: "leaderboard", url: "/leaderboard", fullPage: true },
  { kind: "live", name: "leaderboard-live", url: "/leaderboard", seconds: 6, note: "countdown" },
  { kind: "still", name: "how-it-works", url: "/how-it-works", fullPage: true },
  { kind: "still", name: "home-phone", url: "/", viewport: PHONE, fullPage: true },
  // title cards (alpha PNG sequences; 2 s each, the edit trims)
  ...["logo", "t-1v1", "t-phone", "t-paid", "t-hold", "end", "x-split", "x-tiers", "x-top10", "x-safe", "x-play"].map(
    (c): CardShotDef => ({ kind: "card", name: "card-" + c, file: c + ".html", frames: c.startsWith("x-") || c === "end" ? 150 : 120 }),
  ),
];
