/**
 * SupabaseLedger against a fake Data API: the exact requests it makes, and
 * the status guards that make a double send impossible.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, computePoolState } from "@cockfight/economy";
import { SupabaseLedger } from "../src/ledger";
import { applySettings, paramsFromEnv } from "../src/settings";
import { TelegramAlerts } from "../src/telegram";
import { loadWorkerEnv } from "@cockfight/shared/env";

interface Call {
  method: string;
  path: string;
  body: unknown;
  prefer: string | null;
}

class FakeApi {
  calls: Call[] = [];
  /** Responses by "METHOD path-prefix". */
  replies = new Map<string, unknown>();
  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/rest/v1/", "") + u.search;
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    expect(headers.apikey).toBe("sb_secret_test");
    expect(headers.authorization).toBeUndefined();
    this.calls.push({ method, path: decodeURIComponent(path), body: init?.body ? JSON.parse(String(init.body)) : undefined, prefer: headers.prefer ?? null });
    for (const [k, v] of this.replies) {
      const [m, p] = k.split(" ", 2);
      if (m === method && decodeURIComponent(path).startsWith(p as string)) return typeof v === "function" ? (v as () => Response)() : Response.json(v);
    }
    return new Response(null, { status: 204 });
  };
}

const price = { usd: 0.005, decimals: 6 };

describe("SupabaseLedger", () => {
  const make = () => {
    const api = new FakeApi();
    return { api, ledger: new SupabaseLedger({ url: "https://x.supabase.co/", serviceKey: "sb_secret_test", fetch: api.fetch }) };
  };

  it("reads the window from treasury_window and writes the pool state and a minute snapshot", async () => {
    const { api, ledger } = make();
    api.replies.set("POST rpc/treasury_window", [{
      gross_24h: "1000", gross_today: "500", player_share_24h: "700", weighted_24h_milli: "2600000", allowance: "650", sent_last_hour: "10",
      sent_today: "20", outstanding: "30", seed_win: "5", seed_daily: "2", seed_total: "7",
    }]);
    const now = Date.parse("2026-10-01T12:34:56.789Z");
    const w = await ledger.window(now);
    expect(w).toEqual({
      gross24h: 1000n, grossToday: 500n, playerShare24h: 700n, weighted24hMilli: 2_600_000n, allowance: 650n, sentLastHour: 10n, sentToday: 20n, outstanding: 30n,
      seedToday: { win: 5n, daily: 2n, total: 7n, shortfall: 0n },
    });
    expect(api.calls[0]).toMatchObject({ method: "POST", path: "rpc/treasury_window", body: { p_now: "2026-10-01T12:34:56.789Z" } });

    const state = computePoolState({ gross24h: 1000n, grossToday: 500n, seedWinTopUp: 5n, seedDailyTopUp: 2n, weighted24hMilli: 2_600_000n, price }, DEFAULT_PARAMS);
    await ledger.writePoolState(state, now);
    const upsert = api.calls.find((c) => c.path.startsWith("pool_state"));
    expect(upsert).toMatchObject({ method: "POST", path: "pool_state?on_conflict=id", prefer: "resolution=merge-duplicates,return=minimal" });
    expect(upsert?.body).toMatchObject({ id: true, computed_at: "2026-10-01T12:34:56.789Z", price_usd: 0.005, decimals: 6, win_rust: state.perWin.rust.toString(), allowance: "650", outstanding: "30" });
    expect((upsert?.body as { detail: { min: { rust: string } } }).detail.min.rust).toBe(state.perWinMin.rust.toString());
    const snap = api.calls.find((c) => c.path.startsWith("pool_snapshots"));
    expect(snap?.body).toMatchObject({ at: "2026-10-01T12:34:00.000Z", win_rust: state.perWin.rust.toString() });
  });

  it("selects due payouts (pending, or deferred and due) oldest first, and maps rows", async () => {
    const { api, ledger } = make();
    api.replies.set("GET payouts?select=*&or=", [
      { id: "a", kind: "win", idem_key: "win:m", to_address: "So11", amount: "1450000000", status: "pending", tx_sig: null, attempts: 0, created_at: "2026-10-01T00:00:00Z", sent_at: null },
    ]);
    const rows = await ledger.duePayouts(Date.parse("2026-10-01T01:00:00Z"), 25);
    expect(rows).toEqual([{ id: "a", kind: "win", idemKey: "win:m", to: "So11", amount: 1_450_000_000n, status: "pending", sig: null, attempts: 0, createdAt: Date.parse("2026-10-01T00:00:00Z"), sentAt: null }]);
    expect(api.calls[0]?.path).toBe("payouts?select=*&or=(status.eq.pending,and(status.eq.deferred,or(next_attempt_at.is.null,next_attempt_at.lte.2026-10-01T01:00:00.000Z)))&order=created_at.asc&limit=25");
  });

  it("guards every status change on the current status, so a row can't be sent twice", async () => {
    const { api, ledger } = make();
    api.replies.set("PATCH payouts?id=eq.a&status=in.(pending,deferred)", [{ id: "a" }]);
    await ledger.markSent("a", "S".repeat(88), Date.parse("2026-10-01T00:00:10Z"));
    expect(api.calls[0]).toMatchObject({
      method: "PATCH",
      path: "payouts?id=eq.a&status=in.(pending,deferred)",
      body: { status: "sent", tx_sig: "S".repeat(88), sent_at: "2026-10-01T00:00:10.000Z", last_error: null },
      prefer: "return=representation",
    });
    // Already sent: the guard matches no row, and the ledger says so instead of overwriting the signature.
    api.replies.set("PATCH payouts?id=eq.a&status=in.(pending,deferred)", []);
    await expect(ledger.markSent("a", "T".repeat(88), 0)).rejects.toThrow(/no row updated/);
    api.replies.set("PATCH payouts?id=eq.a&status=in.(sent)", [{ id: "a" }]);
    await ledger.markPaid("a", Date.parse("2026-10-01T00:00:20Z"));
    expect(api.calls.at(-1)?.body).toEqual({ status: "paid", paid_at: "2026-10-01T00:00:20.000Z" });
    api.replies.set("GET payouts?select=attempts&id=eq.a", [{ attempts: 2 }]);
    await ledger.markRetry("a", "expired");
    expect(api.calls.at(-1)?.body).toEqual({ status: "pending", tx_sig: null, sent_at: null, attempts: 3, last_error: "expired" });
    api.replies.set("PATCH payouts?id=eq.b&status=in.(pending,deferred)", [{ id: "b" }]);
    await ledger.markDeferred("b", "budget", Date.parse("2026-10-01T00:01:00Z"));
    expect(api.calls.at(-1)?.body).toEqual({ status: "deferred", last_error: "budget", next_attempt_at: "2026-10-01T00:01:00.000Z" });
  });

  it("reads and writes the pause switch in settings, and books the daily and seed through the SQL functions", async () => {
    const { api, ledger } = make();
    expect(await ledger.pause()).toEqual({ paused: false, reason: null });
    api.replies.set("GET settings?select=value&key=eq.payouts_paused", [{ value: { paused: true, reason: "cap" } }]);
    expect(await ledger.pause()).toEqual({ paused: true, reason: "cap" });
    await ledger.setPause(false, null);
    expect(api.calls.at(-1)).toMatchObject({ method: "POST", path: "settings?on_conflict=key", body: { key: "payouts_paused", value: { paused: false, reason: null } } });

    await ledger.bookDaily("2026-10-01", { grossDay: 5000n, seedDaily: 40n, pool: 1040n }, [{ rank: 1, address: "So11", wins: 9, shareBps: 2500, amount: 260n }]);
    expect(api.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "rpc/book_daily",
      body: { p_day: "2026-10-01", p_gross: "5000", p_seed_part: "40", p_pool: "1040", p_rewards: [{ rank: 1, address: "So11", wins: 9, share_bps: 2500, amount: "260" }] },
    });
    await ledger.bookSeedDraw("2026-10-02", { win: 60n, daily: 40n, total: 100n, shortfall: 500n }, "D".repeat(88));
    expect(api.calls.at(-1)?.body).toEqual({ p_day: "2026-10-02", p_win: "60", p_daily: "40", p_shortfall: "500", p_sig: "D".repeat(88) });
    api.replies.set("GET fee_claims?select=gross&at=gte.2026-10-01T00:00:00Z&at=lt.2026-10-02T00:00:00.000Z", [{ gross: "10" }, { gross: "5" }]);
    api.replies.set("GET seed_draws?select=daily&day=eq.2026-10-01", [{ daily: "7" }]);
    expect(await ledger.dailyPoolInputs("2026-10-01")).toEqual({ grossDay: 15n, seedDaily: 7n });
    await expect(ledger.bookWin({ matchId: "m", endedAt: 0, winner: "a", loser: "b", tier: "rust", qualityBps: 10000 })).rejects.toThrow(/record_match/);
  });

  it("surfaces HTTP errors with the status and body", async () => {
    const { api, ledger } = make();
    api.replies.set("POST rpc/treasury_window", () => new Response('{"message":"permission denied"}', { status: 401 }));
    await expect(ledger.window(0)).rejects.toThrow(/treasury_window: HTTP 401 .*permission denied/);
  });
});

describe("settings", () => {
  it("builds params from env and lets /admin override the numeric knobs, rejecting an invalid set", () => {
    const env = loadWorkerEnv({ TIER_WEIGHTS: "1,3,8", PAYOUT_P_MIN_USD: "1", GUARANTEED_WIN_BUDGET_USD: "500", MAX_PAYOUT_USD: "700" });
    const base = paramsFromEnv(env);
    expect(base).toMatchObject({ tierWeightsMilli: { rust: 1000, chrome: 3000, gold: 8000 }, pMinUsd: 1, gWinUsd: 500, maxPayoutUsd: 700, wFloorMilli: 200_000 });
    const merged = applySettings(base, { p_min_usd: 2, g_daily_usd: "150", w_floor: 300, junk: 1, max_hourly_usd: -5 }, () => {});
    expect(merged).toMatchObject({ pMinUsd: 2, gDailyUsd: 150, wFloorMilli: 300_000, maxHourlyUsd: 3000 });
    // p_max below p_min can't be applied: the env params stand.
    expect(applySettings(base, { p_max_usd: 0.5 }, () => {})).toBe(base);
    expect(() => paramsFromEnv(loadWorkerEnv({ MAX_PAYOUT_USD: "10" }))).toThrow(/Gold cap/);
    expect(() => loadWorkerEnv({ TIER_WEIGHTS: "1,2" })).toThrow(/TIER_WEIGHTS/);
  });
});

describe("TelegramAlerts", () => {
  it("posts to the bot API, once per identical message per ten minutes, and never throws", async () => {
    let t = 0;
    const posts: { url: string; body: { chat_id: string; text: string } }[] = [];
    const alerts = new TelegramAlerts({
      token: "123:abc",
      chatId: "42",
      now: () => t,
      log: () => {},
      fetch: async (url, init) => {
        posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return posts.length === 3 ? new Response("nope", { status: 500 }) : Response.json({ ok: true });
      },
    });
    await alerts.alert("pause", "payouts paused: hourly cap");
    await alerts.alert("pause", "payouts paused: hourly cap");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ url: "https://api.telegram.org/bot123:abc/sendMessage", body: { chat_id: "42", text: "⏸ COCKFIGHT pause: payouts paused: hourly cap", disable_web_page_preview: true } });
    t = 11 * 60_000;
    await alerts.alert("pause", "payouts paused: hourly cap");
    await alerts.alert("info", "x");
    expect(posts).toHaveLength(3);
    expect(alerts.failures).toEqual(["HTTP 500"]);
    const quiet = new TelegramAlerts({ log: () => {} });
    expect(quiet.enabled).toBe(false);
    await quiet.alert("info", "logged only");
  });
});
