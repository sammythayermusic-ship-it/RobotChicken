import type { CDPSession, Locator, Page } from "@playwright/test";

/**
 * Real touches, several fingers at once, through the Chrome DevTools
 * protocol: the browser turns them into touch and pointer events
 * (pointerType "touch") exactly as a phone's screen would, compositor and
 * touch-action included. Chromium only.
 */
export class Fingers {
  private readonly cdp: CDPSession;
  private readonly page: Page;
  private readonly down = new Map<number, { x: number; y: number }>();

  private constructor(page: Page, cdp: CDPSession) {
    this.page = page;
    this.cdp = cdp;
  }

  static async on(page: Page): Promise<Fingers> {
    return new Fingers(page, await page.context().newCDPSession(page));
  }

  /** Finger `id` lands at (x, y) (CSS px), or at the centre of `at`. */
  async press(id: number, at: Locator | { x: number; y: number }): Promise<void> {
    const p = "x" in at ? at : await centre(at);
    this.down.set(id, p);
    await this.send("touchStart");
  }

  async move(id: number, x: number, y: number): Promise<void> {
    this.down.set(id, { x, y });
    await this.send("touchMove");
  }

  /** Finger `id` lifts (the others stay down): CDP's touchEnd releases the points it lists. */
  async lift(id: number): Promise<void> {
    const p = this.down.get(id);
    if (!p) return;
    this.down.delete(id);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [point(id, p)] });
    await this.page.evaluate(() => 0);
  }

  /** A quick tap: down and up before the sim ticks. */
  async tap(id: number, at: Locator | { x: number; y: number }): Promise<void> {
    await this.press(id, at);
    await this.lift(id);
  }

  async liftAll(): Promise<void> {
    for (const id of [...this.down.keys()]) await this.lift(id);
  }

  private async send(type: "touchStart" | "touchMove"): Promise<void> {
    const touchPoints = [...this.down].map(([id, p]) => point(id, p));
    await this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
    // A round trip, so the page has run its handlers before the next step.
    await this.page.evaluate(() => 0);
  }
}

const point = (id: number, p: { x: number; y: number }) => ({ id, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 });

export async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error("element has no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A point on the d-pad: dx, dy are fractions of its radius from the centre (+y is down). */
export async function onPad(pad: Locator, dx: number, dy: number): Promise<{ x: number; y: number }> {
  const b = await pad.boundingBox();
  if (!b) throw new Error("d-pad has no box");
  const r = b.width / 2;
  return { x: b.x + r + dx * r, y: b.y + b.height / 2 + dy * r };
}
