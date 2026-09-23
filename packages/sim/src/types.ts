/**
 * Core state types. Every field is an integer (int32 range) so the state can be
 * serialized to an Int32Array and hashed bit-for-bit on any JS engine.
 *
 * Units: positions in mu (1/1000 game unit), velocities in mu/tick, HP x100,
 * Heat x60, time in ticks at 60 Hz. Booleans are 0/1.
 */

/** Wire input bitmask. */
export const B = { L: 1, R: 2, U: 4, D: 8, S: 16 } as const;
export const BUTTON_MASK = 31;

export const Phase = { countdown: 0, fighting: 1, roundEnd: 2, matchEnd: 3 } as const;
export type PhaseId = (typeof Phase)[keyof typeof Phase];

/** Fighter state machine. Values are part of the hash layout; append only. */
export const St = {
  idle: 0,
  walkF: 1,
  walkB: 2,
  dashF: 3,
  dashB: 4,
  jump: 5,
  fall: 6,
  land: 7,
  block: 8,
  blockStun: 9,
  attack: 10,
  hitStun: 11,
  launched: 12,
  knockdown: 13,
  getup: 14,
  ko: 15,
  ringOut: 16,
  win: 17,
} as const;
export type StId = (typeof St)[keyof typeof St];

/** Move ids, index into the compiled move table. Append only. */
export const Mv = { none: 0, peck: 1, shove: 2, slam: 3, dive_kick: 4, super: 5 } as const;
export type MvId = (typeof Mv)[keyof typeof Mv];
export const MOVE_NAMES = ["none", "peck", "shove", "slam", "dive_kick", "super"] as const;
export type MoveName = Exclude<(typeof MOVE_NAMES)[number], "none">;

export const Reason = {
  none: 0,
  ko: 1,
  ringout: 2,
  timeout: 3,
  suddenDeath: 4,
  doubleKo: 5,
  sdExpired: 6,
} as const;
export type ReasonId = (typeof Reason)[keyof typeof Reason];

/** Contact kinds recorded on the defender for presentation. */
export const HitKind = { none: 0, hit: 1, block: 2 } as const;

export interface FighterState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** +1 faces +x, -1 faces -x. */
  facing: number;
  grounded: number;
  hp: number;
  heat: number;
  st: StId;
  /** Ticks spent in the current state (1 on the first tick). For attacks, the move frame. */
  stTick: number;
  move: MvId;
  /** Frozen ticks remaining (hit-stop). */
  hitstop: number;
  /** Hitstun / blockstun ticks remaining. */
  stun: number;
  /** Generic invulnerability ticks remaining (get-up). */
  invuln: number;
  /** The current move has already connected: 0 = not yet, 1 = hit, 2 = blocked. */
  hitDone: number;
  /** A dive kick was used during this jump. */
  diveUsed: number;
  /** Set by a ring-out capable hit; passing the ring edge while set is a ring-out. */
  roAble: number;
  /** Knockback slide speed (mu/tick, signed). */
  slideV: number;
  /** Knockback slide distance remaining (mu, >= 0). */
  slideRem: number;
  /** SOCD-cleaned buttons held this tick (previous tick's value during readInput). */
  held: number;
  /** Ticks since the last L / R press edge (saturates at 255). */
  tapL: number;
  tapR: number;
  /** Space press buffer, ticks remaining. */
  bufS: number;
  /** Pending dash in world direction: -1, 0, +1. */
  dashReq: number;
  /** Last contact received: tick, move, kind (HitKind). Presentation reads these. */
  hitT: number;
  hitMv: MvId;
  hitKind: number;
  /** Raw buttons held this tick, before SOCD cleaning (press edges and dash taps read these). */
  rawHeld: number;
  /** Direction bits (L/R/D, world space) held when the buffered Space press went down. */
  bufDir: number;
  /** Where the last contact landed on this fighter (x, mu). Presentation only. */
  hitX: number;
}

export interface MatchState {
  v: number;
  tick: number;
  phase: PhaseId;
  /** Ticks remaining in countdown / roundEnd. */
  phaseT: number;
  /** Round clock, ticks remaining while fighting. */
  timer: number;
  /** Sudden death active. */
  sd: number;
  round: number;
  w1: number;
  w2: number;
  /** -1 = none yet, 0 = P1, 1 = P2, 2 = draw. */
  roundWinner: number;
  reason: ReasonId;
  /** -1 = undecided, 0 = P1, 1 = P2, 2 = draw. */
  matchWinner: number;
  rng: number;
  f: [FighterState, FighterState];
}

export interface MatchInit {
  matchId: string;
}
