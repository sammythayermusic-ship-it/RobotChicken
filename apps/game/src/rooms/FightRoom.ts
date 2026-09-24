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
 * - A dropped player pauses the sim for up to RECONNECT_GRACE_S seconds.
 *   Coming back resumes from a full sync; not coming back forfeits the match
 *   to the player still here. Leaving on purpose forfeits at once.
 * - The queue creates these rooms (with ROOM_KEY) and reserves both seats.
 *   Outside production with the open gate, a room created without the key is
 *   an ad hoc room anyone can join by id (tests, /dev/net).
 */
import { randomUUID } from "node:crypto";
import { logger, Room, type Client, type RoomException, type RoomMethodName } from "@colyseus/core";
import {
  Msg, SYNC_EVERY, ServerMatch, decodeInputs, encodeFrames, encodeReplayLog, encodeSync, forfeitRound, outcome, resultHash, roundEnded,
  type RoundRecord,
} from "@cockfight/net";
import { RECONNECT_GRACE_S, SNAPSHOT_HZ, TICK_RATE } from "@cockfight/shared";
import { serialize, type MatchState } from "@cockfight/sim";
import { getContext } from "../context";
import { withRetry, type MatchRecord } from "../results";
import { ROOM_KEY, cleanName, type FightOptions, type PlayerInfo, type SeatAuth } from "../seats";
import { FightState, Seat } from "../state";

/** Both players must connect and load within this long, or the match is cancelled. */
export const READY_TIMEOUT_S = 30;
/** A finished room stays up this long (KO screen, result) before closing. */
export const LINGER_S = 60;

type Status = "waiting" | "live" | "paused" | "over" | "cancelled";

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
  /** Sides whose player dropped and may still come back. */
  #away = new Set<0 | 1>();
  /** Sides whose player is gone for good (left, or the grace ran out). */
  #gone = new Set<0 | 1>();
  #rounds: RoundRecord[] = [];
  #startedAt = new Date();
  #pauseEndsAt = 0;
  #finishing = false;

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

  override onAuth(client: Client, options: { name?: unknown } | undefined): SeatAuth | true {
    const auth = client.auth as SeatAuth | undefined;
    if (auth && (auth.side === 0 || auth.side === 1) && auth.player) return true;
    if (!this.#adhoc) throw new Error("this match is for its two players only");
    // Ad hoc room: first free seat, a guest identity.
    const side = this.#players[0] === null ? 0 : this.#players[1] === null ? 1 : null;
    if (side === null) throw new Error("room is full");
    const player: PlayerInfo = { id: `guest:${client.sessionId}`, address: null, name: cleanName(options?.name) ?? `P${side + 1}`, tier: "rust" };
    this.#players[side] = player;
    const seat = this.state.seats[side] as Seat;
    seat.name = player.name;
    return { side, player };
  }

  override onJoin(client: Client): void {
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
    this.#away.add(side);
    if (this.status === "live") this.#pause();
    try {
      await this.allowReconnection(client, RECONNECT_GRACE_S);
    } catch {
      this.#away.delete(side);
      this.#leftForGood(side);
    }
  }

  override onReconnect(client: Client): void {
    const side = this.#sideOf(client);
    if (side === null) return;
    this.#clients[side] = client;
    this.#away.delete(side);
    (this.state.seats[side] as Seat).connected = true;
    if (this.status === "paused" && this.#away.size === 0) this.#resume();
    else if (this.status === "live") client.sendBytes(Msg.sync, this.#syncBytes());
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
    // Let a live match finish (fly.toml's kill_timeout is 300 s); close everything else now.
    if (this.status === "live" || this.status === "paused") {
      this.clock.setInterval(() => {
        if (this.status !== "live" && this.status !== "paused") void this.disconnect();
      }, 1000);
      return;
    }
    void this.disconnect();
  }

  /** Advance one tick (only while live). */
  protected tick(): void {
    if (this.status !== "live") return;
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
    this.#pauseEndsAt = Date.now() + RECONNECT_GRACE_S * 1000;
    this.#countPause();
  }

  #resume(): void {
    this.state.status = "live";
    this.state.pauseLeft = 0;
    this.#broadcastSync();
  }

  #countPause(): void {
    if (this.status !== "paused") return;
    this.state.pauseLeft = Math.max(0, Math.ceil((this.#pauseEndsAt - Date.now()) / 1000));
  }

  /** A player is gone for good: the other wins by forfeit (if the match was on), or the match is off. */
  #leftForGood(side: 0 | 1): void {
    if (this.#gone.has(side)) return;
    this.#gone.add(side);
    const other: 0 | 1 = side === 0 ? 1 : 0;
    if (this.status === "waiting") {
      this.#cancel("opponent left");
    } else if (this.status === "live" || this.status === "paused") {
      if (this.#gone.has(other)) this.#cancel("both players left");
      else void this.#finish(other);
    }
  }

  #cancel(reason: string): void {
    if (this.status === "over" || this.status === "cancelled") return;
    this.state.status = "cancelled";
    this.state.reason = reason;
    this.clock.setTimeout(() => void this.disconnect(), 5000);
  }

  async #finish(forfeitWinner?: 0 | 1): Promise<void> {
    if (this.#finishing) return;
    this.#finishing = true;
    const s = this.#sm.state;
    const rounds = [...this.#rounds];
    if (forfeitWinner !== undefined) rounds.push(forfeitRound(s, forfeitWinner));
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
    const rec: MatchRecord = {
      id: this.#sm.matchId,
      ranked: this.state.ranked,
      region: ctx.region,
      startedAt: this.#startedAt,
      endedAt: new Date(),
      players,
      winner: res.winner,
      reason: res.reason,
      rounds,
      inputLog,
      resultHash: await resultHash(this.#sm.matchId, winnerAddress, inputLog),
      netQuality: [round3(this.#sm.quality(0)), round3(this.#sm.quality(1))],
    };
    ctx.memory.remember(rec);
    const store = rec.ranked ? ctx.ranked : ctx.memory;
    try {
      const elo = await withRetry(() => store.record(rec));
      elo.forEach(([before, after], i) => {
        const seat = this.state.seats[i] as Seat;
        seat.elo = before;
        seat.eloDelta = after - before;
      });
    } catch (e) {
      logger.error(`[fight ${this.roomId}] could not record the result:`, e);
    }
    this.state.recorded = true;
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
