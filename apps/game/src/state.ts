/**
 * Replicated room state, built with @colyseus/schema 5's decorator-free
 * `schema()` builder. It carries the match's metadata (who is seated, the
 * room's status, the result). The sim itself travels as binary messages
 * (packages/net): the full sim state has 73 fields, more than a Schema holds,
 * and the clients re-run the sim from the confirmed inputs anyway.
 */
import { schema, t, type SchemaType } from "@colyseus/schema";

export const Seat = schema(
  {
    name: t.string().default(""),
    /** Cosmetic tier (rust / chrome / gold / diamond). */
    tier: t.string().default("rust"),
    connected: t.boolean().default(false),
    /** Assets loaded; the match starts when both seats are ready. */
    ready: t.boolean().default(false),
    /** Rating before the match (0 in open mode: no ratings). */
    elo: t.int16().default(0),
    /** Rating change once the result is recorded. */
    eloDelta: t.int16().default(0),
  },
  "Seat",
);
export type Seat = SchemaType<typeof Seat>;

export const FightState = schema(
  {
    /** waiting (seats filling / loading) → live ⇄ paused (a player dropped) → over; or cancelled. */
    status: t.string().default("waiting"),
    /** The match id: sim seed, database row, replay URL. */
    matchId: t.string().default(""),
    /** Ranked (gate, database, ELO) or an open playtest match. */
    ranked: t.boolean().default(false),
    seats: t.array(Seat),
    /** Seconds left for a dropped player to come back (while paused). */
    pauseLeft: t.uint8().default(0),
    /** -1 undecided, 0 P1, 1 P2, 2 draw. */
    winner: t.int8().default(-1),
    /** matches.reason once over ('ko', 'forfeit', ...), or why a match was cancelled. */
    reason: t.string().default(""),
    /** True once the result is stored (the replay page can load it). */
    recorded: t.boolean().default(false),
    /** Ranked: what the win booked (raw units of the payout token, as a string), its dollar value, and why it is what it is. */
    payout: t.string().default("0"),
    payoutUsd: t.float32().default(0),
    payoutReason: t.string().default(""),
    /** The tier the win was paid at (the lower of the two). */
    payoutTier: t.string().default(""),
    /** The payout's transaction signature once the worker has sent it. */
    payoutSig: t.string().default(""),
    /** Sim tick (60 Hz), mirrored for /dev/net and the room list. */
    tick: t.uint32().default(0),
    /** Sim `Phase`: 0 countdown, 1 fighting, 2 roundEnd, 3 matchEnd. */
    phase: t.uint8().default(0),
    round: t.uint8().default(0),
    /** Round clock in ticks remaining. */
    timer: t.uint16().default(0),
  },
  "FightState",
);
export type FightState = SchemaType<typeof FightState>;
