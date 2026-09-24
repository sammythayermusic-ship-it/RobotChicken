/**
 * A deterministic network simulation: one ServerMatch and two ClientPredictors
 * talking through ordered, delayed links (a WebSocket is ordered: jitter delays
 * messages but never reorders them). Time advances in 1 ms steps; the server
 * and each client run their own 60 Hz clocks, which may drift.
 */
import { CPU_LEVELS, Rng, cpuThink, createCpu, serialize, type CpuLevel, type MatchState, type SimEvent } from "@cockfight/sim";
import { ClientPredictor } from "../src/client";
import { Msg, SYNC_EVERY, decodeFrames, decodeInputs, decodeSync, encodeFrames, encodeSync } from "../src/protocol";
import { ServerMatch } from "../src/server";

interface Packet {
  at: number;
  type: number;
  data: Uint8Array;
}

class Link {
  private q: Packet[] = [];
  private lastAt = 0;
  private readonly oneWayMs: number;
  private readonly jitterMs: number;
  private readonly rng: Rng;
  /** [start, end) ms windows where nothing is delivered (a stall / loss burst TCP recovers from). */
  private readonly stalls: [number, number][];
  constructor(oneWayMs: number, jitterMs: number, rng: Rng, stalls: [number, number][] = []) {
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.rng = rng;
    this.stalls = stalls;
  }
  send(now: number, type: number, data: Uint8Array): void {
    let at = now + this.oneWayMs + (this.jitterMs > 0 ? this.rng.int(this.jitterMs * 2 + 1) - this.jitterMs : 0);
    for (const [a, b] of this.stalls) if (at >= a && at < b) at = b;
    at = Math.max(at, this.lastAt); // ordered
    this.lastAt = at;
    this.q.push({ at, type, data });
  }
  deliver(now: number): Packet[] {
    let i = 0;
    while (i < this.q.length && (this.q[i] as Packet).at <= now) i++;
    return this.q.splice(0, i);
  }
}

export type Bot = "hard" | "normal" | "easy" | "mash";

export interface SimOptions {
  rttMs: number;
  jitterMs?: number;
  seconds: number;
  seed?: number;
  /** Client frame rates (Hz); drift is what the clock control has to absorb. */
  hz?: [number, number];
  bots?: [Bot, Bot];
  stalls?: [number, number][];
  matchId?: string;
  delay?: number;
  /** Keep every event each client showed. */
  collectEvents?: boolean;
}

export interface SimResult {
  server: ServerMatch;
  clients: [ClientPredictor, ClientPredictor];
  /** Confirmed state hash per client at the server's final tick. */
  converged: [boolean, boolean];
  events?: [SimEvent[], SimEvent[]];
}

function makeBot(kind: Bot, matchId: string, side: 0 | 1, seed: number): (s: MatchState) => number {
  if (kind === "mash") {
    const rng = new Rng((seed ^ (side + 1) * 0x9e3779b9) >>> 0);
    let cur = 0;
    let left = 0;
    return () => {
      if (left-- <= 0) {
        cur = rng.int(32);
        left = 3 + rng.int(12);
      }
      return cur;
    };
  }
  const mem = createCpu(matchId, side);
  return (s) => cpuThink(s, side, mem, CPU_LEVELS[kind as CpuLevel]);
}

export function simulate(o: SimOptions): SimResult {
  const matchId = o.matchId ?? "net-harness";
  const seed = o.seed ?? 1;
  const rng = new Rng(seed);
  const one = o.rttMs / 2;
  const jit = o.jitterMs ?? 0;
  const up = [new Link(one, jit, rng, o.stalls), new Link(one, jit, rng, o.stalls)];
  const down = [new Link(one, jit, rng, o.stalls), new Link(one, jit, rng, o.stalls)];
  const server = new ServerMatch(matchId);
  const clients: [ClientPredictor, ClientPredictor] = [new ClientPredictor(matchId, 0, { delay: o.delay }), new ClientPredictor(matchId, 1, { delay: o.delay })];
  const bots = (o.bots ?? ["hard", "hard"]).map((b, i) => makeBot(b, matchId, i as 0 | 1, seed));
  const hz = o.hz ?? [60, 60];
  const serverStep = 1000 / 60;
  let nextServer = 0;
  const nextClient = [3.1, 7.7];
  const endMs = o.seconds * 1000;
  const events: [SimEvent[], SimEvent[]] = [[], []];

  // Start: both "ready", the server syncs its initial state.
  for (const side of [0, 1] as const) {
    down[side]!.send(0, Msg.sync, encodeSync(0, serialize(server.state)));
    clients[side].setRtt(o.rttMs);
  }

  for (let now = 0; now <= endMs; now++) {
    // Server receives, then steps on its clock.
    for (const side of [0, 1] as const) {
      for (const p of up[side]!.deliver(now)) {
        const b = decodeInputs(p.data);
        if (b) server.receive(side, b);
      }
    }
    while (nextServer <= now && !server.over) {
      const out = server.step();
      for (const side of [0, 1] as const) {
        down[side]!.send(now, Msg.frames, encodeFrames({ first: out.tick, b1: [out.b1], b2: [out.b2], margin: server.takeMargin(side) }));
        if (out.tick % SYNC_EVERY === 0) down[side]!.send(now, Msg.sync, encodeSync(out.tick, serialize(server.state)));
      }
      nextServer += serverStep;
    }
    // Clients receive, then run a frame on their own clocks.
    for (const side of [0, 1] as const) {
      const c = clients[side];
      for (const p of down[side]!.deliver(now)) {
        if (p.type === Msg.frames) {
          const f = decodeFrames(p.data);
          if (f) c.onFrames(f);
        } else {
          const s = decodeSync(p.data);
          if (s) c.onSync(s);
        }
      }
      if ((nextClient[side] as number) <= now) {
        c.tick(bots[side] as (s: MatchState) => number);
        if (o.collectEvents) events[side].push(...c.events);
        for (const msg of c.takeOutgoing()) up[side]!.send(now, Msg.input, msg);
        nextClient[side] = (nextClient[side] as number) + 1000 / (hz[side] as number);
      }
    }
  }
  // Deliver everything still in flight.
  for (const side of [0, 1] as const) {
    for (const p of down[side]!.deliver(Number.POSITIVE_INFINITY)) {
      if (p.type === Msg.frames) {
        const f = decodeFrames(p.data);
        if (f) clients[side].onFrames(f);
      } else {
        const s = decodeSync(p.data);
        if (s) clients[side].onSync(s);
      }
    }
  }
  const sh = serialize(server.state).join(",");
  const converged = clients.map((c) => c.confirmed !== null && c.confirmed.tick === server.tick && serialize(c.confirmed).join(",") === sh) as [boolean, boolean];
  return { server, clients, converged, events: o.collectEvents ? events : undefined };
}
