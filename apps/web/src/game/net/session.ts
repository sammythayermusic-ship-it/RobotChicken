/**
 * The browser's side of an online match, framework-free.
 *
 * - `joinQueue()` enters the matchmaking queue and resolves when the server
 *   pairs this player (or rejects with why it couldn't).
 * - `NetSession` is one fight room: it registers the sim message handlers the
 *   moment the room is joined (so nothing the server sends is dropped while
 *   the fight loads), owns the ClientPredictor, mirrors the room's metadata
 *   for the page (status, seats, result), and keeps the RTT measured.
 */
import { Client, type Room } from "@colyseus/sdk";
import { ClientPredictor, Msg, decodeFrames, decodeSync } from "@cockfight/net";
import { RULES, type MatchState } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import { publicEnv } from "@/env.public";

export type NetStatus = "waiting" | "live" | "paused" | "over" | "cancelled";

export interface SeatView {
  name: string;
  tier: Tier;
  connected: boolean;
  ready: boolean;
  elo: number;
  eloDelta: number;
}

/** What the win booked (ranked), as the room mirrors it from the database. */
export interface PayoutView {
  /** Raw units of the payout token, as a string (0 when nothing was booked). */
  amount: string;
  usd: number;
  /** paid, quality, flagged, cap_wins, cap_opponent, no_pool, draw, open. */
  reason: string;
  /** The tier the win paid at (the lower of the two). */
  tier: string;
  /** The transaction once the worker has sent it. */
  sig: string;
}

export interface NetSnapshot {
  status: NetStatus;
  seats: [SeatView, SeatView];
  /** -1 undecided, 0 / 1, 2 draw. */
  winner: number;
  reason: string;
  recorded: boolean;
  ranked: boolean;
  pauseLeft: number;
  /** This client lost its connection and the SDK is trying to get back in. */
  reconnecting: boolean;
  /** The connection is gone for good while the match wasn't over (the server has forfeited it by now). */
  lost: boolean;
  rtt: number;
  payout: PayoutView;
}

/** Who sits where, as the queue announced it (stable for the whole fight). */
export interface Seating {
  names: [string, string];
  tiers: [Tier, Tier];
}

export interface QueueOptions {
  /** Ranked: the queue token from POST /gate. */
  token?: string;
  /** Open playtest: a display name and a stable per-browser id. */
  name?: string;
  guestId?: string;
  /** A stable per-browser id (ranked): the queue never pairs two tickets from one browser, and the caps count by it. */
  fp?: string;
  rtt: number;
}

export interface QueueHandle {
  /** Players waiting in this region's queue (updates live). */
  onSize(cb: (n: number) => void): void;
  /** Resolves with the fight room when matched; rejects on a kick or a lost connection. */
  readonly matched: Promise<NetSession>;
  leave(): Promise<void>;
}

export class QueueKick extends Error {
  readonly reason: string;
  readonly usd?: number;
  readonly shortUsd?: number;
  constructor(m: { reason: string; message: string; usd?: number; shortUsd?: number }) {
    super(m.message);
    this.reason = m.reason;
    this.usd = m.usd;
    this.shortUsd = m.shortUsd;
  }
}

interface MatchedMsg {
  reservation: unknown;
  side: 0 | 1;
  matchId: string;
  opponent: { name: string; tier: Tier };
}

export function gameClient(url: string = publicEnv.NEXT_PUBLIC_GAME_WS_URL): Client {
  return new Client(url);
}

/**
 * Enter the queue. `me` is how this player appears (the name typed, or the
 * wallet's anon name and gate tier), for the seating handed to the fight.
 */
export async function joinQueue(opts: QueueOptions, me: { name: string; tier: Tier }, client: Client = gameClient()): Promise<QueueHandle> {
  // rules: the server refuses a client whose sim differs from its own (a stale cached page).
  const queue = await client.join("queue", { ...opts, rules: RULES.hash });
  const sizeCbs: ((n: number) => void)[] = [];
  queue.onStateChange((s: { size?: number }) => {
    if (typeof s.size === "number") for (const cb of sizeCbs) cb(s.size);
  });
  let left = false;
  const offs: (() => void)[] = [];
  const matched = new Promise<NetSession>((resolve, reject) => {
    offs.push(
      queue.onMessage("matched", (m: MatchedMsg) => {
        left = true;
        void queue.leave().catch(() => {});
        client
          .consumeSeatReservation(m.reservation as never)
          .then((room) => {
            const seating: Seating =
              m.side === 0
                ? { names: [me.name, m.opponent.name], tiers: [me.tier, m.opponent.tier] }
                : { names: [m.opponent.name, me.name], tiers: [m.opponent.tier, me.tier] };
            resolve(new NetSession(room, m.side, m.matchId, seating));
          })
          .catch(reject);
      }),
      queue.onMessage("kicked", (m: { reason: string; message: string; usd?: number; shortUsd?: number }) => {
        left = true;
        reject(new QueueKick(m));
      }),
    );
    queue.onLeave((code: number) => {
      if (!left) reject(new QueueKick({ reason: "connection", message: `Lost the connection to the game server (${code}).` }));
    });
  });
  // Keep the server's RTT for this ticket current (it pairs by RTT).
  const ping = setInterval(() => {
    if (queue.connection.isOpen) queue.ping((ms) => queue.send("rtt", ms));
  }, 3000);
  void matched.finally(() => clearInterval(ping)).catch(() => {});
  return {
    onSize: (cb) => sizeCbs.push(cb),
    matched,
    leave: async () => {
      left = true;
      clearInterval(ping);
      // A "matched" already in flight must not start a match nobody is waiting for.
      for (const off of offs) off();
      queue.reconnection.enabled = false;
      try {
        if (queue.connection.isOpen) await queue.leave();
        else queue.connection.close();
      } catch {
        // already gone
      }
    },
  };
}

const EMPTY_SEAT: SeatView = { name: "", tier: "rust", connected: false, ready: false, elo: 0, eloDelta: 0 };
const NO_PAYOUT: PayoutView = { amount: "0", usd: 0, reason: "", tier: "", sig: "" };

export class NetSession {
  readonly room: Room;
  readonly side: 0 | 1;
  readonly matchId: string;
  readonly pred: ClientPredictor;
  readonly seating: Seating;
  private snap: NetSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly pinger: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(room: Room, side: 0 | 1, matchId: string, seating: Seating) {
    this.room = room;
    this.side = side;
    this.matchId = matchId;
    this.seating = seating;
    this.pred = new ClientPredictor(matchId, side);
    this.snap = {
      status: "waiting",
      seats: [EMPTY_SEAT, EMPTY_SEAT],
      winner: -1,
      reason: "",
      recorded: false,
      ranked: false,
      pauseLeft: 0,
      reconnecting: false,
      lost: false,
      rtt: 100,
      payout: NO_PAYOUT,
    };
    // Reconnect even in a fight's first seconds (the SDK's default waits 5 s of uptime).
    room.reconnection.minUptime = 0;
    room.reconnection.maxRetries = 8;

    room.onMessage(Msg.frames, (bytes: Uint8Array) => {
      const f = decodeFrames(bytes);
      if (f) this.pred.onFrames(f);
    });
    room.onMessage(Msg.sync, (bytes: Uint8Array) => {
      const s = decodeSync(bytes);
      if (s) this.pred.onSync(s);
    });
    room.onStateChange((s: unknown) => this.readState(s));
    room.onDrop(() => this.patch({ reconnecting: true }));
    room.onReconnect(() => this.patch({ reconnecting: false }));
    room.onLeave(() => {
      const wasOn = !this.closed && this.snap.status !== "over" && this.snap.status !== "cancelled";
      this.closed = true;
      clearInterval(this.pinger);
      this.patch({ reconnecting: false, lost: wasOn });
    });
    const ping = () => {
      if (!this.room.connection.isOpen) return;
      this.room.ping((ms) => {
        this.pred.setRtt(ms);
        this.patch({ rtt: Math.round(ms) });
      });
    };
    ping();
    this.pinger = setInterval(ping, 2000);
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly snapshot = (): NetSnapshot => this.snap;

  /** The fight has loaded: the server starts the match once both players are ready. */
  ready(): void {
    if (!this.closed) this.room.send(Msg.ready);
  }

  /**
   * One 60 Hz tick of the fight loop: follow the room's pause, advance the
   * prediction with this player's buttons and send them.
   */
  tick(sample: (shown: MatchState) => number): number {
    const st = this.snap.status;
    if (st === "paused" || this.snap.reconnecting) this.pred.pause();
    else if (st === "live") this.pred.resume();
    const ran = this.pred.tick(sample);
    if (this.room.connection.isOpen) for (const bytes of this.pred.takeOutgoing()) this.room.sendBytes(Msg.input, bytes);
    else this.pred.takeOutgoing(); // stale buttons are worthless after a reconnect
    return ran;
  }

  /** Leave the room (forfeits a match still on). Stops any reconnect in progress too. */
  async leave(): Promise<void> {
    clearInterval(this.pinger);
    this.closed = true;
    this.room.reconnection.enabled = false;
    try {
      if (this.room.connection.isOpen) await this.room.leave();
      else this.room.connection.close();
    } catch {
      // already gone
    }
  }

  dispose(): void {
    clearInterval(this.pinger);
    this.listeners.clear();
  }

  private readState(raw: unknown): void {
    const s = raw as {
      status?: string;
      seats?: ArrayLike<Partial<SeatView>> & Iterable<Partial<SeatView>>;
      winner?: number;
      reason?: string;
      recorded?: boolean;
      ranked?: boolean;
      pauseLeft?: number;
      payout?: string;
      payoutUsd?: number;
      payoutReason?: string;
      payoutTier?: string;
      payoutSig?: string;
    };
    const seats = s.seats ? Array.from(s.seats) : [];
    const seat = (i: number): SeatView => ({ ...EMPTY_SEAT, ...(seats[i] ?? {}) }) as SeatView;
    this.patch({
      status: (s.status as NetStatus) ?? this.snap.status,
      seats: [seat(0), seat(1)],
      winner: typeof s.winner === "number" ? s.winner : this.snap.winner,
      reason: s.reason ?? this.snap.reason,
      recorded: !!s.recorded,
      ranked: !!s.ranked,
      pauseLeft: s.pauseLeft ?? 0,
      payout: {
        amount: s.payout ?? "0",
        usd: typeof s.payoutUsd === "number" ? s.payoutUsd : 0,
        reason: s.payoutReason ?? "",
        tier: s.payoutTier ?? "",
        sig: s.payoutSig ?? "",
      },
    });
  }

  private patch(p: Partial<NetSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const fn of this.listeners) fn();
  }
}
