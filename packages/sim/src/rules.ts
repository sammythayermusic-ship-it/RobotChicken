/**
 * Compiles the JSON data (moves.json, hitboxes.json, chicken.contract.json)
 * into plain integer tables the sim reads by index. The sim never iterates a
 * JSON object at runtime; everything order-sensitive happens here, in an
 * explicit order, and the result is hashed into `rulesHash` so a replay can
 * refuse to run against different rules.
 */
import movesJson from "../data/moves.json" with { type: "json" };
import hitboxesJson from "../data/hitboxes.json" with { type: "json" };
import contractJson from "../data/chicken.contract.json" with { type: "json" };
import { fnvInit, fnvInt, fnvInts, fnvHex } from "./hash";
import { Mv, MOVE_NAMES, type MoveName, type MvId } from "./types";

/** The 21 animation clips every chicken must ship, in contract order. */
export const CLIP_NAMES = [
  "idle",
  "walk_fwd",
  "walk_back",
  "dash",
  "jump",
  "fall",
  "land",
  "block",
  "block_hit",
  "peck",
  "dive_kick",
  "slam",
  "shove",
  "super",
  "hit_light",
  "hit_heavy",
  "knockdown",
  "getup",
  "ko",
  "win",
  "entrance",
] as const;
export type ClipName = (typeof CLIP_NAMES)[number];

export const Clip = Object.fromEntries(CLIP_NAMES.map((n, i) => [n, i])) as { readonly [K in ClipName]: number };

export interface Box {
  x: number;
  y: number;
  r: number;
}

export interface MoveRules {
  id: MvId;
  name: MoveName;
  clip: number;
  startup: number;
  active: number;
  recovery: number;
  total: number;
  damage: number;
  blockable: boolean;
  hitsAir: boolean;
  ringOut: boolean;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  blockHitstop: number;
  /** [distance mu, ticks] */
  hitPush: [number, number];
  blockPush: [number, number];
  /** [vx, vy] or null */
  launch: [number, number] | null;
  heatHit: number;
  heatBlock: number;
  /** Bitmask of move ids this move can cancel into on hit (1 << id). */
  cancelMask: number;
  cancelFrom: number;
  cancelTo: number;
  /** Inclusive frame range of self-invulnerability, [0,0] = none. */
  invuln: [number, number];
  heatCost: number;
  /** Super: hits any hurtbox with y <= this anywhere. 0 = not full screen. */
  fullScreenMaxY: number;
  dive: [number, number];
  minAirTick: number;
  minY: number;
  bounce: [number, number];
  /** Fallback hit sphere (attacker space, facing +x) when no baked hitbox exists. */
  box: Box;
}

export interface ClipRules {
  id: number;
  name: ClipName;
  frames: number;
  loop: boolean;
  /** Authored phase split [startup, active, recovery] or null. */
  phases: [number, number, number] | null;
  /** Baked hurt capsules, (frames + 1) x [ax, ay, bx, by, r], or null. */
  hurt: Int32Array | null;
  /** Baked hit spheres for the move's hit node, (frames + 1) x [x, y, r], or null. */
  hit: Int32Array | null;
}

export interface Rules {
  match: {
    countdown: number;
    round: number;
    roundEnd: number;
    suddenDeath: number;
    winsNeeded: number;
    maxRounds: number;
    startX: number;
    wallEdge: number;
    ringEdge: number;
    ringOutFloor: number;
  };
  heat: { max: number; onHit: number; onBlock: number; decayPerTick: number; latchAtMax: boolean };
  fighter: {
    hpMax: number;
    gravity: number;
    walkFwd: number;
    walkBack: number;
    inputBuffer: number;
    pushHalfW: number;
    pushH: number;
    hurtFallback: { ax: number; ay: number; bx: number; by: number; r: number };
    jumpVy: number;
    jumpVxFwd: number;
    jumpVxBack: number;
    jumpAirTicks: number;
    landLag: number;
    dashWindow: number;
    dashDuration: number;
    dashInvuln: [number, number];
    dashFwdSpeed: number;
    dashFwdFrames: number;
    dashBackSpeed: number;
    dashBackFrames: number;
    chipPct: number;
    knockdownLie: number;
    getup: number;
  };
  /** Indexed by Mv id; index 0 (none) is unused. */
  moves: MoveRules[];
  clips: ClipRules[];
  /** Moves whose hit sphere falls back to the static `box` (no baked hitbox). */
  fallbacks: string[];
  hash: string;
}

type MovesJson = typeof movesJson;
type HitboxesJson = { v: number; source: { file: string; sha256: string }; clips: Record<string, unknown> };
type ContractJson = typeof contractJson;

interface RawMove {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  blockable: boolean;
  hitsAir: boolean;
  ringOut: boolean;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  blockHitstop: number;
  onHit: { push?: number[]; launch?: number[] };
  onBlock: { push?: number[] };
  cancel?: { into: string[]; from: number; to: number };
  heatGain?: number[];
  invuln?: number[];
  heatCost?: number;
  fullScreenMaxY?: number;
  dive?: number[];
  minAirTick?: number;
  minY?: number;
  bounce?: number[];
  hitNode?: string;
  box: Box;
}

interface RawClipBoxes {
  n: number;
  hurt: number[];
  hit?: Record<string, number[]>;
}

const pair = (a: number[] | undefined, d: [number, number]): [number, number] =>
  a && a.length === 2 ? [a[0] as number, a[1] as number] : d;

function moveClip(name: MoveName): number {
  return Clip[name];
}

export function compileRules(
  moves: MovesJson = movesJson,
  hitboxes: HitboxesJson = hitboxesJson as HitboxesJson,
  contract: ContractJson = contractJson,
): Rules {
  const m = moves.match;
  const h = moves.heat;
  const f = moves.fighter;
  const rawMoves = moves.moves as unknown as Record<MoveName, RawMove>;
  const rawClips = hitboxes.clips as Record<string, RawClipBoxes | undefined>;

  const clips: ClipRules[] = CLIP_NAMES.map((name, id) => {
    const c = contract.clips.find((x) => x.name === name);
    if (!c) throw new Error(`contract is missing clip ${name}`);
    const phases = "phases" in c && Array.isArray(c.phases) ? (c.phases as number[]) : null;
    const baked = rawClips[name];
    let hurt: Int32Array | null = null;
    let hit: Int32Array | null = null;
    if (baked) {
      if (baked.n !== c.frames) throw new Error(`hitboxes.json clip ${name}: n=${baked.n}, contract frames=${c.frames}`);
      if (baked.hurt.length !== (c.frames + 1) * 5) throw new Error(`hitboxes.json clip ${name}: bad hurt length`);
      hurt = Int32Array.from(baked.hurt);
      const beak = baked.hit?.["hit_beak"];
      if (beak) {
        if (beak.length !== (c.frames + 1) * 3) throw new Error(`hitboxes.json clip ${name}: bad hit length`);
        hit = Int32Array.from(beak);
      }
    }
    return {
      id,
      name,
      frames: c.frames,
      loop: c.loop,
      phases: phases ? [phases[0] as number, phases[1] as number, phases[2] as number] : null,
      hurt,
      hit,
    };
  });

  const fallbacks: string[] = [];
  const moveTable: MoveRules[] = [];
  for (let id = 1; id < MOVE_NAMES.length; id++) {
    const name = MOVE_NAMES[id] as MoveName;
    const r = rawMoves[name];
    if (!r) throw new Error(`moves.json is missing ${name}`);
    const clip = moveClip(name);
    if (!(clips[clip]?.hit)) fallbacks.push(name);
    let cancelMask = 0;
    for (const into of r.cancel?.into ?? []) {
      const target = MOVE_NAMES.indexOf(into as MoveName);
      if (target <= 0) throw new Error(`moves.json ${name}: unknown cancel target ${into}`);
      cancelMask |= 1 << target;
    }
    moveTable[id] = {
      id: id as MvId,
      name,
      clip,
      startup: r.startup,
      active: r.active,
      recovery: r.recovery,
      total: r.startup + r.active + r.recovery,
      damage: r.damage,
      blockable: r.blockable,
      hitsAir: r.hitsAir,
      ringOut: r.ringOut,
      hitstun: r.hitstun,
      blockstun: r.blockstun,
      hitstop: r.hitstop,
      blockHitstop: r.blockHitstop,
      hitPush: pair(r.onHit.push, [0, 1]),
      blockPush: pair(r.onBlock.push, [0, 1]),
      launch: r.onHit.launch ? pair(r.onHit.launch, [0, 0]) : null,
      heatHit: r.heatGain ? (r.heatGain[0] as number) : h.onHit,
      heatBlock: r.heatGain ? (r.heatGain[1] as number) : h.onBlock,
      cancelMask,
      cancelFrom: r.cancel?.from ?? 0,
      cancelTo: r.cancel?.to ?? 0,
      invuln: pair(r.invuln, [0, 0]),
      heatCost: r.heatCost ?? 0,
      fullScreenMaxY: r.fullScreenMaxY ?? 0,
      dive: pair(r.dive, [0, 0]),
      minAirTick: r.minAirTick ?? 0,
      minY: r.minY ?? 0,
      bounce: pair(r.bounce, [0, 0]),
      box: { x: r.box.x, y: r.box.y, r: r.box.r },
    };
  }
  // Index 0 is a placeholder so moves[Mv.x] works; it is never used.
  moveTable[0] = { ...(moveTable[Mv.peck] as MoveRules), id: Mv.none as MvId };

  const rules: Rules = {
    match: { ...m },
    heat: { ...h },
    fighter: {
      hpMax: f.hpMax,
      gravity: f.gravity,
      walkFwd: f.walkFwd,
      walkBack: f.walkBack,
      inputBuffer: f.inputBuffer,
      pushHalfW: f.pushbox.halfW,
      pushH: f.pushbox.h,
      hurtFallback: { ...f.hurtFallback },
      jumpVy: f.jump.vy,
      jumpVxFwd: f.jump.vxFwd,
      jumpVxBack: f.jump.vxBack,
      jumpAirTicks: f.jump.airTicks,
      landLag: f.jump.landLag,
      dashWindow: f.dash.window,
      dashDuration: f.dash.duration,
      dashInvuln: pair(f.dash.invuln, [0, 0]),
      dashFwdSpeed: f.dash.fwd.speed,
      dashFwdFrames: f.dash.fwd.frames,
      dashBackSpeed: f.dash.back.speed,
      dashBackFrames: f.dash.back.frames,
      chipPct: f.block.chipPct,
      knockdownLie: f.knockdown.lie,
      getup: f.knockdown.getup,
    },
    moves: moveTable,
    clips,
    fallbacks,
    hash: "",
  };
  rules.hash = rulesHash(rules);
  return rules;
}

/** Explicit, ordered integer serialization of everything gameplay depends on. */
export function rulesTable(R: Rules): number[] {
  const t: number[] = [];
  const b = (v: boolean) => (v ? 1 : 0);
  const m = R.match;
  t.push(m.countdown, m.round, m.roundEnd, m.suddenDeath, m.winsNeeded, m.maxRounds, m.startX, m.wallEdge, m.ringEdge, m.ringOutFloor);
  const h = R.heat;
  t.push(h.max, h.onHit, h.onBlock, h.decayPerTick, b(h.latchAtMax));
  const f = R.fighter;
  const hf = f.hurtFallback;
  t.push(
    f.hpMax, f.gravity, f.walkFwd, f.walkBack, f.inputBuffer, f.pushHalfW, f.pushH,
    hf.ax, hf.ay, hf.bx, hf.by, hf.r,
    f.jumpVy, f.jumpVxFwd, f.jumpVxBack, f.jumpAirTicks, f.landLag,
    f.dashWindow, f.dashDuration, f.dashInvuln[0], f.dashInvuln[1],
    f.dashFwdSpeed, f.dashFwdFrames, f.dashBackSpeed, f.dashBackFrames,
    f.chipPct, f.knockdownLie, f.getup,
  );
  for (let id = 1; id < R.moves.length; id++) {
    const mv = R.moves[id] as MoveRules;
    t.push(
      mv.id, mv.clip, mv.startup, mv.active, mv.recovery, mv.damage, b(mv.blockable), b(mv.hitsAir), b(mv.ringOut),
      mv.hitstun, mv.blockstun, mv.hitstop, mv.blockHitstop,
      mv.hitPush[0], mv.hitPush[1], mv.blockPush[0], mv.blockPush[1],
      mv.launch ? 1 : 0, mv.launch ? mv.launch[0] : 0, mv.launch ? mv.launch[1] : 0,
      mv.heatHit, mv.heatBlock, mv.cancelMask, mv.cancelFrom, mv.cancelTo, mv.invuln[0], mv.invuln[1],
      mv.heatCost, mv.fullScreenMaxY, mv.dive[0], mv.dive[1], mv.minAirTick, mv.minY, mv.bounce[0], mv.bounce[1],
      mv.box.x, mv.box.y, mv.box.r,
    );
  }
  for (const c of R.clips) {
    t.push(c.id, c.frames, b(c.loop));
    t.push(c.phases ? 1 : 0, ...(c.phases ?? [0, 0, 0]));
    t.push(c.hurt ? c.hurt.length : -1, c.hit ? c.hit.length : -1);
  }
  return t;
}

export function rulesHash(R: Rules): string {
  const h = fnvInit();
  const t = rulesTable(R);
  fnvInt(h, t.length);
  fnvInts(h, t);
  for (const c of R.clips) {
    if (c.hurt) fnvInts(h, c.hurt);
    if (c.hit) fnvInts(h, c.hit);
  }
  return fnvHex(h);
}

/** Data sanity checks. Returns a list of problems (empty = valid). */
export function validateRules(R: Rules): string[] {
  const errs: string[] = [];
  const posInt = (v: number, what: string) => {
    if (!Number.isSafeInteger(v) || v <= 0) errs.push(`${what} must be a positive integer (got ${v})`);
  };
  const f = R.fighter;
  if (f.gravity * f.jumpAirTicks !== 2 * f.jumpVy) {
    errs.push(`jump: vy (${f.jumpVy}) must equal gravity*airTicks/2 (${(f.gravity * f.jumpAirTicks) / 2})`);
  }
  posInt(R.match.countdown, "match.countdown");
  posInt(R.match.round, "match.round");
  posInt(R.match.roundEnd, "match.roundEnd");
  if (R.match.ringEdge <= R.match.wallEdge) errs.push("ringEdge must be beyond wallEdge");
  for (let id = 1; id < R.moves.length; id++) {
    const mv = R.moves[id] as MoveRules;
    posInt(mv.startup, `${mv.name}.startup`);
    posInt(mv.active, `${mv.name}.active`);
    posInt(mv.recovery, `${mv.name}.recovery`);
    for (const [label, p] of [
      ["onHit.push", mv.hitPush],
      ["onBlock.push", mv.blockPush],
    ] as const) {
      posInt(p[1], `${mv.name}.${label} ticks`);
      if (p[0] % p[1] !== 0) errs.push(`${mv.name}.${label}: distance ${p[0]} must divide by ticks ${p[1]}`);
    }
    const clip = R.clips[mv.clip] as ClipRules;
    if (mv.name !== "dive_kick" && clip.frames !== mv.total && !clip.phases) {
      errs.push(`${mv.name}: clip ${clip.name} has ${clip.frames} frames but the move lasts ${mv.total} and the clip has no phases`);
    }
  }
  for (const c of R.clips) posInt(c.frames, `clip ${c.name}.frames`);
  return errs;
}

export const RULES: Rules = compileRules();
