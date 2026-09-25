/**
 * The authoritative match, independent of Colyseus: buffered inputs in,
 * one sim step at a time, the buttons actually used out. FightRoom drives it
 * from its fixed timestep; tests drive it from a simulated network.
 */
import {
  Phase, RULES, compressInputs, createMatch, step, stateHash, type MatchState, type Replay, type Rules,
} from "@cockfight/sim";
import { MAX_LEAD, type InputBatch } from "./protocol";

const RING = 64; // > MAX_LEAD + INPUT_DELAY, a power of two
const MASK = RING - 1;
/**
 * After this many missing ticks in a row a player's buttons go neutral
 * instead of repeating: a connection that died silently (a phone switching
 * networks) is only noticed at the transport's ping timeout, and until then
 * a held attack would keep swinging on its own.
 */
export const STALE_AFTER = 15;

export interface SideStats {
  /** Input ticks accepted. */
  received: number;
  /** Inputs that arrived after their tick was stepped (dropped). */
  late: number;
  /** Inputs more than MAX_LEAD ticks ahead (rejected; a sped-up or modified client). */
  ahead: number;
  /** Fighting ticks stepped without this player's input (their last buttons were repeated). */
  missed: number;
  /** Fighting ticks stepped. */
  fighting: number;
}

export interface StepOut {
  tick: number;
  b1: number;
  b2: number;
}

export class ServerMatch {
  readonly matchId: string;
  state: MatchState;
  private readonly R: Rules;
  /** Per side: tick tag, mask and how early it arrived, per ring slot. */
  private readonly tags: [Int32Array, Int32Array] = [new Int32Array(RING).fill(-1), new Int32Array(RING).fill(-1)];
  private readonly masks: [Uint8Array, Uint8Array] = [new Uint8Array(RING), new Uint8Array(RING)];
  private readonly early: [Int8Array, Int8Array] = [new Int8Array(RING), new Int8Array(RING)];
  /** Buttons used on the previous tick (repeated when an input is missing). */
  private readonly last: [number, number] = [0, 0];
  /** Consecutive ticks each player's input was missing. */
  private readonly missRun: [number, number] = [0, 0];
  /** Buttons used per tick (index = tick - 1): the replay log. */
  private readonly log: [number[], number[]] = [[], []];
  /** Smallest margin since the last takeMargin() (-1 = something was missing). */
  private readonly minMargin: [number, number] = [127, 127];
  readonly stats: [SideStats, SideStats] = [emptyStats(), emptyStats()];

  constructor(matchId: string, R: Rules = RULES) {
    this.matchId = matchId;
    this.R = R;
    this.state = createMatch({ matchId }, R);
  }

  get tick(): number {
    return this.state.tick;
  }

  get over(): boolean {
    return this.state.phase === Phase.matchEnd;
  }

  /** Buffer a player's inputs. Late ones are dropped, far-future ones rejected; both are counted. */
  receive(side: 0 | 1, batch: InputBatch): void {
    const now = this.state.tick;
    const st = this.stats[side];
    for (let i = 0; i < batch.masks.length; i++) {
      const t = batch.first + i;
      if (t <= now) {
        st.late++;
        continue;
      }
      if (t > now + MAX_LEAD) {
        st.ahead++;
        continue;
      }
      const k = t & MASK;
      if (this.tags[side][k] === t) continue; // first copy wins
      this.tags[side][k] = t;
      this.masks[side][k] = batch.masks[i] as number;
      this.early[side][k] = Math.min(127, t - now);
      st.received++;
    }
  }

  /** Advance one tick with the buffered inputs (a missing one repeats that player's last buttons). */
  step(): StepOut {
    const t = this.state.tick + 1;
    const fighting = this.state.phase === Phase.fighting;
    const b: [number, number] = [0, 0];
    for (const side of [0, 1] as const) {
      const k = t & MASK;
      if (this.tags[side][k] === t) {
        b[side] = this.masks[side][k] as number;
        this.minMargin[side] = Math.min(this.minMargin[side], this.early[side][k] as number);
        this.tags[side][k] = -1;
        this.missRun[side] = 0;
      } else {
        this.missRun[side]++;
        b[side] = this.missRun[side] > STALE_AFTER ? 0 : this.last[side];
        this.minMargin[side] = -1;
        if (fighting) this.stats[side].missed++;
      }
      if (fighting) this.stats[side].fighting++;
      this.last[side] = b[side];
      this.log[side].push(b[side]);
    }
    this.state = step(this.state, b[0], b[1], this.R);
    return { tick: t, b1: b[0], b2: b[1] };
  }

  /** The smallest margin of this side's inputs since the last call (-1 if any was missing), then reset. */
  takeMargin(side: 0 | 1): number {
    const m = this.minMargin[side];
    this.minMargin[side] = 127;
    return m;
  }

  /**
   * Share of fighting ticks this player's input arrived in time (spec
   * netQuality). 1 before any fighting tick.
   */
  quality(side: 0 | 1): number {
    const s = this.stats[side];
    return s.fighting === 0 ? 1 : 1 - s.missed / s.fighting;
  }

  /** Buttons used per tick, for both players (index = tick - 1). */
  masksUsed(): [readonly number[], readonly number[]] {
    return [this.log[0], this.log[1]];
  }

  toReplay(): Replay {
    return {
      v: 1,
      rulesHash: this.R.hash,
      matchId: this.matchId,
      ticks: this.log[0].length,
      p1: compressInputs(this.log[0]),
      p2: compressInputs(this.log[1]),
      finalHash: stateHash(this.state),
    };
  }
}

function emptyStats(): SideStats {
  return { received: 0, late: 0, ahead: 0, missed: 0, fighting: 0 };
}
