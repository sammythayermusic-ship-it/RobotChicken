/**
 * One match: two seats, the authoritative sim at 60 Hz (packages/net
 * ServerMatch), and the lifecycle around it.
 *
 *   waiting ──both seated and ready──▶ live ⇄ paused ──▶ over
 *      └──────── 30 s ─────▶ cancelled
 *
 * - Clients send buttons (binary Msg.input); every tick the room sends each
 *   client the buttons it used for both players (Msg.frames) and, twice a
 *   second, the full sim state (Msg.sync) as a desync check.
 * - A dropped player pauses the sim. They get RECONNECT_GRACE_S seconds to
 *   come back, out of a PAUSE_BUDGET_S budget for the whole match (so a
 *   player can't stall a match by dropping over and over). Coming back
 *   resumes from a full sync; not coming back forfeits the match to the
 *   player still here. Leaving on purpose forfeits at once.
 * - Both players gone: the match is off (no result). If one of them comes
 *   back while the other's grace has run out, the one who came back wins.
 * - A forfeit while the sim is between rounds (the 2 s after a KO) first
 *   plays the sim to the end of that pause: if that round already decided the
 *   match, the result stands as the sim decided it.
 * - The queue creates these rooms (with ROOM_KEY) and reserves both seats.
 *   Outside production with the open gate, a room created without the key is
 *   an ad hoc room anyone can join by id (tests, /dev/net).
 */
import { randomUUID } from "node:crypto";
import { logger, Room, type AuthContext, type Client, type RoomException, type RoomMethodName } from "@colyseus/core";
import {
  Msg, SYNC_EVERY, ServerMatch, decodeInputs, encodeFrames, encodeReplayLog, encodeSync, forfeitRound, outcome, resultHash, roundEnded,
  type RoundRecord,
} from "@cockfight/net";
import { lowerTier, qualityBps } from "@cockfight/economy";
import { RECONNECT_GRACE_S, SNAPSHOT_HZ, TICK_RATE } from "@cockfight/shared";
import { Phase, serialize, type MatchState } from "@cockfight/sim";
import { analyzeTiming } from "../botcheck";
import { getContext } from "../context";
import { withRetry, type MatchRecord } from "../results";
import { ROOM_KEY, cleanName, type FightOptions, type PlayerInfo, type SeatAuth } from "../seats";
import { FightState, Seat } from "../state";

/** Both players must connect and load within this long, or the match is cancelled. */
export const READY_TIMEOUT_S = 30;
/** A finished room stays up this long (KO screen, result) before closing. */
export const LINGER_S = 60;
/** Total pause time each player may cause in one match. */
export const PAUSE_BUDGET_S = 20;
/** How long the result screen follows the payout to its transaction, and how often it looks. */
export const PAYOUT_FOLLOW_S = 55;
export const PAYOUT_POLL_MS = 3000;

type Status = "waiting" | "live" | "paused" | "over" | "cancelled";

/** Seat data for a player in an ad hoc room (assigned a side on join). */
interface GuestAuth {
  guest: string;
}

export class FightRoom extends Room<{ state: FightState }> {
  override maxClients = 2;
  /** Metadata patches at 20 Hz; the sim itself goes out as binary messages every tick. */
  override patchRate = 1000 / SNAPSHOT_HZ;
  /** 60 inputs a second plus pings and a few control messages. */
  override maxMessagesPerSecond = 180;
  override state = new FightState();

  #sm!: ServerMatch;
  #players: [PlayerInfo | null, PlayerInfo | null] = [null, null];
  #adhoc = false;
  #clients: [Client | null, Client | null] = [null, null];
  /** Sides whose player dropped and may still come back: when their grace ends (ms). */
  #away = new Map<0 | 1, number>();
  #dropAt: [number, number] = [0, 0];
  /** Pause time each side has left (ms). */
  #budget: [number, number] = [PAUSE_BUDGET_S * 1000, PAUSE_BUDGET_S * 1000];
  /** Sides whose player is gone for good (left, or the grace ran out). */
  #gone = new Set<0 | 1>();
  #rounds: RoundRecord[] = [];
  #startedAt = new Date();
  #finishing: Promise<void> | null = null;

  /**
   * Matchmaking requests from clients (join by id, create). Seats come from
   * the queue (reserved server-side, which skips this); only an ad hoc dev
   * room may be joined directly.
   */
  static override async onAuth(_token: string, options: { name?: unknown } | undefined, _ctx: AuthContext): Promise<GuestAuth> {
    const { env } = getContext();
    if (env.NODE_ENV === "production" || env.GATE_MODE === "required") throw new Error("matches are joined through the queue");
    return { guest: cleanName(options?.name) ?? "" };
  }

  /** Current sim state (tests). */
  get sim(): MatchState | undefined {
    return this.#sm?.state;
  }

  /** The ServerMatch (tests). */
  get match(): ServerMatch {
    return this.#sm;
  }

  get status(): Status {
    return this.state.status as Status;
  }

  override onCreate(options: Partial<FightOptions> = {}): void {
    const ctx = getContext();
    const seated = options.key === ROOM_KEY && !!options.players && typeof options.matchId === "string";
    if (!seated) {
      if (ctx.env.NODE_ENV === "production" || ctx.env.GATE_MODE === "required") {
        throw new Error("fight rooms are created by the queue");
      }
      this.#adhoc = true;
    }
    const matchId = seated ? (options.matchId as string) : randomUUID();
    this.roomId = matchId;
    // Never offered to a client's joinOrCreate: seats are reserved by the queue.
    if (seated) void this.setPrivate(true);
    this.#sm = new ServerMatch(matchId);
    this.state.matchId = matchId;
    this.state.ranked = seated ? !!options.ranked : false;
    for (let i = 0; i < 2; i++) this.state.seats.push(new Seat());
    if (seated) {
      this.#players = [...(options.players as [PlayerInfo, PlayerInfo])];
      this.#players.forEach((p, i) => {
        const seat = this.state.seats[i] as Seat;
        seat.name = p?.name ?? "";
        seat.tier = p?.tier ?? "rust";
      });
      void this.#loadRatings();
    }
    this.#mirror(this.#sm.state);

    this.onMessageBytes(Msg.input, (client, bytes) => {
      const side = this.#sideOf(client);
      if (side === null || (this.status !== "live" && this.status !== "paused")) return;
      const batch = decodeInputs(bytes);
      if (batch) this.#sm.receive(side, batch);
    });
    this.onMessage(Msg.ready, (client) => {
      const side = this.#sideOf(client);
      if (side === null || this.status !== "waiting") return;
      (this.state.seats[side] as Seat).ready = true;
      this.#maybeStart();
    });
    this.onMessage(Msg.forfeit, (client) => {
      const side = this.#sideOf(client);
      if (side !== null) this.#leftForGood(side);
    });

    // Colyseus runs a fixed-step accumulator: every call is exactly one 1/60 s
    // step, and a long stall drops backlog instead of spiralling.
    this.setFixedTimestep(() => this.tick(), TICK_RATE);
    this.clock.setTimeout(() => {
      if (this.status === "waiting") this.#cancel("opponent didn't show up");
    }, READY_TIMEOUT_S * 1000);
    this.clock.setInterval(() => this.#countPause(), 250);
  }

  override onJoin(client: Client): void {
    const auth = client.auth as SeatAuth | GuestAuth;
    if ("guest" in auth) {
      // Ad hoc room: first free seat, a guest identity.
      const side = this.#players[0] === null ? 0 : this.#players[1] === null ? 1 : null;
      if (side === null) throw new Error("room is full");
      const player: PlayerInfo = { id: `guest:${client.sessionId}`, address: null, name: auth.guest || `P${side + 1}`, tier: "rust", ipHash: null, fp: null };
      this.#players[side] = player;
      (this.state.seats[side] as Seat).name = player.name;
      client.auth = { side, player } satisfies SeatAuth;
    }
    const { side } = client.auth as SeatAuth;
    this.#clients[side] = client;
    (this.state.seats[side] as Seat).connected = true;
    if (this.status === "live" || this.status === "paused") client.sendBytes(Msg.sync, this.#syncBytes());
  }

  override async onDrop(client: Client): Promise<void> {
    const side = this.#sideOf(client);
    if (side === null) return;
    (this.state.seats[side] as Seat).connected = false;
    this.#clients[side] = null;
    if (this.status === "over" || this.status === "cancelled") return;
    // Between rounds after the deciding KO, the match is already won: finish it.
    if (this.status === "live" && this.#sm.state.phase === Phase.roundEnd) {
      this.#playOutRoundEnd();
      if (this.#sm.over) return;
    }
    const now = Date.now();
    const graceMs = this.status === "waiting" ? RECONNECT_GRACE_S * 1000 : Math.min(RECONNECT_GRACE_S * 1000, this.#budget[side]);
    if (graceMs < 1000) {
      this.#leftForGood(side);
      return;
    }
    this.#away.set(side, now + graceMs);
    this.#dropAt[side] = now;
    if (this.status === "live") this.#pause();
    this.#countPause();
    try {
      await this.allowReconnection(client, Math.ceil(graceMs / 1000));
    } catch {
      this.#away.delete(side);
      this.#leftForGood(side);
    }
  }

  override onReconnect(client: Client): void {
    const side = this.#sideOf(client);
    if (side === null) return;
    if (this.#away.has(side) && this.status !== "waiting") this.#budget[side] = Math.max(0, this.#budget[side] - (Date.now() - this.#dropAt[side]));
    this.#clients[side] = client;
    this.#away.delete(side);
    (this.state.seats[side] as Seat).connected = true;
    const other: 0 | 1 = side === 0 ? 1 : 0;
    if ((this.status === "live" || this.status === "paused") && this.#gone.has(other)) {
      // The other player's grace ran out while this one was away: this one wins.
      this.#forfeitTo(side);
    } else if (this.status === "paused" && this.#away.size === 0) {
      this.#resume();
    } else if (this.status === "live" || this.status === "paused") {
      client.sendBytes(Msg.sync, this.#syncBytes());
    } else if (this.status === "waiting") {
      this.#maybeStart();
    }
  }

  override onLeave(client: Client): void {
    const side = this.#sideOf(client);
    if (side === null) return;
    // A consented leave (the client called leave()) never went through onDrop.
    if (this.#clients[side] === client) {
      this.#clients[side] = null;
      (this.state.seats[side] as Seat).connected = false;
      this.#leftForGood(side);
    }
  }

  override onBeforeShutdown(): void {
    // Let a live match finish and its result be stored (fly.toml's kill_timeout
    // is 300 s); close everything else now.
    const settled = () => this.status === "cancelled" || (this.status === "over" && this.state.recorded) || this.status === "waiting";
    if (settled()) {
      if (this.status === "waiting") this.#cancel("server restarting");
      void this.disconnect();
      return;
    }
    this.clock.setInterval(() => {
      if (settled()) void this.disconnect();
    }, 500);
  }

  /** Colyseus waits for this before it lets the process exit: the result gets stored first. */
  override async onDispose(): Promise<void> {
    await this.#finishing?.catch(() => {});
  }

  /** Advance one tick (only while live). */
  protected tick(): void {
    if (this.status !== "live") return;
    this.#advance();
  }

  /**
   * Defining this makes Colyseus catch exceptions from room callbacks instead
   * of letting them reach the process-level handler, which (with graceful
   * shutdown on) would stop the whole server and every other match. A step
   * that threw leaves the sim in an unknown state, so this room is cancelled
   * and closed rather than retried 60 times a second.
   */
  override onUncaughtException(error: RoomException, method: RoomMethodName): void {
    logger.error(`[fight ${this.roomId}] ${method} threw:`, error.cause ?? error);
    if (method === "setFixedTimestep") {
      this.setTimestep(); // no callback: clears the fixed-step interval
      this.state.status = "cancelled";
      this.state.reason = "server error";
      void this.disconnect().catch(() => {});
    }
  }

  /** One sim step: record a finished round, tell both clients, sync, finish at the end. */
  #advance(): void {
    const prev = this.#sm.state;
    const out = this.#sm.step();
    const next = this.#sm.state;
    const round = roundEnded(prev, next);
    if (round) this.#rounds.push(round);
    this.#mirror(next);
    for (const side of [0, 1] as const) {
      const c = this.#clients[side];
      const margin = this.#sm.takeMargin(side);
      c?.sendBytes(Msg.frames, encodeFrames({ first: out.tick, b1: [out.b1], b2: [out.b2], margin }));
    }
    if (out.tick % SYNC_EVERY === 0) this.#broadcastSync();
    if (this.#sm.over) void this.#finish();
  }

  /** Step through the pause after a round (inputs don't matter there) to see whether the match is decided. */
  #playOutRoundEnd(): void {
    let guard = 1000;
    while (this.#sm.state.phase === Phase.roundEnd && !this.#sm.over && guard-- > 0) this.#advance();
  }

  #sideOf(client: Client): 0 | 1 | null {
    const a = client.auth as SeatAuth | undefined;
    return a && (a.side === 0 || a.side === 1) ? a.side : null;
  }

  #maybeStart(): void {
    const seats = this.state.seats as unknown as Seat[];
    if (this.status !== "waiting" || !seats.every((s) => s.ready && s.connected)) return;
    this.#startedAt = new Date();
    this.state.status = "live";
    this.#broadcastSync();
  }

  #pause(): void {
    this.state.status = "paused";
    this.#countPause();
  }

  #resume(): void {
    this.state.status = "live";
    this.state.pauseLeft = 0;
    this.#broadcastSync();
  }

  #countPause(): void {
    if (this.status !== "paused") return;
    let end = 0;
    for (const t of this.#away.values()) end = Math.max(end, t);
    this.state.pauseLeft = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  }

  /** A player is gone for good: the other wins by forfeit, unless they're away too (then wait) or gone (then it's off). */
  #leftForGood(side: 0 | 1): void {
    if (this.#gone.has(side)) return;
    this.#gone.add(side);
    this.#away.delete(side);
    const other: 0 | 1 = side === 0 ? 1 : 0;
    if (this.status === "waiting") {
      this.#cancel("opponent left");
      return;
    }
    if (this.status !== "live" && this.status !== "paused") return;
    if (this.#gone.has(other)) {
      this.#cancel("both players left");
      return;
    }
    if (this.#away.has(other)) {
      // Both are away: whoever comes back wins (onReconnect); if neither does, it's off.
      this.#countPause();
      return;
    }
    this.#forfeitTo(other);
  }

  /** `winner` wins by forfeit, unless the match is already decided (the pause after a deciding KO). */
  #forfeitTo(winner: 0 | 1): void {
    if (this.#sm.state.phase === Phase.roundEnd) {
      this.#playOutRoundEnd();
      if (this.#sm.over) return;
    }
    void this.#finish(winner);
  }

  #cancel(reason: string): void {
    if (this.status === "over" || this.status === "cancelled") return;
    this.state.status = "cancelled";
    this.state.reason = reason;
    this.state.pauseLeft = 0;
    this.clock.setTimeout(() => void this.disconnect(), 5000);
  }

  #finish(forfeitWinner?: 0 | 1): Promise<void> {
    if (!this.#finishing) this.#finishing = this.#record(forfeitWinner);
    return this.#finishing;
  }

  async #record(forfeitWinner?: 0 | 1): Promise<void> {
    const s = this.#sm.state;
    const rounds = [...this.#rounds];
    // A forfeit records the round it happened in (never a round already recorded).
    if (forfeitWinner !== undefined) {
      const r = forfeitRound(s, forfeitWinner);
      if (rounds.some((x) => x.n === r.n)) r.n = Math.min(5, r.n + 1);
      if (rounds.length < 5) rounds.push(r);
    }
    const res = outcome(s, rounds, forfeitWinner);
    this.state.status = "over";
    this.state.pauseLeft = 0;
    this.state.winner = res.winner ?? 2;
    this.state.reason = res.reason;
    this.#broadcastSync();
    this.clock.setTimeout(() => void this.disconnect(), LINGER_S * 1000);

    const players = this.#players as [PlayerInfo, PlayerInfo];
    const ctx = getContext();
    const inputLog = encodeReplayLog(this.#sm.toReplay());
    // Guests (open mode) have no address: their hash covers the match id and the log.
    const winnerAddress = res.winner === null ? null : players[res.winner].address;
    const endedAt = new Date();
    // Ranked: the win pays the lower tier of the pair, times the spec's quality
    // multiplier (dropped inputs, a forfeit inside 30 s).
    const ranked = this.state.ranked && res.winner !== null;
    const tierPaid = ranked ? lowerTier(players[0].tier, players[1].tier) : null;
    const q = ranked
      ? qualityBps({
          dropRate: 1 - this.#sm.quality(res.winner as 0 | 1),
          reason: res.reason,
          durationS: (endedAt.getTime() - this.#startedAt.getTime()) / 1000,
        })
      : null;
    if (tierPaid) this.state.payoutTier = tierPaid;
    // The winner's inputs under the bot check: a flag holds the payout for review.
    const flag = ranked ? analyzeTiming(this.#sm.masksUsed()[res.winner as 0 | 1]).flag : null;
    const rec: MatchRecord = {
      id: this.#sm.matchId,
      ranked: this.state.ranked,
      region: ctx.region,
      startedAt: this.#startedAt,
      endedAt,
      players,
      winner: res.winner,
      reason: res.reason,
      rounds,
      inputLog,
      resultHash: await resultHash(this.#sm.matchId, winnerAddress, inputLog),
      netQuality: [round3(this.#sm.quality(0)), round3(this.#sm.quality(1))],
      tierPaid,
      qualityBps: q,
      flag,
    };
    ctx.memory.remember(rec);
    const store = rec.ranked ? ctx.ranked : ctx.memory;
    try {
      const { elo, payout } = await withRetry(() => store.record(rec));
      elo.forEach(([before, after], i) => {
        const seat = this.state.seats[i] as Seat;
        seat.elo = before;
        seat.eloDelta = after - before;
      });
      if (payout) {
        this.state.payout = payout.amount.toString();
        this.state.payoutReason = payout.reason;
        if (payout.amount > 0n) this.#followPayout();
      }
    } catch (e) {
      logger.error(`[fight ${this.roomId}] could not record the result:`, e);
    }
    this.state.recorded = true;
  }

  /** Poll the payout row until the worker has sent it (or the room closes), so the result screen can link the transaction. */
  #followPayout(): void {
    const ctx = getContext();
    const db = ctx.supabase;
    if (!db) return;
    const deadline = Date.now() + PAYOUT_FOLLOW_S * 1000;
    const timer = this.clock.setInterval(() => {
      void db
        .payoutStatus(this.#sm.matchId)
        .then((p) => {
          if (!p) return;
          this.state.payoutUsd = p.usd;
          if (p.sig) {
            this.state.payoutSig = p.sig;
            timer.clear();
          }
        })
        .catch(() => {});
      if (Date.now() > deadline) timer.clear();
    }, PAYOUT_POLL_MS);
  }

  async #loadRatings(): Promise<void> {
    const ctx = getContext();
    const store = this.state.ranked ? ctx.ranked : ctx.memory;
    try {
      const [a, b] = await store.ratings(this.#players as [PlayerInfo, PlayerInfo]);
      (this.state.seats[0] as Seat).elo = a;
      (this.state.seats[1] as Seat).elo = b;
    } catch (e) {
      logger.warn(`[fight ${this.roomId}] ratings unavailable:`, e);
    }
  }

  #syncBytes(): Uint8Array {
    return encodeSync(this.#sm.tick, serialize(this.#sm.state));
  }

  #broadcastSync(): void {
    const bytes = this.#syncBytes();
    for (const c of this.#clients) c?.sendBytes(Msg.sync, bytes);
  }

  #mirror(s: MatchState): void {
    const st = this.state;
    st.tick = s.tick;
    st.phase = s.phase;
    st.round = s.round;
    st.timer = s.timer;
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
