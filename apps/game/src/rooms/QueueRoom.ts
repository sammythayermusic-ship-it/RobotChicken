/**
 * The matchmaking queue: one room per region (joinOrCreate "queue").
 *
 * - Ranked (GATE_MODE=required): a client joins with the queue token from
 *   POST /gate. Open playtests: with a name and a per-browser guest id.
 * - One queue room per process, created at boot (listen()); clients can't
 *   create more. Tokens and names are checked at the HTTP matchmaking step
 *   (static onAuth), so nobody gets a seat without them.
 * - One ticket per player: a second join for someone already queued is
 *   refused (evicting the first would let anyone who pastes your address
 *   knock you out of the queue).
 * - Clients must run the same sim rules as the server (rulesHash), or every
 *   match would desync: an old cached page is told to reload.
 * - Every half second the oldest ticket is paired with the first compatible
 *   one. Spec: both within 120 ms RTT, widening to 200 ms once either has
 *   waited 20 s; after 60 s any RTT (nobody waits forever in a thin queue).
 * - Ranked pairs are re-checked (balance, cache bypass) before the match: a
 *   player who dropped below the gate is told why and removed; the other goes
 *   back to the front of the queue.
 * - Then the fight room is created with ROOM_KEY, both seats are reserved,
 *   and each client gets its reservation ("matched").
 *
 * Phase 3 (ranked): tiers pair with their own tier first and with anyone
 * after 60 s (the match then pays the lower tier); never two tickets sharing
 * an IP /24 or a fingerprint; not the same two wallets again within the
 * rematch cooldown; and no pairing at all until QUEUE_MIN_PLAYERS are
 * waiting (spec: 4, so two colluding wallets can't be sure to meet).
 */
import { randomUUID } from "node:crypto";
import { Room, logger, matchMaker, type AuthContext, type Client } from "@colyseus/core";
import { RULES } from "@cockfight/sim";
import { schema, t, type SchemaType } from "@colyseus/schema";
import { anonName } from "@cockfight/solana";
import { payTier } from "@cockfight/economy";
import { clientIp } from "../gate";
import { getContext } from "../context";
import { ROOM_KEY, cleanName, type FightOptions, type PlayerInfo, type SeatAuth } from "../seats";

export const PAIR_EVERY_MS = 500;
export const RTT_TIGHT = 120;
export const RTT_WIDE = 200;
export const WIDEN_AFTER_MS = 20_000;
export const ANY_RTT_AFTER_MS = 60_000;
/** Ranked: after this long in the queue a ticket takes an opponent from any tier. */
export const ANY_TIER_AFTER_MS = 60_000;

export const QUEUE_ROOM = "queue";

export const QueueState = schema({ size: t.uint16().default(0), mode: t.string().default("open") }, "QueueState");
export type QueueState = SchemaType<typeof QueueState>;

export interface Ticket {
  client: Client;
  player: PlayerInfo;
  rtt: number;
  joinedAt: number;
  /** Being re-checked / seated: not available for pairing. */
  busy: boolean;
}

/** Messages the queue sends. */
export interface MatchedMsg {
  reservation: unknown;
  side: 0 | 1;
  matchId: string;
  opponent: { name: string; tier: string };
}
export interface KickedMsg {
  reason: "gate";
  message: string;
  usd?: number;
  shortUsd?: number;
}

/** Whether two waiting tickets may be paired now on latency (spec's RTT steps). */
export function rttAllows(a: Pick<Ticket, "rtt" | "joinedAt">, b: Pick<Ticket, "rtt" | "joinedAt">, now: number): boolean {
  const waited = now - Math.min(a.joinedAt, b.joinedAt);
  if (waited >= ANY_RTT_AFTER_MS) return true;
  const limit = waited >= WIDEN_AFTER_MS ? RTT_WIDE : RTT_TIGHT;
  return a.rtt <= limit && b.rtt <= limit;
}

/** Same paying tier, or either has waited long enough to take anyone. */
export function tierAllows(a: Pick<Ticket, "player" | "joinedAt">, b: Pick<Ticket, "player" | "joinedAt">, now: number): boolean {
  if (payTier(a.player.tier) === payTier(b.player.tier)) return true;
  return now - Math.min(a.joinedAt, b.joinedAt) >= ANY_TIER_AFTER_MS;
}

/** The spec's identity rules: never the same wallet, IP /24 or fingerprint on both sides. */
export function identityAllows(a: PlayerInfo, b: PlayerInfo): boolean {
  if (a.id === b.id) return false;
  if (a.ipHash && b.ipHash && a.ipHash === b.ipHash) return false;
  if (a.fp && b.fp && a.fp === b.fp) return false;
  return true;
}

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class QueueRoom extends Room<{ state: QueueState }> {
  override maxClients = 2000;
  override state = new QueueState();
  /** The queue lives as long as the process, even when nobody is in it. */
  override autoDispose = false;
  /** Tickets by session id. */
  readonly tickets = new Map<string, Ticket>();
  #pairing = false;

  /**
   * Runs at the HTTP matchmaking step, before a seat is reserved: ranked
   * players need a valid queue token, playtesters a name. The result becomes
   * the client's auth.
   */
  static override async onAuth(
    _token: string,
    options: { token?: unknown; name?: unknown; guestId?: unknown; rules?: unknown; fp?: unknown } = {},
    authCtx: AuthContext,
  ): Promise<PlayerInfo> {
    const ctx = getContext();
    if (options.rules !== RULES.hash) throw new Error("Your game is out of date: reload the page.");
    if (ctx.env.GATE_MODE === "required") {
      const c = ctx.gate.tokens.verify(options.token);
      if (!c) throw new Error("queue token missing or expired: pass the gate again");
      const ip = clientIp(authCtx.headers) ?? authCtx.ip ?? null;
      return { id: c.sub, address: c.sub, name: c.name ?? anonName(c.sub), tier: c.tier, ipHash: ctx.abuse.ip(ip), fp: ctx.abuse.fingerprint(options.fp) };
    }
    const name = cleanName(options.name);
    if (!name) throw new Error("pick a name: 1-16 letters, digits, spaces, _ or -");
    const guest = typeof options.guestId === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(options.guestId) ? options.guestId : randomUUID();
    return { id: `guest:${guest}`, address: null, name, tier: "rust", ipHash: null, fp: null };
  }

  override onCreate(options: { key?: string } = {}): void {
    const ctx = getContext();
    if (options.key !== ROOM_KEY) throw new Error("the queue is created by the server");
    this.state.mode = ctx.env.GATE_MODE;
    this.onMessage("rtt", (client, ms: unknown) => {
      const t = this.tickets.get(client.sessionId);
      if (t && typeof ms === "number" && Number.isFinite(ms)) t.rtt = clampRtt(ms);
    });
    this.clock.setInterval(() => void this.pair(), PAIR_EVERY_MS);
  }

  override onJoin(client: Client, options: { rtt?: unknown } = {}): void {
    const player = client.auth as PlayerInfo;
    for (const t of this.tickets.values()) {
      if (t.player.id === player.id) throw new Error("You're already in the queue (another tab or device).");
    }
    this.tickets.set(client.sessionId, { client, player, rtt: clampRtt(options.rtt), joinedAt: Date.now(), busy: false });
    this.state.size = this.tickets.size;
  }

  override onLeave(client: Client): void {
    this.tickets.delete(client.sessionId);
    this.state.size = this.tickets.size;
  }

  /** When each pair of wallets last started a match (ranked): the rematch cooldown. */
  readonly recentPairs = new Map<string, number>();

  /** The identity and rematch rules (ranked); open playtests only refuse a player against themselves. */
  protected canPair(a: Ticket, b: Ticket, now = Date.now()): boolean {
    if (a.player.id === b.player.id) return false;
    const ctx = getContext();
    if (ctx.env.GATE_MODE !== "required") return true;
    if (!identityAllows(a.player, b.player)) return false;
    if (!tierAllows(a, b, now)) return false;
    const last = this.recentPairs.get(pairKey(a.player.id, b.player.id));
    if (last !== undefined && now - last < ctx.env.REMATCH_COOLDOWN_S * 1000) return false;
    return true;
  }

  /** One pairing pass (public for tests). */
  async pair(now = Date.now()): Promise<void> {
    if (this.#pairing) return;
    this.#pairing = true;
    try {
      const ctx = getContext();
      const waiting = [...this.tickets.values()].filter((t) => !t.busy).sort((a, b) => a.joinedAt - b.joinedAt);
      if (ctx.env.GATE_MODE === "required" && waiting.length < ctx.env.QUEUE_MIN_PLAYERS) return;
      if (this.recentPairs.size > 5000) {
        const keep = ctx.env.REMATCH_COOLDOWN_S * 1000;
        for (const [k, t] of this.recentPairs) if (now - t >= keep) this.recentPairs.delete(k);
      }
      const taken = new Set<Ticket>();
      const pairs: [Ticket, Ticket][] = [];
      for (const a of waiting) {
        if (taken.has(a)) continue;
        const b = waiting.find((x) => x !== a && !taken.has(x) && rttAllows(a, x, now) && this.canPair(a, x, now));
        if (!b) continue;
        taken.add(a).add(b);
        a.busy = b.busy = true;
        pairs.push([a, b]);
      }
      // Not awaited: one slow balance re-check must not hold up everyone else's
      // pairing (the busy flags keep a ticket from being paired twice).
      for (const p of pairs) void this.#start(p).catch((e) => logger.error("[queue] pairing failed:", e));
    } finally {
      this.#pairing = false;
    }
  }

  async #start([a, b]: [Ticket, Ticket]): Promise<void> {
    const ctx = getContext();
    const ranked = ctx.env.GATE_MODE === "required";
    if (ranked) {
      const checks = await Promise.all([a, b].map((t) => (t.player.address ? ctx.gate.recheck(t.player.address) : Promise.resolve(null))));
      let failed = false;
      checks.forEach((c, i) => {
        const t = (i === 0 ? a : b) as Ticket;
        if (c && !c.ok) {
          failed = true;
          this.tickets.delete(t.client.sessionId);
          t.client.send("kicked", {
            reason: "gate",
            message: `Your $COCK is worth $${c.usd.toFixed(2)} now, under the $${ctx.env.GATE_USD_MIN} gate.`,
            usd: c.usd,
            shortUsd: c.shortUsd,
          } satisfies KickedMsg);
          t.client.leave();
        } else if (c?.tier) {
          t.player = { ...t.player, tier: c.tier };
        }
      });
      if (failed) {
        // Whoever passed goes back into the queue, keeping their place.
        for (const t of [a, b]) t.busy = false;
        this.state.size = this.tickets.size;
        return;
      }
    }
    // Either may have left while we waited.
    if (!this.tickets.has(a.client.sessionId) || !this.tickets.has(b.client.sessionId)) {
      a.busy = b.busy = false;
      return;
    }
    // Random sides, so the older ticket isn't always P1.
    const [p1, p2] = Math.random() < 0.5 ? [a, b] : [b, a];
    if (ranked) this.recentPairs.set(pairKey(a.player.id, b.player.id), Date.now());
    const matchId = randomUUID();
    const opts: FightOptions = { key: ROOM_KEY, matchId, ranked, players: [p1.player, p2.player] };
    try {
      const room = await matchMaker.createRoom("fight", opts);
      const seats = await Promise.all(
        [p1, p2].map((t, side) => matchMaker.reserveSeatFor(room, {}, { side: side as 0 | 1, player: t.player } satisfies SeatAuth)),
      );
      [p1, p2].forEach((t, side) => {
        const other = side === 0 ? p2 : p1;
        this.tickets.delete(t.client.sessionId);
        t.client.send("matched", {
          reservation: seats[side],
          side: side as 0 | 1,
          matchId,
          opponent: { name: other.player.name, tier: other.player.tier },
        } satisfies MatchedMsg);
      });
      this.state.size = this.tickets.size;
    } catch (e) {
      logger.error("[queue] could not start a match:", e);
      a.busy = b.busy = false;
    }
  }
}

function clampRtt(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 150;
  return Math.max(0, Math.min(5000, Math.round(n)));
}
