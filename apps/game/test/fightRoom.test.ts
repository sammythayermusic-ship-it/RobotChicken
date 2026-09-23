import { request } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { matchMaker } from "@colyseus/core";
import { ColyseusTestServer } from "@colyseus/testing";
import { createMatch, step, type MatchState } from "@cockfight/sim";
import { loadGameEnv } from "@cockfight/shared/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FightRoom } from "../src/rooms/FightRoom";
import { listen, makeServer } from "../src/server";

/** The sim run the room should be doing: `ticks` steps with no input. */
function replay(matchId: string, ticks: number): MatchState {
  let s = createMatch({ matchId });
  for (let i = 0; i < ticks; i++) s = step(s, 0, 0);
  return s;
}

const clock = (s: { tick: number; phase: number; round: number; timer: number }) => ({
  tick: s.tick,
  phase: s.phase,
  round: s.round,
  timer: s.timer,
});

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Raw WebSocket handshake, so the test controls the Origin header. Resolves the HTTP status. */
function upgradeStatus(port: number, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

const ALLOWED = "http://localhost:3000";
let colyseus: ColyseusTestServer;
let port: number;
let base: string;

beforeAll(async () => {
  // Not `boot(server)`: for Server instances it ignores its port argument and
  // always binds 2568, which collides when two test runs share a machine.
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const server = makeServer({ env: loadGameEnv({ ALLOWED_ORIGINS: ALLOWED }), gracefullyShutdown: false });
  await listen(server, port, "127.0.0.1");
  colyseus = new ColyseusTestServer(server);
});

afterAll(async () => {
  await colyseus?.shutdown();
});

describe("FightRoom", () => {
  it("seats two players, rejects a third, and runs the sim on the server clock", async () => {
    const room = await colyseus.createRoom<FightRoom>("fight");
    expect(room).toBeInstanceOf(FightRoom);
    expect(room.patchRate).toBe(50);

    const p1 = await colyseus.connectTo(room);
    const p2 = await colyseus.connectTo(room);
    expect(room.clients.length).toBe(2);
    await expect(colyseus.sdk.joinById(room.roomId)).rejects.toThrow();

    for (let i = 0; i < 6; i++) await room.waitForNextTimestep();

    // Read tick and sim in the same synchronous turn, so no step lands in between.
    const tick = room.state.tick;
    const sim = room.sim;
    expect(tick).toBeGreaterThanOrEqual(6);
    expect(sim).toEqual(replay(room.roomId, tick));
    expect(clock(room.state)).toEqual(clock(replay(room.roomId, tick)));

    // What the clients decode is the same clock at whatever tick the last patch carried.
    await p1.waitForNextPatch();
    const seen = clock(p1.state as never);
    expect(seen.tick).toBeGreaterThan(0);
    expect(seen).toEqual(clock(replay(room.roomId, seen.tick)));

    await p1.leave();
    await p2.leave();
  });

  it("an exception in the step closes that room without taking the process down", async () => {
    class BrokenFightRoom extends FightRoom {
      protected override tick(): void {
        throw new Error("boom");
      }
    }
    matchMaker.defineRoomType("fight_broken", BrokenFightRoom);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const room = await colyseus.createRoom("fight_broken");
      const deadline = Date.now() + 5000;
      while (matchMaker.getLocalRoomById(room.roomId) !== undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(matchMaker.getLocalRoomById(room.roomId)).toBeUndefined();
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("setFixedTimestep threw"), expect.any(Error));
    } finally {
      errors.mockRestore();
      matchMaker.removeRoomType("fight_broken");
    }
  });
});

describe("HTTP", () => {
  it("GET /health reports ok, region and room count", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, region: "local", rooms: expect.any(Number) });
  });

  it("matchmaking answers with a seat reservation and echoes only allowed origins", async () => {
    const ok = await fetch(`${base}/matchmake/joinOrCreate/lobby`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ALLOWED },
      body: "{}",
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(ok.headers.get("vary")).toBe("Origin");
    const seat = await ok.json();
    expect(seat).toMatchObject({ name: "lobby", roomId: expect.any(String), sessionId: expect.any(String) });

    const evil = await fetch(`${base}/matchmake/joinOrCreate/lobby`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    await evil.body?.cancel();
    expect(evil.headers.get("access-control-allow-origin")).toBe(ALLOWED);

    const preflight = await fetch(`${base}/matchmake/joinOrCreate/lobby`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
    expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("refuses WebSocket upgrades from other browser origins", async () => {
    expect(await upgradeStatus(port, "https://evil.example")).toBe(403);
    expect(await upgradeStatus(port, "null")).toBe(403);
    expect(await upgradeStatus(port, ALLOWED)).toBe(101);
    expect(await upgradeStatus(port)).toBe(101); // Node clients send no Origin
  });
});
