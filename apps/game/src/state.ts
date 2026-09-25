/**
 * Replicated room state, built with @colyseus/schema 5's decorator-free
 * `schema()` builder (no experimentalDecorators / useDefineForClassFields
 * hacks, so tsx, esbuild and vitest all compile it the same way).
 *
 * Phase 0 mirrors only the round clock so /dev/net can show a live tick.
 * Phase 2 replaces this with the real snapshot protocol.
 */
import { schema, t, type SchemaType } from "@colyseus/schema";

export const FightState = schema(
  {
    /** Sim tick (60 Hz). uint32 wraps after ~2.2 years of one room. */
    tick: t.uint32().default(0),
    /** Sim `Phase`: 0 countdown, 1 fighting, 2 roundEnd, 3 matchEnd. */
    phase: t.uint8().default(0),
    /** 1-based round number (the sim caps a match at 5). */
    round: t.uint8().default(0),
    /** Round clock in ticks remaining (3600 per round, 1800 in sudden death). */
    timer: t.uint16().default(0),
  },
  "FightState",
);
export type FightState = SchemaType<typeof FightState>;
