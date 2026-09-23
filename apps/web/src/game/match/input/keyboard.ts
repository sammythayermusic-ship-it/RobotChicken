import type { Bindings } from "./bindings";

export interface KeyTarget {
  addEventListener(type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: (e: Event) => void, opts?: EventListenerOptions): void;
}

/**
 * Keyboard -> per-player button masks. Tracks held keys plus a press latch
 * that is ORed into the next sample, so a tap shorter than one tick still
 * registers as a press. Uses KeyboardEvent.code (physical position, layout
 * independent), ignores auto-repeat and IME composition, and releases
 * everything on blur / tab hide so no key gets stuck.
 */
export class KeyboardInput {
  private held = new Set<string>();
  private latched = new Set<string>();
  /** Last few pressed codes (controls / ghosting tester). */
  readonly recent: string[] = [];

  private bindings: Bindings;
  private readonly target: KeyTarget;
  private readonly doc: (KeyTarget & { visibilityState?: string }) | undefined;

  constructor(bindings: Bindings, target: KeyTarget, doc?: KeyTarget & { visibilityState?: string }) {
    this.bindings = bindings;
    this.target = target;
    this.doc = doc;
    target.addEventListener("keydown", this.onDown);
    target.addEventListener("keyup", this.onUp);
    target.addEventListener("blur", this.releaseAll);
    doc?.addEventListener("visibilitychange", this.onVisibility);
  }

  setBindings(b: Bindings): void {
    this.bindings = b;
    this.releaseAll();
  }

  /** Buttons for one player this tick; consumes that player's latched presses. */
  sample(player: 0 | 1): number {
    let mask = 0;
    for (const code of this.held) mask |= this.bit(code, player);
    for (const code of [...this.latched]) {
      const bit = this.bit(code, player);
      if (bit) {
        mask |= bit;
        this.latched.delete(code);
      }
    }
    return mask;
  }

  /** Codes currently held (for the key tester). */
  heldCodes(): string[] {
    return [...this.held];
  }

  readonly releaseAll = (): void => {
    this.held.clear();
    this.latched.clear();
  };

  dispose(): void {
    this.target.removeEventListener("keydown", this.onDown);
    this.target.removeEventListener("keyup", this.onUp);
    this.target.removeEventListener("blur", this.releaseAll);
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.releaseAll();
  }

  private bit(code: string, player: 0 | 1): number {
    const b = this.bindings.get(code);
    return b && b[0] === player ? b[1] : 0;
  }

  private readonly onDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!this.bindings.has(e.code)) return;
    e.preventDefault(); // arrows / Space scroll, "/" opens Firefox quick find
    if (e.repeat) return;
    this.held.add(e.code);
    this.latched.add(e.code);
    this.recent.push(e.code);
    if (this.recent.length > 16) this.recent.shift();
  };

  private readonly onUp = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (!this.bindings.has(e.code)) return;
    e.preventDefault();
    this.held.delete(e.code);
  };

  private readonly onVisibility = (): void => {
    if (this.doc?.visibilityState === "hidden") this.releaseAll();
  };
}
