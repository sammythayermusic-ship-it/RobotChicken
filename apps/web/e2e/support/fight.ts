import { expect, type Page } from "@playwright/test";

/** Serializable view of window.__cockfight.fight for assertions. */
export interface FightSnapshot {
  tick: number;
  phase: number;
  round: number;
  w1: number;
  w2: number;
  matchWinner: number;
  f: { x: number; hp: number; heat: number; st: number; hitKind: number }[];
}

export async function openFight(page: Page, query: string): Promise<void> {
  await page.goto(`/play?${query}`);
  await expect(page).toHaveTitle(/COCKFIGHT/);
  await page.waitForFunction(() => (window as unknown as { __cockfight?: { fight?: { ready(): boolean } } }).__cockfight?.fight?.ready() === true, null, {
    timeout: 60_000,
  });
}

export function snap(page: Page): Promise<FightSnapshot> {
  return page.evaluate(() => {
    const s = (window as unknown as { __cockfight: { fight: { state(): FightSnapshot & { f: FightSnapshot["f"] } } } }).__cockfight.fight.state();
    return {
      tick: s.tick,
      phase: s.phase,
      round: s.round,
      w1: s.w1,
      w2: s.w2,
      matchWinner: s.matchWinner,
      f: s.f.map((x) => ({ x: x.x, hp: x.hp, heat: x.heat, st: x.st, hitKind: x.hitKind })),
    };
  });
}

/** Advance the sim n ticks inside the page (manual mode), then render a frame. */
export async function stepTicks(page: Page, n: number): Promise<void> {
  await page.evaluate((k) => (window as unknown as { __cockfight: { fight: { stepTicks(n: number): void } } }).__cockfight.fight.stepTicks(k), n);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

export function fightCall<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate((name) => {
    const f = (window as unknown as { __cockfight: { fight: Record<string, () => unknown> } }).__cockfight.fight;
    const v = (f[name] as () => unknown)();
    return JSON.parse(JSON.stringify(v)) as unknown;
  }, fn) as Promise<T>;
}
