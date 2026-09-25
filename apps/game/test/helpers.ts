import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Client as SdkClient, Room as SdkRoom } from "@colyseus/sdk";
import { ClientPredictor, Msg, decodeFrames, decodeSync } from "@cockfight/net";
import { RULES, type MatchState } from "@cockfight/sim";

export async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export interface Matched {
  reservation: unknown;
  side: 0 | 1;
  matchId: string;
  opponent: { name: string; tier: string };
}

/** Join the queue and resolve with the "matched" message (or reject on "kicked"). */
export async function queueUp(sdk: SdkClient, options: Record<string, unknown>): Promise<{ queue: SdkRoom; matched: Promise<Matched> }> {
  const queue = await sdk.join("queue", { rules: RULES.hash, ...options });
  const matched = new Promise<Matched>((resolve, reject) => {
    queue.onMessage("matched", (m: Matched) => resolve(m));
    queue.onMessage("kicked", (m: { reason: string; message: string }) => reject(Object.assign(new Error(m.message), { kicked: m })));
  });
  return { queue, matched };
}

/**
 * A scripted player: joins the fight room from a reservation, runs a
 * ClientPredictor on a 60 Hz timer and sends its buttons.
 */
export class Bot {
  room!: SdkRoom;
  pred!: ClientPredictor;
  mask: (s: MatchState) => number = () => 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  static async join(sdk: SdkClient, m: Matched): Promise<Bot> {
    const b = new Bot();
    b.room = await sdk.consumeSeatReservation(m.reservation as never);
    b.pred = new ClientPredictor(m.matchId, m.side);
    b.pred.setRtt(10);
    b.room.onMessage(Msg.frames, (bytes: Uint8Array) => {
      const f = decodeFrames(bytes);
      if (f) b.pred.onFrames(f);
    });
    b.room.onMessage(Msg.sync, (bytes: Uint8Array) => {
      const s = decodeSync(bytes);
      if (s) b.pred.onSync(s);
    });
    return b;
  }

  ready(): void {
    this.room.send(Msg.ready);
    this.timer = setInterval(() => {
      const status = (this.room.state as { status?: string }).status;
      if (status === "paused") this.pred.pause();
      else if (status === "live") this.pred.resume();
      this.pred.tick((s) => this.mask(s));
      for (const bytes of this.pred.takeOutgoing()) this.room.sendBytes(Msg.input, bytes);
    }, 1000 / 60);
  }

  get status(): string {
    return String((this.room.state as { status?: string }).status ?? "");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
