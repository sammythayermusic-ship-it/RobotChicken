/**
 * One load-test process: keeps `pairs` matches running against a game server
 * in open mode (GATE_MODE=open). Each bot is a real client: it queues, takes
 * its seat, runs the same ClientPredictor as the browser at 60 Hz, sends its
 * buttons, and walks in and pecks until the match ends, then queues again.
 *
 * Prints one JSON line per finished match and a final summary line; run.ts
 * collects them. Env: LT_URL (http(s) base), LT_PAIRS, LT_SECONDS, LT_ID, LT_PECK_EVERY.
 */
import { Client, type Room } from "@colyseus/sdk";
import { ClientPredictor, Msg, decodeFrames, decodeSync } from "@cockfight/net";
import { B, RULES, type MatchState } from "@cockfight/sim";

const url = process.env.LT_URL ?? "http://localhost:2567";
const pairs = Number(process.env.LT_PAIRS ?? 10);
const deadline = Date.now() + Number(process.env.LT_SECONDS ?? 300) * 1000;
const id = process.env.LT_ID ?? "0";
/** Ticks between pecks once in range. 8 ends a match in ~15 s (worst-case churn); 40 gives 1–2 minute matches, closer to people. */
const peckEvery = Number(process.env.LT_PECK_EVERY ?? 40);
const sdk = new Client(url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Played {
  ok: boolean;
  err?: string;
  queueMs: number;
  matchMs: number;
  rtt: number;
  rollbacks: number;
  maxDepth: number;
  snaps: number;
  desyncs: number;
  status: string;
}

function emit(o: object): void {
  process.stdout.write(JSON.stringify({ proc: id, ...o }) + "\n");
}

/** One bot plays one match, from queue to result. */
async function playOne(n: number): Promise<Played> {
  const t0 = Date.now();
  const queue = await sdk.join("queue", { rules: RULES.hash, name: `Load${id}x${n}`, rtt: 40 });
  const pinger = setInterval(() => queue.connection.isOpen && queue.ping((ms) => queue.send("rtt", ms)), 1000);
  const m = await new Promise<{ reservation: unknown; side: 0 | 1; matchId: string }>((resolve, reject) => {
    queue.onMessage("matched", resolve);
    queue.onMessage("kicked", (k: { message: string }) => reject(new Error(`kicked: ${k.message}`)));
    setTimeout(() => reject(new Error("no match within 120 s")), 120_000);
  }).finally(() => clearInterval(pinger));
  void queue.leave().catch(() => {});
  const queueMs = Date.now() - t0;

  const room: Room = await sdk.consumeSeatReservation(m.reservation as never);
  const pred = new ClientPredictor(m.matchId, m.side);
  let rtt = 40;
  pred.setRtt(rtt);
  room.onMessage(Msg.frames, (b: Uint8Array) => {
    const f = decodeFrames(b);
    if (f) pred.onFrames(f);
  });
  room.onMessage(Msg.sync, (b: Uint8Array) => {
    const s = decodeSync(b);
    if (s) pred.onSync(s);
  });
  const ping = setInterval(() => room.connection.isOpen && room.ping((ms) => pred.setRtt((rtt = ms))), 2000);
  const me = m.side;
  const op = me === 0 ? 1 : 0;
  let t = 0;
  const mask = (s: MatchState): number => {
    t++;
    const dx = s.f[op].x - s.f[me].x;
    if (Math.abs(dx) > 1300) return dx > 0 ? B.R : B.L;
    return t % peckEvery === 0 ? B.S : 0;
  };
  const tm = Date.now();
  room.send(Msg.ready);
  const status = () => String((room.state as { status?: string }).status ?? "");
  const timer = setInterval(() => {
    const st = status();
    if (st === "paused") pred.pause();
    else if (st === "live") pred.resume();
    pred.tick(mask);
    for (const bytes of pred.takeOutgoing()) room.sendBytes(Msg.input, bytes);
  }, 1000 / 60);
  // A 5-round match can run ~8 min; give up at 10.
  const end = Date.now() + 600_000;
  while (Date.now() < end && status() !== "over" && status() !== "cancelled" && room.connection.isOpen) await sleep(250);
  clearInterval(timer);
  clearInterval(ping);
  const final = status();
  void room.leave().catch(() => {});
  const st = pred.stats;
  return {
    ok: final === "over",
    err: final === "over" ? undefined : `ended ${final || "closed"}`,
    queueMs,
    matchMs: Date.now() - tm,
    rtt: Math.round(rtt),
    rollbacks: st.rollbacks,
    maxDepth: st.maxDepth,
    snaps: st.corrections.filter((c) => c.snapped).length,
    desyncs: st.desyncs,
    status: final,
  };
}

/** One seat, looping until the deadline. Two seats per pair. */
async function seat(n: number): Promise<void> {
  let i = 0;
  while (Date.now() < deadline) {
    try {
      emit({ match: await playOne(n * 1000 + i++) });
    } catch (e) {
      emit({ match: { ok: false, err: String((e as Error).message ?? e) } });
      await sleep(2000);
    }
  }
}

const seats: Promise<void>[] = [];
for (let n = 0; n < pairs * 2; n++) {
  seats.push(seat(n));
  await sleep(150); // ramp: ~7 joins a second per process
}
await Promise.all(seats);
emit({ done: true });
process.exit(0);
