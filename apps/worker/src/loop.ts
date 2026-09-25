/**
 * The schedule: which treasury job runs when, with one job of each kind in
 * flight at a time, and the status the health endpoint reports.
 *
 *   every 5 s    pay pass (live only)
 *   every 60 s   settings reload, pool recompute, midnight check
 *   every 10 min claim tick (CLAIM_EVERY_MIN; live only; observer refreshes the price instead)
 *   at boot      reconcile
 */
import type { Chain, ClaimResult, Price, PreparedTransfer, Treasury, TxStatus } from "@cockfight/economy";
import { JupiterPrice, SolanaRpc } from "@cockfight/solana";
import type { SupabaseLedger } from "./ledger";
import type { WorkerStatus } from "./server";

export type WorkerMode = "health" | "observer" | "live";

export const PAY_EVERY_MS = 5_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** Prices only: the observer computes the pool and never touches a wallet. */
export class ObserverChain implements Chain {
  private readonly rpc: SolanaRpc;
  private readonly prices: JupiterPrice;
  private readonly mint: string;
  decimals = -1;
  constructor(rpc: SolanaRpc, prices: JupiterPrice, mint: string) {
    this.rpc = rpc;
    this.prices = prices;
    this.mint = mint;
  }
  async init(): Promise<void> {
    this.decimals = (await this.rpc.getMint(this.mint)).decimals;
  }
  async price(): Promise<Price> {
    if (this.decimals < 0) await this.init();
    const usd = await this.prices.usdPrice(this.mint);
    if (usd === null) throw new Error(`no price for ${this.mint}`);
    return { usd, decimals: this.decimals };
  }
  async hotBalance(): Promise<bigint> {
    return 0n;
  }
  async hotSol(): Promise<bigint> {
    return 0n;
  }
  async prepareTransfer(): Promise<PreparedTransfer> {
    throw new Error("observer mode: no payouts");
  }
  async status(): Promise<TxStatus> {
    return "unknown";
  }
  async claim(): Promise<ClaimResult | null> {
    return null;
  }
  async seedTransfer(): Promise<string> {
    throw new Error("observer mode: no seed draw");
  }
  async sweep(): Promise<string | null> {
    return null;
  }
}

export interface WorkerLoopOptions {
  treasury: Treasury;
  ledger: SupabaseLedger;
  mode: WorkerMode;
  status: WorkerStatus;
  reloadParams: () => Promise<void>;
  now?: () => number;
  /** Minutes between fee claims (default 10). */
  claimEveryMin?: number;
}

export class WorkerLoop {
  private readonly o: WorkerLoopOptions;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Map<string, Promise<void>>();
  private lastClaimSlot = -1;
  private stopped = false;

  constructor(o: WorkerLoopOptions) {
    this.o = o;
  }

  /** Which claim window `now` falls in (windows of claimEveryMin minutes, aligned to the clock). */
  private claimSlot(): number {
    return Math.floor(this.now / ((this.o.claimEveryMin ?? 10) * MINUTE_MS));
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Run `fn` under `name` unless the previous run is still going. Errors are logged and reported, never thrown. */
  private guard(name: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.running.get(name);
    if (prev) return prev;
    const p = fn()
      .then(() => {
        this.o.status.lastError = undefined;
      })
      .catch((e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        console.error(`[worker] ${name} failed: ${m}`);
        this.o.status.lastError = `${name}: ${m}`;
        this.o.status.errors = (this.o.status.errors ?? 0) + 1;
      })
      .finally(() => this.running.delete(name));
    this.running.set(name, p);
    return p;
  }

  async start(): Promise<void> {
    const { treasury, mode, status } = this.o;
    status.mode = mode;
    status.payoutsEnabled = mode === "live";
    await this.guard("reload", this.o.reloadParams);
    await this.guard("reconcile", async () => {
      await treasury.reconcile(this.now);
      this.lastClaimSlot = this.claimSlot();
      this.publish();
    });
    this.timers.push(setInterval(() => void this.minute(), MINUTE_MS));
    if (mode === "live") this.timers.push(setInterval(() => void this.guard("pay", () => this.pay()), PAY_EVERY_MS));
    for (const t of this.timers) t.unref();
    console.log(`[worker] ${mode}: jobs scheduled`);
  }

  private async minute(): Promise<void> {
    if (this.stopped) return;
    await this.guard("reload", this.o.reloadParams);
    const slot = this.claimSlot();
    if (slot !== this.lastClaimSlot) {
      this.lastClaimSlot = slot;
      await this.guard("claim", async () => {
        if (this.o.mode === "live") await this.o.treasury.claimTick(this.now);
        else await this.o.treasury.refreshPrice();
        this.o.status.lastClaimAt = new Date(this.now).toISOString();
      });
    }
    await this.guard("midnight", async () => {
      const r = await this.o.treasury.midnight(this.now);
      if (r.daily > 0 || r.seed) this.o.status.lastMidnight = { at: new Date(this.now).toISOString(), daily: r.daily, seed: r.seed?.total.toString() ?? null };
    });
    await this.guard("recompute", async () => {
      await this.o.treasury.recompute(this.now);
      this.publish();
    });
  }

  private async pay(): Promise<void> {
    if (this.stopped) return;
    const r = await this.o.treasury.payPass(this.now);
    if (r.sent || r.confirmed || r.retried || r.failed) {
      this.o.status.pay = { at: new Date(this.now).toISOString(), ...r };
      console.log(`[worker] pay pass: sent ${r.sent} confirmed ${r.confirmed} deferred ${r.deferred} retried ${r.retried} failed ${r.failed}`);
    }
  }

  private publish(): void {
    const s = this.o.treasury.state;
    if (!s) return;
    this.o.status.pool = {
      computedAt: new Date(this.now).toISOString(),
      priceUsd: s.price.usd,
      perWin: { rust: s.perWin.rust.toString(), chrome: s.perWin.chrome.toString(), gold: s.perWin.gold.toString() },
      dailyPool: s.dailyPool.toString(),
      perWinBudget: s.perWinBudget.toString(),
      weightedMilli: s.weightedMilli.toString(),
    };
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
  }

  /** Wait for in-flight jobs (a pay pass mid-send must finish writing the ledger). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }
}
