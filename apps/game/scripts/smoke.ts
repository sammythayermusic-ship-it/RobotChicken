/**
 * Smoke test for the production bundle (`pnpm smoke` builds first).
 *
 * Copies dist/ into an empty temp directory, so nothing can resolve from
 * node_modules (the same situation as the runtime image), boots it with
 * NODE_ENV=production and GATE_MODE=open (the playtest setup) and checks,
 * over real sockets:
 *   1. GET /health and GET /config
 *   2. POST /matchmake/join/queue returns a seat reservation (+ CORS echo)
 *   3. that reservation can be consumed over WebSocket
 *   4. a second player queues, both are matched, join the fight room, send
 *      ready, and receive confirmed frames with a rising tick (sim, schema,
 *      binary messages and the net codecs all work in the bundle)
 *   5. SIGTERM drains and exits 0
 * Exits non-zero on any failure, printing the server's output.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import { Msg, decodeFrames } from "@cockfight/net";
import { RULES } from "@cockfight/sim";

const ORIGIN = "https://smoke.cockfight.test";
const dist = join(import.meta.dirname, "..", "dist");

function fail(msg: string): never {
  throw new Error(msg);
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function waitForHealth(base: string, child: ChildProcess): Promise<unknown> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) fail(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) return await res.json();
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) fail("GET /health never returned 200");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(dist, "server.mjs"))) fail(`${dist}/server.mjs is missing; run \`pnpm build\` first`);

  const dir = mkdtempSync(join(tmpdir(), "cockfight-game-smoke-"));
  cpSync(dist, dir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";

  // A minimal env: nothing from the dev shell (NODE_OPTIONS, loaders) leaks in.
  const child = spawn(process.execPath, ["--enable-source-maps", "server.mjs"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", GATE_MODE: "open", PORT: String(port), ALLOWED_ORIGINS: ORIGIN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));

  try {
    const health = await waitForHealth(base, child);
    // One room: the queue, created at boot.
    if (JSON.stringify(health) !== JSON.stringify({ ok: true, region: "local", rooms: 1 })) {
      fail(`unexpected /health body: ${JSON.stringify(health)}`);
    }
    console.log(`ok   GET /health -> ${JSON.stringify(health)}`);

    const config = (await (await fetch(`${base}/config`)).json()) as { gate?: string };
    if (config.gate !== "open") fail(`unexpected /config: ${JSON.stringify(config)}`);
    console.log(`ok   GET /config -> ${JSON.stringify(config)}`);

    const res = await fetch(`${base}/matchmake/join/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ name: "Smoke A", guestId: "smoke-guest-a", rtt: 10, rules: RULES.hash }),
    });
    if (res.status !== 200) fail(`matchmake returned ${res.status}: ${await res.text()}`);
    if (res.headers.get("access-control-allow-origin") !== ORIGIN) {
      fail(`matchmake CORS: allow-origin ${res.headers.get("access-control-allow-origin")}, expected ${ORIGIN}`);
    }
    const seat = (await res.json()) as SeatReservation;
    if (seat.name !== "queue" || !seat.roomId || !seat.sessionId) fail(`bad seat reservation: ${JSON.stringify(seat)}`);
    console.log(`ok   POST /matchmake/join/queue -> room ${seat.roomId}, session ${seat.sessionId}`);

    const client = new Client(base);
    const qa = await within(5000, "consume queue seat", client.consumeSeatReservation(seat));
    if (qa.roomId !== seat.roomId || qa.sessionId !== seat.sessionId) fail("WebSocket join landed in the wrong seat");
    console.log(`ok   WebSocket join of queue ${qa.roomId}`);

    type Matched = { reservation: SeatReservation; side: number; matchId: string };
    const matchedOf = (q: Room) => new Promise<Matched>((resolve) => q.onMessage("matched", (m: Matched) => resolve(m)));
    const ma = matchedOf(qa);
    const qb = await within(5000, "second player queues", client.join("queue", { name: "Smoke B", guestId: "smoke-guest-b", rtt: 10, rules: RULES.hash }));
    const mb = matchedOf(qb);
    const [a, b] = await within(5000, "both matched", Promise.all([ma, mb]));
    if (a.matchId !== b.matchId) fail("the two players were matched into different rooms");
    console.log(`ok   matched into ${a.matchId}`);
    await qa.leave();
    await qb.leave();

    const fights = await within(5000, "join fight", Promise.all([a, b].map((m) => client.consumeSeatReservation(m.reservation))));
    const ticks: number[] = [];
    const rising = new Promise<void>((resolve) => {
      fights[0]!.onMessage(Msg.frames, (bytes: Uint8Array) => {
        const f = decodeFrames(bytes);
        if (f) ticks.push(f.first);
        if (ticks.length >= 30 && ticks[ticks.length - 1]! > ticks[0]!) resolve();
      });
    });
    for (const f of fights) f.send(Msg.ready);
    await within(5000, "confirmed frames with a rising tick", rising);
    console.log(`ok   fight ${a.matchId} ticking: ${ticks[0]} -> ${ticks[ticks.length - 1]}`);
    for (const f of fights) await f.leave();

    child.kill("SIGTERM");
    const { code, signal } = await within(10_000, "exit after SIGTERM", exited(child));
    if (code !== 0) fail(`SIGTERM exit: code ${code}, signal ${signal}`);
    console.log("ok   SIGTERM -> exit 0");
  } finally {
    console.log(`--- server output ---\n${log}--- end server output ---`);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log("smoke: PASS");
  process.exit(0);
} catch (err) {
  console.error(`smoke: FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
