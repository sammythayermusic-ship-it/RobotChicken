import { describe, expect, it } from "vitest";
import {
  FIGHTER_FIELDS, MATCH_FIELDS, STATE_INTS, createMatch, deserialize, hashBytes, hashInts, serialize, stateHash, xorshift32,
} from "../src/index";

function refFnv64(bytes: number[]): string {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * p) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

describe("hash", () => {
  it("two-lane FNV-1a-64 matches a BigInt reference", () => {
    let x = 12345;
    for (let n = 0; n < 2000; n++) {
      const len = (n % 67) + 1;
      const bytes: number[] = [];
      for (let i = 0; i < len; i++) {
        x = xorshift32(x);
        bytes.push(x & 0xff);
      }
      expect(hashBytes(bytes)).toBe(refFnv64(bytes));
    }
  });
  it("hashes ints as little-endian bytes", () => {
    const v = [1, -1, 0x7fffffff, -0x80000000, 258];
    const bytes = v.flatMap((n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
    expect(hashInts(v)).toBe(refFnv64(bytes));
  });
  it("covers every state field (a new field cannot be left out of the hash)", () => {
    const s = createMatch({ matchId: "x" });
    const { f, ...top } = s;
    expect(Object.keys(top).sort()).toEqual([...MATCH_FIELDS].sort());
    expect(Object.keys(f[0]).sort()).toEqual([...FIGHTER_FIELDS].sort());
    expect(serialize(s).length).toBe(STATE_INTS);
  });
  it("serialize / deserialize round-trips", () => {
    const s = createMatch({ matchId: "roundtrip" });
    s.f[1].x = -12345;
    s.f[0].hitT = -1;
    const back = deserialize(serialize(s));
    expect(back).toEqual(s);
    expect(stateHash(back)).toBe(stateHash(s));
  });
  it("is sensitive to every field", () => {
    const s = createMatch({ matchId: "sens" });
    const base = stateHash(s);
    const a = serialize(s);
    for (let i = 0; i < a.length; i++) {
      const b = Int32Array.from(a);
      b[i] = (b[i] as number) + 1;
      expect(hashInts(b)).not.toBe(base);
    }
  });
});
