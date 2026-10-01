import { ColyseusTestServer } from "@colyseus/testing";
import { loadGameEnv } from "@cockfight/shared/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listen, makeServer } from "../src/server";
import { freePort, queueUp, sleep, until } from "./helpers";

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  const port = await freePort();
  const server = makeServer({ env: loadGameEnv({ GATE_MODE: "open", MAX_LIVE_MATCHES: "1" }), gracefullyShutdown: false });
  await listen(server, port, "127.0.0.1");
  colyseus = new ColyseusTestServer(server);
});

afterAll(async () => {
  await colyseus?.shutdown();
});

const join = (name: string) => queueUp(colyseus.sdk, { name, guestId: `guest-${name}-${Math.random().toString(36).slice(2, 10)}`, rtt: 20 });

describe("live-match cap (MAX_LIVE_MATCHES)", () => {
  it("holds the next pair in line with full=true, and pairs them once a pit frees up", async () => {
    const a = await join("Alpha");
    const b = await join("Bravo");
    const [ma] = await Promise.all([a.matched, b.matched]);
    await Promise.all([a.queue.leave(), b.queue.leave()]);

    const c = await join("Charlie");
    const d = await join("Delta");
    let paired = false;
    void Promise.all([c.matched, d.matched]).then(() => (paired = true));
    await until(() => (c.queue.state as { full?: boolean }).full === true, 3000, "full");
    await sleep(600);
    expect(paired).toBe(false);

    // The first match's room goes away (nobody took the seats): the line moves.
    const { matchMaker } = await import("@colyseus/core");
    await matchMaker.getLocalRoomById(ma.matchId)?.disconnect();
    await until(() => paired, 8000, "second pair matched");
    expect((c.queue.state as { full?: boolean }).full).toBe(false);
  });
});
