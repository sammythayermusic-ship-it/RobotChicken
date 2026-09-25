/**
 * Phase 3 on the game server, with the chain, Turnstile and Supabase faked
 * at the fetch boundary: tier and identity pairing, the rematch cooldown,
 * the queue's minimum, the payout booked at match end and followed to its
 * transaction, usernames by signed message, and a banned wallet at the gate.
 */
import { matchMaker } from "@colyseus/core";
import { ColyseusTestServer } from "@colyseus/testing";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { B, Phase } from "@cockfight/sim";
import { loadGameEnv } from "@cockfight/shared/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbuseIds, ipNetwork, isPrivate } from "../src/abuse";
import type { FightRoom } from "../src/rooms/FightRoom";
import { ANY_TIER_AFTER_MS, identityAllows, pairKey, tierAllows, type QueueRoom } from "../src/rooms/QueueRoom";
import { listen, makeServer } from "../src/server";
import { claimMessage, verifySignature } from "../src/usernames";
import { Bot, freePort, queueUp, sleep, until, type Matched } from "./helpers";

const MINT = "So11111111111111111111111111111111111111112";
const seedOf = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + n) & 0xff);
const keys = [1, 2, 3, 4].map((n) => ({ seed: seedOf(n), address: bs58.encode(ed25519.getPublicKey(seedOf(n))) }));
const [ALICE, BOB, CAROL, DAVE] = keys.map((k) => k.address) as [string, string, string, string];
const ORIGIN = "http://localhost:3000";

const balances = new Map<string, bigint>();
const players = new Map<string, { username: string | null; banned_until: string | null }>();
const usernames = new Map<string, string>();
const dbCalls: { path: string; body: Record<string, unknown> }[] = [];
/** The payouts table as the worker would move it along. */
const payouts = new Map<string, { amount: string; usd: number; status: string; tx_sig: string | null }>();
const bookAmount = "1450000000";

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://challenges.cloudflare.com/")) return Response.json({ success: true });
  if (url.startsWith("http://rpc.test")) {
    const body = JSON.parse(String(init?.body)) as { params: [string] };
    const raw = balances.get(body.params[0]) ?? 0n;
    const value = raw === 0n ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount: raw.toString(), decimals: 6 } } } } } }];
    return Response.json({ jsonrpc: "2.0", id: 1, result: { value } });
  }
  if (url.startsWith("http://db.test/rest/v1/")) {
    const u = new URL(url);
    const path = u.pathname.slice("/rest/v1/".length);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    dbCalls.push({ path, body });
    if (path === "rpc/record_gate") return Response.json(body.p_tier ? 1000 : null);
    if (path === "rpc/record_match") {
      const winner = body.p_winner as string | null;
      const paid = winner && body.p_tier_paid && body.p_quality_bps;
      const amount = paid ? bookAmount : "0";
      const reason = winner === null ? "draw" : !body.p_tier_paid ? "open" : !body.p_quality_bps ? "quality" : "paid";
      if (paid) payouts.set(`win:${body.p_id}`, { amount, usd: 7.25, status: "pending", tx_sig: null });
      return Response.json(
        [body.p_p1, body.p_p2].map((a) => ({ address: a, elo_before: 1000, elo_after: winner === a ? 1016 : 984, payout: winner === a ? amount : "0", payout_reason: reason })),
      );
    }
    if (path === "rpc/claim_username") {
      const name = String(body.p_username);
      for (const [addr, n] of usernames) if (addr !== body.p_address && n.toLowerCase() === name.toLowerCase()) return new Response('{"code":"23505"}', { status: 409 });
      usernames.set(String(body.p_address), name);
      return new Response(null, { status: 204 });
    }
    if (path === "players") {
      const addr = u.searchParams.get("address")?.replace("eq.", "") ?? "";
      const p = players.get(addr);
      return Response.json(p ? [{ username: usernames.get(addr) ?? p.username, banned_until: p.banned_until }] : []);
    }
    if (path === "payouts") {
      const key = u.searchParams.get("idem_key")?.replace("eq.", "") ?? "";
      const p = payouts.get(key);
      return Response.json(p ? [p] : []);
    }
  }
  return new Response("unexpected fetch " + url, { status: 500 });
}) as typeof fetch;

let colyseus: ColyseusTestServer;
let base: string;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = loadGameEnv({
    GATE_MODE: "required",
    NEXT_PUBLIC_COCK_MINT: MINT,
    SOLANA_RPC_URL: "http://rpc.test",
    GATE_FIXED_PRICE_USD: "1",
    QUEUE_JWT_SECRET: "x".repeat(40),
    SUPABASE_URL: "http://db.test",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
    QUEUE_MIN_PLAYERS: "3",
    REMATCH_COOLDOWN_S: "2",
  });
  const server = makeServer({ env, gracefullyShutdown: false, context: { fetch: fakeFetch } });
  await listen(server, port, "127.0.0.1");
  colyseus = new ColyseusTestServer(server);
});

afterAll(async () => {
  await colyseus?.shutdown();
});

async function post(path: string, body: unknown, ip = "1.2.3.4") {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: ORIGIN, "fly-client-ip": ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const gate = (address: string) => post("/gate", { address, turnstile: "human" });

/** Play a match out: P1 attacks, P2 quits after 30 s (so the quality multiplier stays 1). P1 stays on the result screen. */
async function playOut(ma: Matched, mb: Matched): Promise<{ room: FightRoom; p1: Bot }> {
  const room = matchMaker.getLocalRoomById(ma.matchId) as unknown as FightRoom;
  const bots = await Promise.all([Bot.join(colyseus.sdk, ma), Bot.join(colyseus.sdk, mb)]);
  bots.sort((x, y) => x.pred.side - y.pred.side);
  const [p1, p2] = bots as [Bot, Bot];
  p1.mask = (s) => (s.phase === Phase.fighting ? B.R | B.S : 0);
  p1.ready();
  p2.ready();
  await until(() => room.status === "live", 5000, "live");
  await until(() => room.match.tick > 40 * 60, 60_000, "forty seconds of play");
  // A forfeit after 30 s keeps the quality multiplier at 1.
  p2.stop();
  await p2.room.leave();
  await until(() => room.state.recorded, 5000, "recorded");
  p1.stop();
  return { room, p1 };
}

describe("pure rules", () => {
  it("hashes IPs by /24 (v4) or /64 (v6), never private ones, and fingerprints only when well-formed", () => {
    const ids = new AbuseIds("salt");
    expect(ipNetwork("203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipNetwork("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipNetwork("nope")).toBeNull();
    expect(ids.ip("203.0.113.77")).toBe(ids.ip("203.0.113.9"));
    expect(ids.ip("203.0.113.77")).not.toBe(ids.ip("203.0.114.77"));
    expect(ids.ip("203.0.113.77")).toMatch(/^[0-9a-f]{32}$/);
    for (const p of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "::1", "fd00::1"]) {
      expect(isPrivate(p), p).toBe(true);
      expect(ids.ip(p), p).toBeNull();
    }
    expect(isPrivate("172.32.0.1")).toBe(false);
    expect(new AbuseIds("other").ip("203.0.113.77")).not.toBe(ids.ip("203.0.113.77"));
    expect(ids.fingerprint("abcdefghijklmnop")).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.fingerprint("short")).toBeNull();
    expect(ids.fingerprint(42)).toBeNull();
  });

  it("pairs by identity and tier", () => {
    const p = (id: string, tier: "rust" | "chrome" | "gold" | "diamond", ipHash: string | null, fp: string | null) => ({ id, address: id, name: id, tier, ipHash, fp });
    expect(identityAllows(p("a", "rust", "ip1", "fp1"), p("b", "rust", "ip2", "fp2"))).toBe(true);
    expect(identityAllows(p("a", "rust", "ip1", "fp1"), p("b", "rust", "ip1", "fp2"))).toBe(false);
    expect(identityAllows(p("a", "rust", "ip1", "fp1"), p("b", "rust", "ip2", "fp1"))).toBe(false);
    expect(identityAllows(p("a", "rust", null, null), p("b", "rust", null, null))).toBe(true);
    expect(identityAllows(p("a", "rust", null, null), p("a", "rust", null, null))).toBe(false);
    const t0 = 1_000_000;
    expect(tierAllows({ player: p("a", "gold", null, null), joinedAt: t0 }, { player: p("b", "diamond", null, null), joinedAt: t0 }, t0 + 1000)).toBe(true);
    expect(tierAllows({ player: p("a", "gold", null, null), joinedAt: t0 }, { player: p("b", "rust", null, null), joinedAt: t0 }, t0 + 1000)).toBe(false);
    expect(tierAllows({ player: p("a", "gold", null, null), joinedAt: t0 }, { player: p("b", "rust", null, null), joinedAt: t0 }, t0 + ANY_TIER_AFTER_MS)).toBe(true);
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
  });

  it("verifies a wallet's signature over the claim message", () => {
    const k = keys[0]!;
    const msg = claimMessage("123.abc", "Rooster");
    const sig = ed25519.sign(new TextEncoder().encode(msg), k.seed);
    expect(verifySignature(k.address, msg, bs58.encode(sig))).toBe(true);
    expect(verifySignature(k.address, msg, Buffer.from(sig).toString("base64"))).toBe(true);
    expect(verifySignature(k.address, claimMessage("123.abc", "Hen"), bs58.encode(sig))).toBe(false);
    expect(verifySignature(keys[1]!.address, msg, bs58.encode(sig))).toBe(false);
    expect(verifySignature(k.address, msg, "garbage")).toBe(false);
  });
});

describe("ranked queue, Phase 3", () => {
  it("waits for QUEUE_MIN_PLAYERS, pairs tiers with their own first, never two tickets with one fingerprint, and books the win", async () => {
    balances.set(ALICE, 1_200_000_000n); // gold
    balances.set(BOB, 1_100_000_000n); // gold
    balances.set(CAROL, 40_000_000n); // rust
    balances.set(DAVE, 40_000_000n); // rust
    const [a, b, c] = await Promise.all([gate(ALICE), gate(BOB), gate(CAROL)]);
    expect(a.body.tier).toBe("gold");
    const qa = await queueUp(colyseus.sdk, { token: a.body.token, rtt: 30, fp: "fingerprint-alice-1" });
    const qb = await queueUp(colyseus.sdk, { token: b.body.token, rtt: 30, fp: "fingerprint-alice-1" });
    // Two tickets, and the same browser: nothing happens.
    await sleep(1200);
    let matched = false;
    void qa.matched.then(() => (matched = true));
    expect(matched).toBe(false);
    await qb.queue.leave();
    const qb2 = await queueUp(colyseus.sdk, { token: b.body.token, rtt: 30, fp: "fingerprint-bob-000" });
    await sleep(1200);
    expect(matched).toBe(false); // still under the minimum of 3
    const qc = await queueUp(colyseus.sdk, { token: c.body.token, rtt: 30, fp: "fingerprint-carol-0" });
    const [ma, mb] = await Promise.all([qa.matched, qb2.matched]);
    expect(ma.matchId).toBe(mb.matchId);
    expect(ma.opponent.tier).toBe("gold"); // the two golds, not the rust who arrived later
    let carolMatched = false;
    void qc.matched.then(() => (carolMatched = true));
    await Promise.all([qa.queue.leave(), qb2.queue.leave()]);

    const { room, p1 } = await playOut(ma, mb);
    const rec = dbCalls.filter((x) => x.path === "rpc/record_match").at(-1)!.body;
    expect(rec).toMatchObject({ p_id: ma.matchId, p_tier_paid: "gold", p_quality_bps: 10000, p_p1_ip_hash: null, p_p2_ip_hash: null });
    expect([rec.p_p1_fp, rec.p_p2_fp].every((f) => typeof f === "string" && /^[0-9a-f]{32}$/.test(f as string))).toBe(true);
    expect(room.state.payoutTier).toBe("gold");
    expect(room.state.payout).toBe("1450000000");
    expect(room.state.payoutReason).toBe("paid");
    // The worker pays; the result screen picks up the signature.
    payouts.set(`win:${ma.matchId}`, { amount: "1450000000", usd: 7.25, status: "sent", tx_sig: "S".repeat(88) });
    await until(() => room.state.payoutSig !== "", 8000, "payout signature");
    expect(room.state.payoutSig).toBe("S".repeat(88));
    expect(room.state.payoutUsd).toBeCloseTo(7.25, 2);
    await p1.room.leave();

    // Carol was left waiting: she is below the queue minimum on her own.
    expect(carolMatched).toBe(false);
    await qc.queue.leave();
  }, 90_000);

  it("won't rematch the same two wallets inside the cooldown", async () => {
    const [a, b, c] = await Promise.all([gate(ALICE), gate(BOB), gate(CAROL)]);
    // The first test's match started a while ago: put the pair back on cooldown as if it had just started.
    const [listing] = await matchMaker.query({ name: "queue" });
    const queue = matchMaker.getLocalRoomById(listing!.roomId) as unknown as QueueRoom;
    expect(queue.recentPairs.has(pairKey(ALICE, BOB))).toBe(true);
    queue.recentPairs.set(pairKey(ALICE, BOB), Date.now());
    const qa = await queueUp(colyseus.sdk, { token: a.body.token, rtt: 30, fp: "fingerprint-alice-1" });
    const qb = await queueUp(colyseus.sdk, { token: b.body.token, rtt: 30, fp: "fingerprint-bob-000" });
    const qc = await queueUp(colyseus.sdk, { token: c.body.token, rtt: 30, fp: "fingerprint-carol-0" });
    let matched = false;
    void Promise.race([qa.matched, qb.matched]).then(() => (matched = true));
    await sleep(1200);
    expect(matched).toBe(false); // Alice and Bob just played; Carol is another tier
    // The cooldown (2 s here) passes: the golds pair again.
    const [ma, mb] = await Promise.all([qa.matched, qb.matched]);
    expect(ma.matchId).toBe(mb.matchId);
    await Promise.all([qa.queue.leave(), qb.queue.leave(), qc.queue.leave()]);
    await (matchMaker.getLocalRoomById(ma.matchId) as unknown as FightRoom).disconnect();
  }, 30_000);
});

describe("usernames", () => {
  it("issues a nonce and accepts a claim signed by the wallet; refuses bad signatures, stale nonces and taken names", async () => {
    const k = keys[2]!;
    players.set(CAROL, { username: null, banned_until: null });
    const nonce = await post("/username/nonce", { address: CAROL });
    expect(nonce.status).toBe(200);
    expect(nonce.body).toMatchObject({ ok: true, nonce: expect.stringMatching(/^\d+\./), messageTemplate: expect.stringContaining("cockfight:claim:") });
    const sign = (name: string, n = nonce.body.nonce as string) => bs58.encode(ed25519.sign(new TextEncoder().encode(claimMessage(n, name)), k.seed));
    expect((await post("/username", { address: CAROL, name: "Carol_1", nonce: nonce.body.nonce, signature: sign("Other") })).status).toBe(403);
    expect((await post("/username", { address: CAROL, name: "no way", nonce: nonce.body.nonce, signature: sign("no way") })).status).toBe(400);
    expect((await post("/username", { address: CAROL, name: "Carol_1", nonce: "1.bad", signature: sign("Carol_1", "1.bad") })).status).toBe(401);
    const ok = await post("/username", { address: CAROL, name: "Carol_1", nonce: nonce.body.nonce, signature: sign("Carol_1") });
    expect(ok).toEqual({ status: 200, body: { ok: true, address: CAROL, name: "Carol_1" } });
    expect(dbCalls.filter((c) => c.path === "rpc/claim_username").at(-1)?.body).toEqual({ p_address: CAROL, p_username: "Carol_1", p_sig: sign("Carol_1") });
    // Dave wants the same name, differently cased.
    const kd = keys[3]!;
    const nd = await post("/username/nonce", { address: DAVE });
    const sigD = bs58.encode(ed25519.sign(new TextEncoder().encode(claimMessage(nd.body.nonce as string, "carol_1")), kd.seed));
    expect((await post("/username", { address: DAVE, name: "carol_1", nonce: nd.body.nonce, signature: sigD })).status).toBe(409);
    // The gate now hands out the name with the token, and the queue shows it.
    const g = await gate(CAROL);
    expect(g.body).toMatchObject({ ok: true, name: "Carol_1" });
  });
});

describe("/admin", () => {
  it("is not there without ADMIN_PASSWORD", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(404);
    expect((await fetch(`${base}/admin/api/state`)).status).toBe(404);
  });
});

describe("bans", () => {
  it("a banned wallet is refused at the gate until the ban ends", async () => {
    balances.set(DAVE, 40_000_000n);
    players.set(DAVE, { username: null, banned_until: new Date(Date.now() + 3600_000).toISOString() });
    const banned = await gate(DAVE);
    expect(banned.status).toBe(403);
    expect(banned.body).toMatchObject({ error: "banned" });
    players.set(DAVE, { username: null, banned_until: new Date(Date.now() - 1000).toISOString() });
    expect((await gate(DAVE)).body).toMatchObject({ ok: true });
  });
});
