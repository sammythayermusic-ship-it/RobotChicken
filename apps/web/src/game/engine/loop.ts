/**
 * Fixed 60 Hz simulation with render interpolation. The sim advances in whole
 * ticks from an accumulator; rendering gets `alpha` in [0, 1) to blend the
 * previous and current states. Framework-free and clock-injectable for tests.
 */
export const STEP_MS = 1000 / 60;
/** Most ticks run in one frame before dropping the backlog (slow-mo beats a death spiral). */
export const MAX_CATCH_UP = 5;
/** A gap longer than this (tab switch, breakpoint) counts as a single tick. */
export const MAX_FRAME_MS = 250;

export interface LoopHooks {
  tick(): void;
  render(alpha: number, nowMs: number): void;
}

export interface Scheduler {
  request(cb: (t: number) => void): number;
  cancel(id: number): void;
}

export const rafScheduler: Scheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

export class FixedLoop {
  private acc = 0;
  private last = -1;
  private raf = 0;
  private running = false;
  /** Paused: render continues, the sim does not advance. */
  paused = false;
  /** Manual: the sim only advances through stepTicks() (deterministic e2e). */
  manual = false;
  ticks = 0;

  private readonly hooks: LoopHooks;
  private readonly sched: Scheduler;

  constructor(hooks: LoopHooks, sched: Scheduler = rafScheduler) {
    this.hooks = hooks;
    this.sched = sched;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    this.raf = this.sched.request(this.frame);
  }

  stop(): void {
    this.running = false;
    this.sched.cancel(this.raf);
  }

  /** Forget elapsed time (after a pause / tab return) so nothing catches up. */
  resetClock(): void {
    this.last = -1;
    this.acc = 0;
  }

  stepTicks(n: number): void {
    for (let i = 0; i < n; i++) {
      this.hooks.tick();
      this.ticks++;
    }
  }

  /** One animation frame; public for tests. Returns ticks run. */
  readonly frame = (now: number): number => {
    if (this.running) this.raf = this.sched.request(this.frame);
    let dt = this.last < 0 ? STEP_MS : now - this.last;
    this.last = now;
    if (dt > MAX_FRAME_MS) dt = STEP_MS;
    if (Math.abs(dt - STEP_MS) < 0.5) dt = STEP_MS; // vsync snap: no 0/2-step alternation at 60 Hz
    let n = 0;
    if (!this.paused && !this.manual) {
      this.acc += dt;
      while (this.acc >= STEP_MS - 1e-6 && n < MAX_CATCH_UP) {
        this.hooks.tick();
        this.ticks++;
        this.acc -= STEP_MS;
        n++;
      }
      if (n === MAX_CATCH_UP && this.acc > STEP_MS) this.acc = STEP_MS * 0.5;
    }
    const alpha = this.paused || this.manual ? 1 : Math.min(1, Math.max(0, this.acc / STEP_MS));
    this.hooks.render(alpha, now);
    return n;
  };
}
