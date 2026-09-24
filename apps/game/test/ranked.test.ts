/**
 * Ranked mode (GATE_MODE=required) with the chain, Turnstile and Supabase
 * faked at the fetch boundary: the gate endpoint, queue tokens, the
 * match-start re-check, and what gets written to the database.
 */
import { matchMaker } from "@colyseus/core";
import { ColyseusTestServer } from "@colyseus/testing";
import { B, Phase } from "@cockfight/sim";
import { loadGameEnv } from "@cockfight/shared/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FightRoom } from "../src/rooms/FightRoom";
import { listen, makeServer } from "../src/server";
import { Bot, freePort, queueUp, until } from "./helpers";

const MINT = "So11111111111111111111111111111111111111112";
// Wallet keys on the ed25519 curve.
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const CAROL = "CKaKtYvz6dKPyMvYq9Rh3UBrnNqYZAyd7iF4hJtjUvks";
const ORIGIN = "http://localhost:3000";

/** Raw token balances (6 decimals, $1 each at the fixed devnet price). */
const balances = new Map<string, bigint>();
const rpcCalls: string[] = [];
const dbCalls: { path: string; body: Record<string, unknown> }[] = [];

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://challenges.cloudflare.com/")) {
    const token = (init?.body as URLSearchParams).get("response");
    return Response.json({ success: token === "human" });
  }
  if (url.startsWith("http://rpc.test")) {
    const body = JSON.parse(String(init?.body)) as { params: [string] };
    rpcCalls.push(body.params[0]);
    const raw = balances.get(body.params[0]) ?? 0n;
    const value = raw === 0n ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount: raw.toString(), decimals: 6 } } } } } }];
    return Response.json({ jsonrpc: "2.0", id: 1, result: { value } });
  }
  if (url.startsWith("http://db.test/rest/v1/")) {
    const path = url.slice("http://db.test/rest/v1/".length).split("?")[0] as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    dbCalls.push({ path, body });
    if (path === "rpc/record_gate") return Response.json(body.p_tier ? 1000 : null);
    if (path === "rpc/record_match") {
      return Response.json([
        { address: body.p_p1, elo_before: 1000, elo_after: body.p_winner === body.p_p1 ? 1016 : 984 },
        { address: body.p_p2, elo_before: 1000, elo_after: body.p_winner === body.p_p2 ? 1016 : 984 },
      ]);
    }
    if (path === "players") return Response.json([]);
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
  });
  const server = makeServer({ env, gracefullyShutdown: false, context: { fetch: fakeFetch } });
  await listen(server, port, "127.0.0.1");
  colyseus = new ColyseusTestServer(server);
});

afterAll(async () => {
  await colyseus?.shutdown();
});

async function gate(address: string, turnstile = "human") {
  const res = await fetch(`${base}/gate`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: ORIGIN, "fly-client-ip": `10.0.0.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ address, turnstile }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /gate", () => {
  it("blocks a wallet at $29 and admits one at $31 with a queue token (spec acceptance)", async () => {
    balances.set(ALICE, 31_000_000n);
    balances.set(CAROL, 29_000_000n);
    const low = await gate(CAROL);
    expect(low).toEqual({ status: 200, body: { ok: false, usd: 29, shortUsd: 1, gateUsd: 30 } });
    const ok = await gate(ALICE);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, usd: 31, tier: "rust", elo: 1000, token: expect.stringMatching(/^ey/) });
    // Both checks were audited in Supabase with the fixed devnet price source.
    const audits = dbCalls.filter((c) => c.path === "rpc/record_gate").map((c) => [c.body.p_address, c.body.p_tier, c.body.p_source]);
    expect(audits).toEqual(expect.arrayContaining([[CAROL, null, "fixed"], [ALICE, "rust", "fixed"]]));
  });

  it("refuses bad addresses and failed bot checks before touching the chain", async () => {
    const before = rpcCalls.length;
    expect((await gate("nope")).status).toBe(400);
    expect((await gate(ALICE, "robot")).status).toBe(403);
    expect(rpcCalls.length).toBe(before);
  });

  it("the open-mode name path and ad hoc fight rooms are closed", async () => {
    await expect(colyseus.sdk.joinOrCreate("queue", { name: "Freeloader" })).rejects.toThrow(/token/);
    await expect(colyseus.sdk.joinOrCreate("queue", { token: "e30.e30.bad" })).rejects.toThrow(/token/);
    await expect(colyseus.sdk.create("fight", { name: "Sneaky" })).rejects.toThrow();
  });
});

describe("ranked queue", () => {
  it("re-checks both balances before the match: a player now under the gate is told why, the other keeps queueing", async () => {
    balances.set(ALICE, 40_000_000n);
    balances.set(BOB, 40_000_000n);
    const a = await gate(ALICE);
    const b = await gate(BOB);
    balances.set(BOB, 20_000_000n); // Bob sold down after the gate
    const qa = await queueUp(colyseus.sdk, { token: a.body.token, rtt: 30 });
    const qb = await queueUp(colyseus.sdk, { token: b.body.token, rtt: 30 });
    const kicked = await qb.matched.then(
      () => null,
      (e: { kicked?: unknown }) => e.kicked,
    );
    expect(kicked).toMatchObject({ reason: "gate", usd: 20, shortUsd: 10 });
    // Alice is still waiting; a new opponent gets her a match.
    balances.set(BOB, 45_000_000n);
    const b2 = await gate(BOB);
    const qb2 = await queueUp(colyseus.sdk, { token: b2.body.token, rtt: 30 });
    const [ma, mb] = await Promise.all([qa.matched, qb2.matched]);
    expect(ma.matchId).toBe(mb.matchId);
    await Promise.all([qa.queue.leave(), qb2.queue.leave()]);

    // Play it out: P2 quits, P1 wins by forfeit; the result goes to record_match.
    const room = matchMaker.getLocalRoomById(ma.matchId) as unknown as FightRoom;
    expect(room.state.ranked).toBe(true);
    const bots = await Promise.all([Bot.join(colyseus.sdk, ma), Bot.join(colyseus.sdk, mb)]);
    bots.sort((x, y) => x.pred.side - y.pred.side);
    const [p1, p2] = bots as [Bot, Bot];
    p1.mask = (s) => (s.phase === Phase.fighting ? B.R : 0);
    p1.ready();
    p2.ready();
    await until(() => room.status === "live", 5000, "live");
    await until(() => room.match.tick > 30, 5000, "ticks");
    p2.stop();
    await p2.room.leave();
    await until(() => room.state.recorded, 5000, "recorded");
    const rec = dbCalls.find((c) => c.path === "rpc/record_match")!.body;
    const p1Address = room.state.seats[0]!.name.endsWith(ALICE.slice(-4)) ? ALICE : BOB;
    expect(rec).toMatchObject({
      p_id: ma.matchId,
      p_region: "local",
      p_p1: p1Address,
      p_winner: p1Address,
      p_reason: "forfeit",
      p_rounds: [{ n: 1, winner: 0, reason: "forfeit" }],
      p_result_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.parse(String(rec.p_input_log))).toMatchObject({ v: 1, matchId: ma.matchId });
    expect(room.state.seats.map((s) => s.eloDelta)).toEqual([16, -16]);
    expect(room.state.seats.map((s) => s.name)).toEqual(expect.arrayContaining([`anon-${ALICE.slice(-4)}`, `anon-${BOB.slice(-4)}`]));
    p1.stop();
    await p1.room.leave();
  }, 30_000);
});
