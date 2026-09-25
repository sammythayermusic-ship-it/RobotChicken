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

/**
 * Version of the simulation CODE. rulesHash covers the data; this covers
 * behaviour. Bump it in any commit that changes what step() does (the same
 * commit re-blesses the golden replays), so an old replay can't silently run
 * against new logic.
 */
export const SIM_VERSION = 3;

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
  /** Rig helper this move hits with (moves.json hitNode, default hit_beak). */
  hitNode: string;
  /** Baked hit spheres of that helper over the move's clip, (frames + 1) x [x, y, r], or null. */
  hit: Int32Array | null;
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
  /** Baked hit spheres per helper name, (frames + 1) x [x, y, r]. */
  hits: ReadonlyMap<string, Int32Array>;
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
    /** Invulnerable ticks after get-up ends, when the fighter can already act (no guaranteed meaty). */
    wakeInvuln: number;
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
  hurt: unknown;
  hit?: Record<string, unknown>;
}

/** Every rule value is an int32: a float or typo must fail loudly, not hash the same and leak into state. */
function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || (v | 0) !== v) {
    throw new Error(`rules: ${what} must be an int32 (got ${JSON.stringify(v)})`);
  }
  return v;
}

function pair(a: unknown, what: string, d?: [number, number]): [number, number] {
  if (a === undefined && d) return d;
  if (!Array.isArray(a) || a.length !== 2) throw new Error(`rules: ${what} must be a [a, b] pair (got ${JSON.stringify(a)})`);
  return [int(a[0], `${what}[0]`), int(a[1], `${what}[1]`)];
}

function pair3(a: unknown, what: string): [number, number, number] {
  if (!Array.isArray(a) || a.length !== 3) throw new Error(`rules: ${what} must have 3 entries`);
  return [int(a[0], what), int(a[1], what), int(a[2], what)];
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new Error(`rules: ${what} must be true or false (got ${JSON.stringify(v)})`);
  return v;
}

function ints(a: unknown, len: number, what: string): Int32Array {
  if (!Array.isArray(a) || a.length !== len) throw new Error(`rules: ${what} must have ${len} entries`);
  const out = new Int32Array(len);
  for (let i = 0; i < len; i++) out[i] = int(a[i], what);
  return out;
}

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
    const frames = int(c.frames, `contract clip ${name}.frames`);
    const phases = "phases" in c && c.phases !== undefined ? pair3(c.phases, `contract clip ${name}.phases`) : null;
    const baked = rawClips[name];
    let hurt: Int32Array | null = null;
    const hits = new Map<string, Int32Array>();
    if (baked) {
      if (baked.n !== frames) throw new Error(`hitboxes.json clip ${name}: n=${baked.n}, contract frames=${frames}`);
      hurt = ints(baked.hurt, (frames + 1) * 5, `hitboxes.json clip ${name}.hurt`);
      const nodes = baked.hit ?? {};
      for (const node of Object.keys(nodes).sort()) {
        hits.set(node, ints(nodes[node], (frames + 1) * 3, `hitboxes.json clip ${name}.hit.${node}`));
      }
    }
    return { id, name, frames, loop: bool(c.loop, `contract clip ${name}.loop`), phases, hurt, hits };
  });

  const fallbacks: string[] = [];
  const moveTable: MoveRules[] = [];
  for (let id = 1; id < MOVE_NAMES.length; id++) {
    const name = MOVE_NAMES[id] as MoveName;
    const r = rawMoves[name];
    if (!r) throw new Error(`moves.json is missing ${name}`);
    const w = (k: string) => `moves.${name}.${k}`;
    const clip = moveClip(name);
    const hitNode = r.hitNode ?? "hit_beak";
    if (typeof hitNode !== "string") throw new Error(`rules: ${w("hitNode")} must be a string`);
    const clipRules = clips[clip] as ClipRules;
    const hit = clipRules.hits.get(hitNode) ?? null;
    if (clipRules.hurt && !hit) throw new Error(`hitboxes.json clip ${clipRules.name} has no helper "${hitNode}" (${w("hitNode")})`);
    if (!hit) fallbacks.push(name);
    let cancelMask = 0;
    for (const into of r.cancel?.into ?? []) {
      const target = MOVE_NAMES.indexOf(into as MoveName);
      if (target <= 0) throw new Error(`moves.json ${name}: unknown cancel target ${into}`);
      cancelMask |= 1 << target;
    }
    const startup = int(r.startup, w("startup"));
    const active = int(r.active, w("active"));
    const recovery = int(r.recovery, w("recovery"));
    moveTable[id] = {
      id: id as MvId,
      name,
      clip,
      startup,
      active,
      recovery,
      total: startup + active + recovery,
      damage: int(r.damage, w("damage")),
      blockable: bool(r.blockable, w("blockable")),
      hitsAir: bool(r.hitsAir, w("hitsAir")),
      ringOut: bool(r.ringOut, w("ringOut")),
      hitstun: int(r.hitstun, w("hitstun")),
      blockstun: int(r.blockstun, w("blockstun")),
      hitstop: int(r.hitstop, w("hitstop")),
      blockHitstop: int(r.blockHitstop, w("blockHitstop")),
      hitPush: pair(r.onHit.push, w("onHit.push"), [0, 1]),
      blockPush: pair(r.onBlock.push, w("onBlock.push"), [0, 1]),
      launch: r.onHit.launch === undefined ? null : pair(r.onHit.launch, w("onHit.launch")),
      heatHit: r.heatGain ? pair(r.heatGain, w("heatGain"))[0] : int(h.onHit, "heat.onHit"),
      heatBlock: r.heatGain ? pair(r.heatGain, w("heatGain"))[1] : int(h.onBlock, "heat.onBlock"),
      cancelMask,
      cancelFrom: r.cancel ? int(r.cancel.from, w("cancel.from")) : 0,
      cancelTo: r.cancel ? int(r.cancel.to, w("cancel.to")) : 0,
      invuln: pair(r.invuln, w("invuln"), [0, 0]),
      heatCost: r.heatCost === undefined ? 0 : int(r.heatCost, w("heatCost")),
      fullScreenMaxY: r.fullScreenMaxY === undefined ? 0 : int(r.fullScreenMaxY, w("fullScreenMaxY")),
      dive: pair(r.dive, w("dive"), [0, 0]),
      minAirTick: r.minAirTick === undefined ? 0 : int(r.minAirTick, w("minAirTick")),
      minY: r.minY === undefined ? 0 : int(r.minY, w("minY")),
      bounce: pair(r.bounce, w("bounce"), [0, 0]),
      box: { x: int(r.box.x, w("box.x")), y: int(r.box.y, w("box.y")), r: int(r.box.r, w("box.r")) },
      hitNode,
      hit,
    };
  }
  // Index 0 is a placeholder so moves[Mv.x] works; it is never used.
  moveTable[0] = { ...(moveTable[Mv.peck] as MoveRules), id: Mv.none as MvId };

  const mi = (k: keyof typeof m) => int(m[k], `match.${k}`);
  const rules: Rules = {
    match: {
      countdown: mi("countdown"),
      round: mi("round"),
      roundEnd: mi("roundEnd"),
      suddenDeath: mi("suddenDeath"),
      winsNeeded: mi("winsNeeded"),
      maxRounds: mi("maxRounds"),
      startX: mi("startX"),
      wallEdge: mi("wallEdge"),
      ringEdge: mi("ringEdge"),
      ringOutFloor: mi("ringOutFloor"),
    },
    heat: {
      max: int(h.max, "heat.max"),
      onHit: int(h.onHit, "heat.onHit"),
      onBlock: int(h.onBlock, "heat.onBlock"),
      decayPerTick: int(h.decayPerTick, "heat.decayPerTick"),
      latchAtMax: bool(h.latchAtMax, "heat.latchAtMax"),
    },
    fighter: {
      hpMax: int(f.hpMax, "fighter.hpMax"),
      gravity: int(f.gravity, "fighter.gravity"),
      walkFwd: int(f.walkFwd, "fighter.walkFwd"),
      walkBack: int(f.walkBack, "fighter.walkBack"),
      inputBuffer: int(f.inputBuffer, "fighter.inputBuffer"),
      pushHalfW: int(f.pushbox.halfW, "fighter.pushbox.halfW"),
      pushH: int(f.pushbox.h, "fighter.pushbox.h"),
      hurtFallback: {
        ax: int(f.hurtFallback.ax, "fighter.hurtFallback.ax"),
        ay: int(f.hurtFallback.ay, "fighter.hurtFallback.ay"),
        bx: int(f.hurtFallback.bx, "fighter.hurtFallback.bx"),
        by: int(f.hurtFallback.by, "fighter.hurtFallback.by"),
        r: int(f.hurtFallback.r, "fighter.hurtFallback.r"),
      },
      jumpVy: int(f.jump.vy, "fighter.jump.vy"),
      jumpVxFwd: int(f.jump.vxFwd, "fighter.jump.vxFwd"),
      jumpVxBack: int(f.jump.vxBack, "fighter.jump.vxBack"),
      jumpAirTicks: int(f.jump.airTicks, "fighter.jump.airTicks"),
      landLag: int(f.jump.landLag, "fighter.jump.landLag"),
      dashWindow: int(f.dash.window, "fighter.dash.window"),
      dashDuration: int(f.dash.duration, "fighter.dash.duration"),
      dashInvuln: pair(f.dash.invuln, "fighter.dash.invuln"),
      dashFwdSpeed: int(f.dash.fwd.speed, "fighter.dash.fwd.speed"),
      dashFwdFrames: int(f.dash.fwd.frames, "fighter.dash.fwd.frames"),
      dashBackSpeed: int(f.dash.back.speed, "fighter.dash.back.speed"),
      dashBackFrames: int(f.dash.back.frames, "fighter.dash.back.frames"),
      chipPct: int(f.block.chipPct, "fighter.block.chipPct"),
      knockdownLie: int(f.knockdown.lie, "fighter.knockdown.lie"),
      getup: int(f.knockdown.getup, "fighter.knockdown.getup"),
      wakeInvuln: int(f.knockdown.wakeInvuln, "fighter.knockdown.wakeInvuln"),
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
    f.chipPct, f.knockdownLie, f.getup, f.wakeInvuln,
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
      mv.box.x, mv.box.y, mv.box.r, mv.hit ? mv.hit.length : -1,
    );
  }
  for (const c of R.clips) {
    t.push(c.id, c.frames, b(c.loop));
    t.push(c.phases ? 1 : 0, ...(c.phases ?? [0, 0, 0]));
    t.push(c.hurt ? c.hurt.length : -1, c.hits.size);
  }
  return t;
}

export function rulesHash(R: Rules): string {
  const h = fnvInit();
  fnvInt(h, SIM_VERSION);
  const t = rulesTable(R);
  for (const v of t) if ((v | 0) !== v) throw new Error(`rulesHash: non-int32 value ${v} in the rules table`);
  fnvInt(h, t.length);
  fnvInts(h, t);
  for (const c of R.clips) if (c.hurt) fnvInts(h, c.hurt);
  for (let id = 1; id < R.moves.length; id++) {
    const mv = R.moves[id] as MoveRules;
    if (mv.hit) fnvInts(h, mv.hit);
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
    errs.push(`jump: 2*vy (${2 * f.jumpVy}) must equal gravity*airTicks (${f.gravity * f.jumpAirTicks})`);
  }
  for (const k of ["countdown", "round", "roundEnd", "suddenDeath", "winsNeeded", "maxRounds", "wallEdge", "ringEdge"] as const) {
    posInt(R.match[k], `match.${k}`);
  }
  if (R.match.winsNeeded > R.match.maxRounds) errs.push("match.winsNeeded cannot exceed maxRounds");
  for (const k of ["hpMax", "gravity", "walkFwd", "walkBack", "inputBuffer", "pushHalfW", "pushH", "jumpVy", "dashWindow", "dashDuration"] as const) {
    posInt(f[k], `fighter.${k}`);
  }
  posInt(R.heat.max, "heat.max");
  if (!(f.wakeInvuln >= 0)) errs.push(`fighter.wakeInvuln must be >= 0 (got ${f.wakeInvuln})`);
  if (R.match.ringEdge <= R.match.wallEdge) errs.push("ringEdge must be beyond wallEdge");
  for (let id = 1; id < R.moves.length; id++) {
    const mv = R.moves[id] as MoveRules;
    posInt(mv.damage, `${mv.name}.damage`);
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
  for (const c of R.clips) {
    posInt(c.frames, `clip ${c.name}.frames`);
    if (c.phases && c.phases[0] + c.phases[1] + c.phases[2] !== c.frames) {
      errs.push(`clip ${c.name}: phases ${c.phases.join("+")} must sum to its ${c.frames} frames`);
    }
  }
  return errs;
}

/** Deep-freeze plain objects (typed arrays can't be frozen; they're only read). */
function freeze<T>(o: T): T {
  if (o && typeof o === "object" && !ArrayBuffer.isView(o) && !(o instanceof Map) && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) freeze(v);
  }
  return o;
}

/** The compiled rules. Frozen so RULES.hash can never go stale; compileRules() for a mutable copy. */
export const RULES: Rules = freeze(compileRules());
