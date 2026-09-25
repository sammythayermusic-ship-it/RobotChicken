/**
 * Phase 0 fight room: runs the deterministic sim on the server clock and
 * mirrors its round clock into the replicated state, so /dev/net can show a
 * live tick. Nobody's input reaches the sim yet; the input protocol, snapshots
 * and reconnection arrive in Phase 2.
 */
import { logger, Room, type RoomException, type RoomMethodName } from "@colyseus/core";
import { createMatch, step, type MatchState } from "@cockfight/sim";
import { SNAPSHOT_HZ, TICK_RATE } from "@cockfight/shared";
import { FightState } from "../state";

export class FightRoom extends Room<{ state: FightState }> {
  override maxClients = 2;
  /** 20 Hz patches over a 60 Hz sim (the `setPatchRate()` method is deprecated in 0.18). */
  override patchRate = 1000 / SNAPSHOT_HZ;
  override state = new FightState();

  #sim: MatchState | undefined;

  /** Current sim state, for tests and (Phase 2) snapshots. */
  get sim(): MatchState | undefined {
    return this.#sim;
  }

  override onCreate(): void {
    // Room ids are nanoid output ([A-Za-z0-9_-]), which the sim's ASCII-only seed hash accepts.
    this.#sim = createMatch({ matchId: this.roomId });
    this.#mirror(this.#sim);
    // Colyseus runs a fixed-step accumulator: every call is exactly one 1/60 s
    // step, and a long stall drops backlog instead of spiralling.
    this.setFixedTimestep(() => this.tick(), TICK_RATE);
  }

  /** Advance one tick. Both players send "no buttons" until Phase 2 wires input. */
  protected tick(): void {
    if (this.#sim === undefined) return;
    this.#sim = step(this.#sim, 0, 0);
    this.#mirror(this.#sim);
  }

  /**
   * Defining this makes Colyseus catch exceptions from room callbacks instead
   * of letting them reach the process-level handler, which (with graceful
   * shutdown on) would stop the whole server and every other match. A step
   * that threw leaves the sim in an unknown state, so this room is stopped and
   * closed rather than retried 60 times a second.
   */
  override onUncaughtException(error: RoomException, method: RoomMethodName): void {
    logger.error(`[fight ${this.roomId}] ${method} threw:`, error.cause ?? error);
    if (method === "setFixedTimestep") {
      this.setTimestep(); // no callback: clears the fixed-step interval
      this.#sim = undefined;
      void this.disconnect().catch(() => {});
    }
  }

  #mirror(s: MatchState): void {
    const st = this.state;
    st.tick = s.tick;
    st.phase = s.phase;
    st.round = s.round;
    st.timer = s.timer;
  }
}
