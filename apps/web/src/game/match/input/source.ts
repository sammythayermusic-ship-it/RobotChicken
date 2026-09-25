import { CPU_LEVELS, cpuThink, createCpu, type CpuLevel, type CpuMemory, type MatchState } from "@cockfight/sim";
import type { KeyboardInput } from "./keyboard";
import type { TouchInput } from "./touch";

/** Anything that can produce a player's buttons for the next tick. */
export interface InputSource {
  sample(s: MatchState, side: 0 | 1): number;
}

export class KeyboardSource implements InputSource {
  private readonly kb: KeyboardInput;
  private readonly player: 0 | 1;
  constructor(kb: KeyboardInput, player: 0 | 1) {
    this.kb = kb;
    this.player = player;
  }
  sample(): number {
    return this.kb.sample(this.player);
  }
}

/** The on-screen buttons. The context button needs to know whether the fighter is in the air. */
export class TouchSource implements InputSource {
  private readonly touch: TouchInput;
  constructor(touch: TouchInput) {
    this.touch = touch;
  }
  sample(s: MatchState, side: 0 | 1): number {
    return this.touch.sample(s.f[side].grounded === 1);
  }
}

export class CpuSource implements InputSource {
  private readonly mem: CpuMemory;
  readonly level: CpuLevel;
  constructor(matchId: string, side: 0 | 1, level: CpuLevel) {
    this.mem = createCpu(matchId, side);
    this.level = level;
  }
  sample(s: MatchState, side: 0 | 1): number {
    return cpuThink(s, side, this.mem, CPU_LEVELS[this.level]);
  }
}

/** Test / debug source: a mask set from outside (window.__cockfight.setInput). */
export class ScriptSource implements InputSource {
  mask = 0;
  sample(): number {
    return this.mask;
  }
}

/** Replays a recorded per-tick mask array. */
export class ReplaySource implements InputSource {
  private i = 0;
  private readonly masks: ArrayLike<number>;
  constructor(masks: ArrayLike<number>) {
    this.masks = masks;
  }
  sample(): number {
    return this.i < this.masks.length ? (this.masks[this.i++] as number) : 0;
  }
}
