import { describe, expect, it } from "vitest";
import { STATE_INTS, createMatch, serialize } from "@cockfight/sim";
import { MAX_INPUT_BATCH, decodeFrames, decodeInputs, decodeSync, encodeFrames, encodeInputs, encodeSync } from "../src/protocol";

describe("protocol codecs", () => {
  it("round-trips inputs, frames and syncs", () => {
    expect(decodeInputs(encodeInputs(123456, [0, 31, 16]))).toEqual({ first: 123456, masks: [0, 31, 16] });
    const f = { first: 99, b1: [1, 2, 3], b2: [16, 0, 8], margin: -1 };
    expect(decodeFrames(encodeFrames(f))).toEqual(f);
    const st = serialize(createMatch({ matchId: "p" }));
    const s = decodeSync(encodeSync(42, st));
    expect(s?.tick).toBe(42);
    expect(Array.from(s!.state)).toEqual(Array.from(st));
  });

  it("rejects malformed bytes instead of throwing", () => {
    expect(decodeInputs(new Uint8Array([1, 2]))).toBeNull();
    expect(decodeInputs(new Uint8Array([0, 0, 0, 0, 2, 1]))).toBeNull(); // says 2 masks, has 1
    expect(decodeInputs(new Uint8Array([0, 0, 0, 0, 1, 32]))).toBeNull(); // mask out of range
    expect(decodeInputs(new Uint8Array([0, 0, 0, 0, 0]))).toBeNull();
    const tooMany = new Uint8Array(5 + MAX_INPUT_BATCH + 1);
    tooMany[4] = MAX_INPUT_BATCH + 1;
    expect(decodeInputs(tooMany)).toBeNull();
    expect(decodeInputs("hello")).toBeNull();
    expect(decodeInputs({ first: 1 })).toBeNull();
    expect(decodeFrames(new Uint8Array(7))).toBeNull();
    expect(decodeSync(new Uint8Array(4 + 4 * STATE_INTS - 1))).toBeNull();
  });

  it("reads inputs from a Buffer view with an offset (Node hands over pooled Buffers)", () => {
    const enc = encodeInputs(7, [5]);
    const pool = Buffer.alloc(64);
    pool.set(enc, 13);
    expect(decodeInputs(pool.subarray(13, 13 + enc.length))).toEqual({ first: 7, masks: [5] });
  });
});
