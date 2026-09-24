/**
 * Wire protocol between the fight room and the browser. Sim traffic is binary
 * (Colyseus `sendBytes`): a few bytes of buttons per tick, and the full
 * serialized sim state (73 int32s) for syncs. Everything is little-endian.
 *
 * The server is the only truth. Clients send buttons only, never positions or
 * hits; the server replies with the buttons it actually used for both players
 * each tick, so every client can re-run the exact same sim.
 */
import { BUTTON_MASK, STATE_INTS } from "@cockfight/sim";

/** Message types. Numbers, so Colyseus sends one byte for the type. */
export const Msg = {
  /** client → server: buttons for consecutive ticks. */
  input: 1,
  /** client → server: assets loaded, ready to fight. */
  ready: 2,
  /** client → server: leave the match on purpose (forfeits a live match). */
  forfeit: 3,
  /** server → client: confirmed buttons for consecutive ticks, plus this client's input margin. */
  frames: 10,
  /** server → client: the full sim state after a tick (join, resume, and a periodic desync check). */
  sync: 11,
} as const;

/** The client tags its buttons this many ticks ahead of the tick it is showing (spec: 2 ticks of input delay). */
export { INPUT_DELAY } from "@cockfight/shared";
/**
 * Inputs for a tick more than this far ahead of the server are rejected. The
 * spec's "+3" cannot hold a predicting client: at 80 ms RTT its inputs arrive
 * about 2 + INPUT_DELAY ticks early, and jitter spikes need room above that.
 * It also caps how far a client predicts (MAX_PREDICT), which has to cover a
 * whole round trip: 40 ticks (667 ms) keeps players up to ~500 ms RTT
 * playable while still stopping a sped-up client from running far ahead.
 */
export const MAX_LEAD = 40;
/** Most ticks one input message may carry (a client catching up after a stall). */
export const MAX_INPUT_BATCH = 32;
/** The server sends a full-state sync every this many ticks (twice a second). */
export const SYNC_EVERY = 30;
/** The margin (ticks) a client aims for between its inputs' arrival and their use. */
export const TARGET_MARGIN = 2;

export interface InputBatch {
  /** Tick the first mask is for. */
  first: number;
  masks: number[];
}

/** [u32 first][u8 n][n × u8 mask] */
export function encodeInputs(first: number, masks: ArrayLike<number>): Uint8Array {
  const n = masks.length;
  if (n < 1 || n > MAX_INPUT_BATCH) throw new Error(`encodeInputs: 1..${MAX_INPUT_BATCH} masks (got ${n})`);
  const out = new Uint8Array(5 + n);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, first >>> 0, true);
  out[4] = n;
  for (let i = 0; i < n; i++) out[5 + i] = (masks[i] as number) & BUTTON_MASK;
  return out;
}

/** Null for anything malformed (a hostile client can send any bytes). */
export function decodeInputs(bytes: unknown): InputBatch | null {
  const b = asBytes(bytes);
  if (!b || b.length < 6) return null;
  const n = b[4] as number;
  if (n < 1 || n > MAX_INPUT_BATCH || b.length !== 5 + n) return null;
  const first = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  const masks: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = b[5 + i] as number;
    if (m > BUTTON_MASK) return null;
    masks.push(m);
  }
  return { first, masks };
}

export interface FrameBatch {
  first: number;
  /** Buttons the server used for P1 and P2 on ticks first..first+n-1. */
  b1: number[];
  b2: number[];
  /**
   * How many ticks early this client's input for the batch's ticks arrived:
   * the smallest over the batch, -1 if any was missing (late), clamped to
   * [-1, 127]. The client speeds up or slows down to keep it near TARGET_MARGIN.
   */
  margin: number;
}

/** [u32 first][u8 n][i8 margin][n × (u8 b1, u8 b2)] */
export function encodeFrames(f: FrameBatch): Uint8Array {
  const n = f.b1.length;
  if (n < 1 || n > 255 || f.b2.length !== n) throw new Error("encodeFrames: 1..255 frames, b1 and b2 the same length");
  const out = new Uint8Array(6 + 2 * n);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, f.first >>> 0, true);
  out[4] = n;
  dv.setInt8(5, Math.max(-1, Math.min(127, f.margin | 0)));
  for (let i = 0; i < n; i++) {
    out[6 + 2 * i] = (f.b1[i] as number) & BUTTON_MASK;
    out[7 + 2 * i] = (f.b2[i] as number) & BUTTON_MASK;
  }
  return out;
}

export function decodeFrames(bytes: unknown): FrameBatch | null {
  const b = asBytes(bytes);
  if (!b || b.length < 8) return null;
  const n = b[4] as number;
  if (n < 1 || b.length !== 6 + 2 * n) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const f: FrameBatch = { first: dv.getUint32(0, true), b1: [], b2: [], margin: dv.getInt8(5) };
  for (let i = 0; i < n; i++) {
    f.b1.push((b[6 + 2 * i] as number) & BUTTON_MASK);
    f.b2.push((b[7 + 2 * i] as number) & BUTTON_MASK);
  }
  return f;
}

export interface Sync {
  /** The state is the one after this tick was stepped (0 = before the first step). */
  tick: number;
  state: Int32Array;
}

/** [u32 tick][STATE_INTS × i32] */
export function encodeSync(tick: number, state: Int32Array): Uint8Array {
  if (state.length !== STATE_INTS) throw new Error(`encodeSync: expected ${STATE_INTS} ints`);
  const out = new Uint8Array(4 + 4 * STATE_INTS);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, tick >>> 0, true);
  for (let i = 0; i < STATE_INTS; i++) dv.setInt32(4 + 4 * i, state[i] as number, true);
  return out;
}

export function decodeSync(bytes: unknown): Sync | null {
  const b = asBytes(bytes);
  if (!b || b.length !== 4 + 4 * STATE_INTS) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const state = new Int32Array(STATE_INTS);
  for (let i = 0; i < STATE_INTS; i++) state[i] = dv.getInt32(4 + 4 * i, true);
  return { tick: dv.getUint32(0, true), state };
}

/** Colyseus hands byte messages over as a Buffer (Node) or Uint8Array (browser). */
function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}
