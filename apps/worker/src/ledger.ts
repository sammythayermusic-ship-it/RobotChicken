/**
 * The Ledger on Supabase, through the Data API (PostgREST) and the Phase 3
 * SQL functions. One worker process writes here; the game server books wins
 * through record_match; the site reads the public views.
 */
import type {
  ClaimRecord, DailyPoolBooking, DailyReward, Ledger, LedgerWindow, PauseState, PayoutRow, PoolState, RankedPlayer, SeedBalance, SeedDraw, WinBooking,
} from "@cockfight/economy";
import { supabaseHeaders } from "./supabase";

export interface SupabaseLedgerOptions {
  url: string;
  serviceKey: string;
  fetch?: typeof fetch;
}

interface PayoutRecord {
  id: string;
  kind: "win" | "daily";
  idem_key: string;
  to_address: string;
  amount: string;
  status: PayoutRow["status"];
  tx_sig: string | null;
  attempts: number;
  created_at: string;
  sent_at: string | null;
}

const toRow = (r: PayoutRecord): PayoutRow => ({
  id: r.id,
  kind: r.kind,
  idemKey: r.idem_key,
  to: r.to_address,
  amount: BigInt(r.amount),
  status: r.status,
  sig: r.tx_sig,
  attempts: r.attempts,
  createdAt: Date.parse(r.created_at),
  sentAt: r.sent_at ? Date.parse(r.sent_at) : null,
});

const iso = (ms: number) => new Date(ms).toISOString();
const big = (s: string | number | null | undefined) => BigInt(s ?? 0);

export class SupabaseLedger implements Ledger {
  private readonly url: string;
  private readonly key: string;
  private readonly f: typeof fetch;

  constructor(o: SupabaseLedgerOptions) {
    this.url = o.url.replace(/\/$/, "");
    this.key = o.serviceKey;
    this.f = o.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const headers = supabaseHeaders(this.key);
    if (prefer) headers.prefer = prefer;
    const res = await this.f(`${this.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`supabase ${method} ${path.split("?")[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    return this.req<T>("POST", `rpc/${fn}`, args);
  }

  async window(now: number): Promise<LedgerWindow> {
    const [w] = await this.rpc<Record<string, string>[]>("treasury_window", { p_now: iso(now) });
    if (!w) throw new Error("treasury_window returned no row");
    return {
      gross24h: big(w.gross_24h),
      grossToday: big(w.gross_today),
      playerShare24h: big(w.player_share_24h),
      weighted24hMilli: big(w.weighted_24h_milli),
      allowance: big(w.allowance),
      sentLastHour: big(w.sent_last_hour),
      sentToday: big(w.sent_today),
      outstanding: big(w.outstanding),
      seedToday: { win: big(w.seed_win), daily: big(w.seed_daily), total: big(w.seed_total), shortfall: 0n },
    };
  }

  async writePoolState(s: PoolState, now: number): Promise<void> {
    const w = await this.window(now);
    await this.req(
      "POST",
      "pool_state?on_conflict=id",
      {
        id: true,
        computed_at: iso(now),
        price_usd: s.price.usd,
        decimals: s.price.decimals,
        win_rust: s.perWin.rust,
        win_chrome: s.perWin.chrome,
        win_gold: s.perWin.gold,
        per_win_budget: s.perWinBudget,
        weighted_milli: s.weightedMilli,
        daily_pool: s.dailyPool,
        hot_target: s.hotTarget,
        gross_24h: w.gross24h,
        gross_today: w.grossToday,
        allowance: w.allowance,
        outstanding: w.outstanding,
        detail: {
          min: { rust: s.perWinMin.rust.toString(), chrome: s.perWinMin.chrome.toString(), gold: s.perWinMin.gold.toString() },
          max: { rust: s.perWinMax.rust.toString(), chrome: s.perWinMax.chrome.toString(), gold: s.perWinMax.gold.toString() },
          base: s.base.toString(),
          seedToday: { win: w.seedToday.win.toString(), daily: w.seedToday.daily.toString() },
        },
      },
      "resolution=merge-duplicates,return=minimal",
    );
    const minute = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
    await this.req(
      "POST",
      "pool_snapshots?on_conflict=at",
      { at: minute, price_usd: s.price.usd, win_rust: s.perWin.rust, daily_pool: s.dailyPool, gross_24h: w.gross24h, weighted_milli: s.weightedMilli },
      "resolution=merge-duplicates,return=minimal",
    );
  }

  async recordClaim(c: ClaimRecord): Promise<void> {
    await this.req(
      "POST",
      "fee_claims",
      { stage: c.stage, gross: c.gross, player_share: c.playerShare, project_share: c.projectShare, sig: c.sig, price_usd: c.priceUsd, at: iso(c.at) },
      "return=minimal",
    );
  }

  async recordSweep(amount: bigint, sig: string, at: number): Promise<void> {
    await this.req("POST", "sweeps", { sig, amount, at: iso(at) }, "return=minimal");
  }

  async duePayouts(now: number, limit: number): Promise<PayoutRow[]> {
    const rows = await this.req<PayoutRecord[]>(
      "GET",
      `payouts?select=*&or=(status.eq.pending,and(status.eq.deferred,or(next_attempt_at.is.null,next_attempt_at.lte.${encodeURIComponent(iso(now))})))&order=created_at.asc&limit=${limit}`,
    );
    return rows.map(toRow);
  }

  async sentPayouts(): Promise<PayoutRow[]> {
    return (await this.req<PayoutRecord[]>("GET", "payouts?select=*&status=eq.sent&order=sent_at.asc&limit=200")).map(toRow);
  }

  /** PATCH one row under a status guard; throws when no row matched (a double send would be one). */
  private async patch(id: string, from: string[], body: Record<string, unknown>): Promise<void> {
    const rows = await this.req<unknown[]>("PATCH", `payouts?id=eq.${id}&status=in.(${from.join(",")})`, body, "return=representation");
    if (rows.length !== 1) throw new Error(`payout ${id}: expected status in (${from.join(",")}), no row updated`);
  }

  async markSent(id: string, sig: string, at: number): Promise<void> {
    await this.patch(id, ["pending", "deferred"], { status: "sent", tx_sig: sig, sent_at: iso(at), last_error: null });
  }

  async markPaid(id: string, at: number): Promise<void> {
    await this.patch(id, ["sent"], { status: "paid", paid_at: iso(at) });
  }

  async markDeferred(id: string, reason: string, nextAt: number): Promise<void> {
    await this.patch(id, ["pending", "deferred"], { status: "deferred", last_error: reason.slice(0, 500), next_attempt_at: iso(nextAt) });
  }

  async markRetry(id: string, reason: string): Promise<void> {
    const [row] = await this.req<PayoutRecord[]>("GET", `payouts?select=attempts&id=eq.${id}`);
    await this.patch(id, ["sent"], { status: "pending", tx_sig: null, sent_at: null, attempts: (row?.attempts ?? 0) + 1, last_error: reason.slice(0, 500) });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.patch(id, ["sent", "pending", "deferred"], { status: "failed", last_error: reason.slice(0, 500) });
  }

  async setting<T>(key: string): Promise<T | null> {
    const rows = (await this.req<{ value: T }[]>("GET", `settings?select=value&key=eq.${key}`)) ?? [];
    return rows[0]?.value ?? null;
  }

  async settings(): Promise<Record<string, unknown>> {
    const rows = (await this.req<{ key: string; value: unknown }[]>("GET", "settings?select=key,value")) ?? [];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async pause(): Promise<PauseState> {
    const v = await this.setting<{ paused?: boolean; reason?: string | null }>("payouts_paused");
    return { paused: !!v?.paused, reason: v?.reason ?? null };
  }

  async setPause(paused: boolean, reason: string | null): Promise<void> {
    await this.req(
      "POST",
      "settings?on_conflict=key",
      { key: "payouts_paused", value: { paused, reason, at: iso(Date.now()) }, updated_at: iso(Date.now()), updated_by: "worker" },
      "resolution=merge-duplicates,return=minimal",
    );
  }

  async hasDaily(day: string): Promise<boolean> {
    return (await this.req<unknown[]>("GET", `daily_pools?select=day&day=eq.${day}`)).length > 0;
  }

  async dailyRanking(day: string): Promise<RankedPlayer[]> {
    return this.rpc<RankedPlayer[]>("daily_ranking", { p_day: day });
  }

  async dailyPoolInputs(day: string): Promise<{ grossDay: bigint; seedDaily: bigint }> {
    const start = `${day}T00:00:00Z`;
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    const claims = await this.req<{ gross: string }[]>("GET", `fee_claims?select=gross&at=gte.${start}&at=lt.${end}`);
    const draws = await this.req<{ daily: string }[]>("GET", `seed_draws?select=daily&day=eq.${day}`);
    return { grossDay: claims.reduce((a, c) => a + BigInt(c.gross), 0n), seedDaily: big(draws[0]?.daily) };
  }

  async bookDaily(day: string, booking: DailyPoolBooking, rewards: DailyReward[]): Promise<void> {
    await this.rpc("book_daily", {
      p_day: day,
      p_gross: booking.grossDay,
      p_seed_part: booking.seedDaily,
      p_pool: booking.pool,
      p_rewards: rewards.map((r) => ({ rank: r.rank, address: r.address, wins: r.wins, share_bps: r.shareBps, amount: r.amount.toString() })),
    });
  }

  async seed(): Promise<SeedBalance> {
    const [row] = await this.req<{ original: string; remaining: string }[]>("GET", "seed?select=original,remaining");
    return { original: big(row?.original), remaining: big(row?.remaining) };
  }

  async hasSeedDraw(day: string): Promise<boolean> {
    return (await this.req<unknown[]>("GET", `seed_draws?select=day&day=eq.${day}`)).length > 0;
  }

  async bookSeedDraw(day: string, draw: SeedDraw, sig: string | null): Promise<void> {
    await this.rpc("book_seed_draw", { p_day: day, p_win: draw.win, p_daily: draw.daily, p_shortfall: draw.shortfall, p_sig: sig });
  }

  async bookWin(_w: WinBooking): Promise<bigint> {
    throw new Error("wins are booked by the game server through record_match");
  }
}
