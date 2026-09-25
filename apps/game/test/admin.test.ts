/**
 * /admin: off without a password, gated by IP and basic auth, and its actions
 * write what the worker and the gate read (settings, players, payouts).
 */
import { loadGameEnv } from "@cockfight/shared/env";
import { describe, expect, it } from "vitest";
import { AdminService } from "../src/admin";

const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MATCH = "11111111-1111-4111-8111-111111111111";

function make(o: { password?: string; ips?: string } = {}) {
  const calls: { method: string; path: string; body: unknown; prefer: string | null }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = init?.headers as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path: decodeURIComponent(u.pathname.replace("/rest/v1/", "") + u.search), body: init?.body ? JSON.parse(String(init.body)) : undefined, prefer: headers.prefer ?? null });
    if (u.pathname.endsWith("/players") && init?.method === "PATCH") return Response.json([{ address: ALICE }]);
    if (u.pathname.endsWith("/payouts") && init?.method === "PATCH") return Response.json([{ id: MATCH }]);
    return Response.json([]);
  }) as typeof fetch;
  const env = loadGameEnv({
    GATE_MODE: "required",
    SUPABASE_URL: "http://db.test",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
    ADMIN_PASSWORD: o.password,
    ADMIN_ALLOWED_IPS: o.ips,
  });
  return { calls, admin: new AdminService({ env, fetch: f, webOrigin: "https://cockfightsol.fun" }) };
}

const basic = (pass: string) => new Headers({ authorization: `Basic ${Buffer.from(`sammy:${pass}`).toString("base64")}` });

describe("/admin access", () => {
  it("is off (404) without ADMIN_PASSWORD", () => {
    const { admin } = make();
    expect(admin.enabled).toBe(false);
    expect(admin.gate(basic("whatever-whatever"), "1.2.3.4")).toEqual({ status: 404, body: { error: "not found" } });
  });

  it("needs the password (401) and, when set, an allowlisted IP (403)", () => {
    const { admin } = make({ password: "correct-horse-battery", ips: "203.0.113.5, 203.0.113.6" });
    expect(admin.gate(new Headers(), "203.0.113.5")?.status).toBe(401);
    expect(admin.gate(basic("wrong-horse-battery"), "203.0.113.5")?.status).toBe(401);
    expect(admin.gate(basic("correct-horse-battery"), "203.0.113.5")).toBeNull();
    expect(admin.gate(basic("correct-horse-battery"), "203.0.113.6")).toBeNull();
    expect(admin.gate(basic("correct-horse-battery"), "203.0.113.7")?.status).toBe(403);
    expect(admin.gate(basic("correct-horse-battery"), null)?.status).toBe(403);
    const open = make({ password: "correct-horse-battery" });
    expect(open.admin.gate(basic("correct-horse-battery"), null)).toBeNull();
  });
});

describe("/admin actions", () => {
  it("sets and clears knobs and the pause switch in settings", async () => {
    const { admin, calls } = make({ password: "correct-horse-battery" });
    expect(await admin.setKnob({ key: "p_min_usd", value: "1.5" })).toEqual({ status: 200, body: { ok: true, key: "p_min_usd", value: 1.5 } });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "settings?on_conflict=key", body: { key: "p_min_usd", value: 1.5, updated_by: "admin" }, prefer: "resolution=merge-duplicates,return=minimal" });
    expect((await admin.setKnob({ key: "evil", value: 1 })).status).toBe(400);
    expect((await admin.setKnob({ key: "max_daily_usd", value: -1 })).status).toBe(400);
    await admin.clearKnob({ key: "p_min_usd" });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "settings?key=eq.p_min_usd" });
    await admin.pause({ paused: true, reason: "looking at something" });
    expect(calls.at(-1)?.body).toMatchObject({ key: "payouts_paused", value: { paused: true, reason: "looking at something" } });
    await admin.pause({ paused: false });
    expect(calls.at(-1)?.body).toMatchObject({ key: "payouts_paused", value: { paused: false, reason: null } });
  });

  it("tops the seed up through seed_topup, in raw units only", async () => {
    const { admin, calls } = make({ password: "correct-horse-battery" });
    expect((await admin.seedTopup({ amount: "1.5" })).status).toBe(400);
    expect((await admin.seedTopup({ amount: "0" })).status).toBe(400);
    expect((await admin.seedTopup({ amount: "1000000000" })).status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "rpc/seed_topup", body: { p_amount: "1000000000" } });
  });

  it("flags, clears, bans and unbans wallets", async () => {
    const { admin, calls } = make({ password: "correct-horse-battery" });
    expect((await admin.player({ address: "nope", action: "flag" })).status).toBe(400);
    expect((await admin.player({ address: ALICE, action: "delete" })).status).toBe(400);
    await admin.player({ address: ALICE, action: "flag" });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: `players?address=eq.${ALICE}`, body: { flagged: true } });
    await admin.player({ address: ALICE, action: "ban", hours: 48 });
    const until = Date.parse((calls.at(-1)?.body as { banned_until: string }).banned_until);
    expect(until - Date.now()).toBeGreaterThan(47 * 3_600_000);
    expect(until - Date.now()).toBeLessThan(49 * 3_600_000);
    await admin.player({ address: ALICE, action: "unban" });
    expect(calls.at(-1)?.body).toEqual({ banned_until: null });
  });

  it("clears or voids a flagged match: its held payout, its flag and its abuse events, together", async () => {
    const { admin, calls } = make({ password: "correct-horse-battery" });
    await admin.match({ id: MATCH, action: "clear" });
    const paths = calls.slice(-3).map((c) => [c.method, c.path.split("&")[0], c.body]);
    expect(paths).toEqual([
      ["PATCH", `payouts?idem_key=eq.win:${MATCH}`, { status: "pending", next_attempt_at: null, last_error: null }],
      ["PATCH", `matches?id=eq.${MATCH}`, { flag: null }],
      ["PATCH", `abuse_events?match_id=eq.${MATCH}`, expect.objectContaining({ resolved_by: "admin" })],
    ]);
    await admin.match({ id: MATCH, action: "void" });
    expect(calls.at(-3)?.body).toMatchObject({ status: "voided" });
    expect(calls.at(-2)?.body).toEqual({ flag: "voided" });
    expect((await admin.match({ id: "x", action: "void" })).status).toBe(400);
    await admin.payout({ id: MATCH, action: "retry" });
    expect(calls.at(-1)).toMatchObject({ path: `payouts?id=eq.${MATCH}&status=in.(deferred,failed,pending)`, body: { status: "pending", tx_sig: null } });
  });
});
