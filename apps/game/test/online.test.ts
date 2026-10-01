/**
 * Open-mode online flow end to end through real WebSockets: queue → matched →
 * fight room → both ready → the sim runs; clients predict and converge; a
 * drop pauses and forfeits after the 10 s grace; the match is recorded and
 * replays to its exact final state.
 */
import { matchMaker } from "@colyseus/core";
import { ColyseusTestServer } from "@colyseus/testing";
import { FRAMES_EVERY, decodeReplayLog, resultHash, type ServerMatch } from "@cockfight/net";
import { B, Phase, RULES, Reason, runReplay, stateHash } from "@cockfight/sim";
import { loadGameEnv } from "@cockfight/shared/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext } from "../src/context";
import { FightRoom } from "../src/rooms/FightRoom";
import { listen, makeServer } from "../src/server";
import { Bot, freePort, queueUp, sleep, until } from "./helpers";

/**
 * Frames go out every FRAMES_EVERY ticks, so a client's confirmed state can
 * trail the server by part of a batch (and on a busy machine a few ticks in
 * flight). Check it against the server's own
 * log replayed to the client's tick.
 */
function expectConfirmedMatches(server: ServerMatch, c: Parameters<typeof stateHash>[0]): void {
  expect(c.tick).toBeLessThanOrEqual(server.tick);
  // A partial batch, plus a few ticks still in flight on a loaded test machine.
  expect(c.tick).toBeGreaterThan(server.tick - FRAMES_EVERY - 6);
  const at = runReplay(server.toReplay(), RULES, { every: 1 }).cps.find(([t]) => t === c.tick)?.[1];
  expect(stateHash(c)).toBe(c.tick === server.tick ? stateHash(server.state) : at);
}

let colyseus: ColyseusTestServer;
let base: string;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const server = makeServer({ env: loadGameEnv({ GATE_MODE: "open" }), gracefullyShutdown: false });
  await listen(server, port, "127.0.0.1");
  colyseus = new ColyseusTestServer(server);
});

afterAll(async () => {
  await colyseus?.shutdown();
});

async function matchTwo(names: [string, string] = ["Rooster", "Hen"]): Promise<[Bot, Bot, FightRoom]> {
  const a = await queueUp(colyseus.sdk, { name: names[0], guestId: `guest-${names[0]}-${Math.random().toString(36).slice(2, 10)}`, rtt: 20 });
  const b = await queueUp(colyseus.sdk, { name: names[1], guestId: `guest-${names[1]}-${Math.random().toString(36).slice(2, 10)}`, rtt: 20 });
  const [ma, mb] = await Promise.all([a.matched, b.matched]);
  expect(ma.matchId).toBe(mb.matchId);
  expect(new Set([ma.side, mb.side])).toEqual(new Set([0, 1]));
  expect(ma.opponent.name).toBe(names[1]);
  await Promise.all([a.queue.leave(), b.queue.leave()]);
  const bots = await Promise.all([Bot.join(colyseus.sdk, ma), Bot.join(colyseus.sdk, mb)]);
  for (const bot of bots) bot.room.reconnection.minUptime = 0;
  const room = matchMaker.getLocalRoomById(ma.matchId) as unknown as FightRoom;
  // Order by side so bots[0] is P1.
  bots.sort((x, y) => x.pred.side - y.pred.side);
  return [bots[0] as Bot, bots[1] as Bot, room];
}

describe("online match (open mode)", () => {
  it("pairs two queued players, runs the match on the server and both clients converge", async () => {
    const [p1, p2, room] = await matchTwo();
    expect(room.status).toBe("waiting");
    // Walk at each other, then P1 keeps pecking.
    p1.mask = (s) => (s.phase === Phase.fighting ? (s.tick % 20 < 10 ? B.R | B.S : B.R) : 0);
    p2.mask = (s) => (s.phase === Phase.fighting ? B.L : 0);
    p1.ready();
    p2.ready();
    await until(() => room.status === "live", 5000, "live");
    await until(() => room.match.tick > 400, 15_000, "400 ticks");
    // Freeze the moment: stop the bots, let in-flight frames land, then compare
    // each client's confirmed state to the server's at the same tick.
    p1.stop();
    p2.stop();
    await sleep(150);
    const server = room.match;
    for (const bot of [p1, p2]) {
      const c = bot.pred.confirmed!;
      expectConfirmedMatches(server, c);
      expect(bot.pred.stats.desyncs).toBe(0);
    }
    // Their buttons reached the server and moved the fighters.
    expect(server.state.f[0].x).toBeGreaterThan(-3000);
    expect(server.stats[0].received).toBeGreaterThan(300);
    await p1.room.leave();
    await p2.room.leave();
  }, 30_000);

  it("a dropped player pauses the match; not coming back within 10 s forfeits it and the result replays exactly", async () => {
    const [p1, p2, room] = await matchTwo(["Stayer", "Dropper"]);
    p1.ready();
    p2.ready();
    await until(() => room.status === "live", 5000, "live");
    await until(() => room.match.tick > 60, 5000, "60 ticks");
    p2.stop();
    p2.room.reconnection.enabled = false;
    p2.room.connection.close(4010); // abnormal close: no leave message
    await until(() => room.status === "paused", 3000, "paused");
    const pausedAt = room.match.tick;
    const t0 = Date.now();
    await sleep(1500);
    expect(room.match.tick).toBe(pausedAt); // the sim is frozen while paused
    expect(room.state.pauseLeft).toBeGreaterThan(0);
    await until(() => room.status === "over", 12_000, "forfeit");
    const waited = Date.now() - t0 + 1500;
    expect(waited).toBeGreaterThan(8000);
    expect(room.state.reason).toBe("forfeit");
    expect(room.state.winner).toBe(0);
    await until(() => room.state.recorded, 3000, "recorded");

    // The stored match replays to the server's exact state at the forfeit.
    const m = getContext().memory.getMatch(room.state.matchId)!;
    // Sides are random: whoever sat P1 stayed (bots[0] is P1).
    const [n1, n2] = [room.state.seats[0]!.name, room.state.seats[1]!.name];
    expect(new Set([n1, n2])).toEqual(new Set(["Stayer", "Dropper"]));
    expect(m).toMatchObject({ winner_side: 0, reason: "forfeit", p1_name: n1, p2_name: n2, ranked: false });
    expect(m.rounds).toEqual([{ n: 1, winner: 0, reason: "forfeit", tick: room.match.tick }]);
    const replay = decodeReplayLog(m.input_log);
    const out = runReplay(replay);
    expect(out.hash).toBe(stateHash(room.match.state));
    // Guests have no address, so an open match's hash covers its id and log.
    expect(m.result_hash).toBe(await resultHash(m.id, null, m.input_log));
    // Served over HTTP for the replay page.
    const res = await fetch(`${base}/api/matches/${m.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(m.id);
    expect((await fetch(`${base}/api/matches/not-a-uuid`)).status).toBe(404);
    // Both ratings moved in the open-mode (memory) table.
    expect(room.state.seats[0]!.eloDelta).toBeGreaterThan(0);
    expect(room.state.seats[1]!.eloDelta).toBe(-room.state.seats[0]!.eloDelta);
    const lb = (await (await fetch(`${base}/api/leaderboard`)).json()) as { rows: { display_name: string; wins_all: number }[] };
    expect(lb.rows.find((r) => r.display_name === n1)?.wins_all).toBe(1);
    await p1.room.leave();
    p1.stop();
  }, 40_000);

  it("a player who comes back within the grace resumes the match from a full sync", async () => {
    const [p1, p2, room] = await matchTwo(["Steady", "Flaky"]);
    p1.ready();
    p2.ready();
    await until(() => room.status === "live", 5000, "live");
    await until(() => room.match.tick > 60, 5000, "60 ticks");
    p2.room.connection.close(4010); // the SDK reconnects on its own
    await until(() => room.status === "paused", 3000, "paused");
    await until(() => room.status === "live", 8000, "resumed");
    const resumedAt = room.match.tick;
    await until(() => room.match.tick > resumedAt + 120, 5000, "ticking again");
    p1.stop();
    p2.stop();
    await sleep(150);
    for (const bot of [p1, p2]) {
      expectConfirmedMatches(room.match, bot.pred.confirmed!);
    }
    expect(p2.pred.stats.adopted).toBeGreaterThanOrEqual(1);
    await p1.room.leave();
    await p2.room.leave();
  }, 30_000);

  it("leaving on purpose forfeits at once", async () => {
    const [p1, p2, room] = await matchTwo(["Winner", "Quitter"]);
    p1.ready();
    p2.ready();
    await until(() => room.status === "live", 5000, "live");
    p2.stop();
    await p2.room.leave();
    await until(() => room.status === "over", 3000, "over");
    expect(room.state.reason).toBe("forfeit");
    expect(room.state.winner).toBe(0);
    p1.stop();
    await p1.room.leave();
  }, 20_000);

  it("a seated match refuses anyone else, and a second ticket for the same player is refused", async () => {
    const [p1, p2, room] = await matchTwo(["Alpha", "Beta"]);
    await expect(colyseus.sdk.joinById(room.roomId, { name: "Intruder" })).rejects.toThrow();
    p1.stop();
    p2.stop();
    await p1.room.leave();
    await p2.room.leave();

    // The first ticket stays; the second is refused (evicting would let anyone kick you out of the queue).
    const first = await queueUp(colyseus.sdk, { name: "Twin", guestId: "same-guest-id-123" });
    await expect(queueUp(colyseus.sdk, { name: "Twin", guestId: "same-guest-id-123" })).rejects.toThrow(/already in the queue/);
    await first.queue.leave();
  }, 20_000);

  it("rejects bad names, out-of-date clients and client-made queues", async () => {
    await expect(colyseus.sdk.join("queue", { name: "<script>", rules: RULES.hash })).rejects.toThrow(/name/);
    await expect(colyseus.sdk.join("queue", { rules: RULES.hash })).rejects.toThrow(/name/);
    await expect(colyseus.sdk.join("queue", { name: "Oldie", rules: "0000000000000000" })).rejects.toThrow(/reload/);
    await expect(colyseus.sdk.create("queue", { name: "Maker", rules: RULES.hash })).rejects.toThrow();
  });

  it("a player who leaves during the pause after the deciding KO still wins", async () => {
    const [p1, p2, room] = await matchTwo(["Champ", "Chump"]);
    p1.ready();
    p2.ready();
    await until(() => room.status === "live", 5000, "live");
    // Jump the sim to the pause after P1's second round win (the sim counts wins at the KO).
    const s = room.match.state;
    Object.assign(s, { phase: Phase.roundEnd, phaseT: 100, round: 2, w1: 2, w2: 0, roundWinner: 0, reason: Reason.ko });
    p1.stop();
    await p1.room.leave(); // the winner walks away before the match-end screen
    await until(() => room.status === "over", 5000, "over");
    expect(room.state.winner).toBe(0);
    expect(room.state.reason).not.toBe("forfeit");
    p2.stop();
    await p2.room.leave();
  }, 20_000);

  it("both players vanishing calls the match off", async () => {
    const [p1, p2, room] = await matchTwo(["Ghost", "Phantom"]);
    p1.ready();
    p2.ready();
    await until(() => room.status === "live", 5000, "live");
    for (const b of [p1, p2]) {
      b.stop();
      b.room.reconnection.enabled = false;
      b.room.connection.close(4010);
    }
    await until(() => room.status === "cancelled", 15_000, "cancelled");
    expect(room.state.reason).toBe("both players left");
  }, 25_000);
});
