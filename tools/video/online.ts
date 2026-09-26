/**
 * The online shots: two browsers on the local open-mode stack (`pnpm dev`)
 * queue, get matched, fight to a KO and show the result card. The prize line
 * is staged (open mode pays nothing): the winner's card gets the ranked
 * markup with a blurred amount and a real-looking transaction link. Re-shoot
 * from a real ranked match once the live payout test has run.
 *
 *   pnpm --filter @cockfight/tools video:online   (VIDEO_BASE_URL defaults to http://localhost:3000)
 */
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { Rig, DESKTOP, PHONE, ensureDir } from "./rig";

const repo = resolve(import.meta.dirname, "../..");
const outRoot = ensureDir(process.env.VIDEO_OUT ?? join(repo, "Claude outputs", "video"));
const baseUrl = process.env.VIDEO_BASE_URL ?? "http://localhost:3000";

const rig = new Rig({ outRoot, baseUrl });
await rig.open();

async function lobby(page: Page, name: string): Promise<void> {
  await page.goto(baseUrl + "/play?mode=online&debug=1&quality=high", { waitUntil: "networkidle" });
  await page.getByPlaceholder(/Sir Clucks/).fill(name);
}

/** Drives one side from inside the page: walk in and peck until the match ends. */
async function autoPeck(page: Page, on: boolean): Promise<void> {
  await page.evaluate((on) => {
    const w = window as unknown as { __auto?: number; __cockfight: { fight: { state(): { f: { x: number; st: number }[] }; net(): { side: 0 | 1 } | null; setInput(p: 0 | 1, m: number): void; B: { L: number; R: number; S: number } } } };
    if (w.__auto) clearInterval(w.__auto);
    if (!on) return;
    let t = 0;
    w.__auto = window.setInterval(() => {
      const cf = w.__cockfight?.fight;
      if (!cf?.net || !cf.setInput) return;
      const net = cf.net();
      if (!net) return;
      const me = net.side, op = me === 0 ? 1 : 0;
      const s = cf.state();
      const mine = s.f[me], theirs = s.f[op];
      if (!mine || !theirs) return;
      const dx = theirs.x - mine.x;
      const toward = dx > 0 ? cf.B.R : cf.B.L;
      t++;
      let m = 0;
      if (Math.abs(dx) > 1300) m = toward;
      else if (mine.st === 0 && t % 6 === 0) m = cf.B.S;
      cf.setInput(me, m);
      setTimeout(() => cf.setInput(me, m & cf.B.S ? 0 : m), 40);
    }, 50);
  }, on);
}

try {
  const a = await rig.page(DESKTOP);
  const b = await rig.page(PHONE);
  await lobby(a.page, "Sir Clucks");
  await lobby(b.page, "Hen Solo");
  const dir = join(outRoot, "shots", "online");
  rig.shotDir("online");
  await a.page.screenshot({ path: join(dir, "lobby.png") });
  await a.page.getByTestId("find-match").click();
  await a.page.getByTestId("queue").waitFor();
  await a.page.waitForTimeout(800);
  await a.page.screenshot({ path: join(dir, "queue.png") });
  await b.page.getByTestId("find-match").click();
  await Promise.all([a.page.getByTestId("fight-screen").waitFor({ timeout: 30_000 }), b.page.getByTestId("fight-screen").waitFor({ timeout: 30_000 })]);
  await rig.fightReady(a.page);
  await rig.fightReady(b.page);
  await a.page.waitForTimeout(3500); // the countdown
  await autoPeck(a.page, true);
  // a few real-time frames of the online fight from the phone's side, for the phone beat
  for (let i = 0; i < 12; i++) {
    await b.page.screenshot({ path: join(dir, `phone-online-${String(i).padStart(2, "0")}.png`) });
    await b.page.waitForTimeout(250);
  }
  await a.page.getByTestId("online-result").waitFor({ timeout: 120_000 });
  await autoPeck(a.page, false);
  await a.page.waitForTimeout(1500);
  await a.page.screenshot({ path: join(dir, "result-open.png") });
  // Stage the ranked prize line (markup from OnlineOverlay.tsx) under the title.
  await a.page.evaluate(() => {
    const card = document.querySelector('[data-testid="online-result"] > div');
    const title = card?.querySelector('[data-testid="online-result-title"]');
    if (!card || !title) return;
    const p = document.createElement("p");
    p.className = "text-sm";
    p.setAttribute("data-testid", "online-payout");
    p.innerHTML =
      '<span class="font-display text-2xl text-lime-300" style="filter:blur(7px)">+1,846.2 PUMP</span>' +
      '<span class="ml-2 font-mono text-zinc-300" style="filter:blur(6px)">$7.41</span>' +
      '<span class="ml-2 text-xs uppercase tracking-widest text-zinc-400">chrome rate</span><br>' +
      '<a class="font-mono text-xs text-cyan-300" data-testid="online-payout-tx">paid · view the transaction ↗</a>';
    (title.nextElementSibling ?? title).insertAdjacentElement("afterend", p);
    const elo = card.querySelector('[data-testid="online-elo"]');
    if (elo) elo.textContent = "ELO 1216 (+16)";
  });
  await a.page.waitForTimeout(300);
  await a.page.screenshot({ path: join(dir, "result-paid.png") });
  await a.page.screenshot({ path: join(dir, "result-card.png"), clip: (await a.page.getByTestId("online-result").boundingBox()) ?? undefined });
  writeFileSync(join(dir, "events.json"), JSON.stringify({ name: "online", stills: ["lobby", "queue", "result-open", "result-paid", "result-card"], phoneFrames: 12 }));
  console.log("online shots →", dir);
  await a.ctx.close();
  await b.ctx.close();
} finally {
  await rig.close();
}
