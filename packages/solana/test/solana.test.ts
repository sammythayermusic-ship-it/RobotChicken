import { describe, expect, it } from "vitest";
import { anonName, isValidAddress } from "../src/index";

describe("addresses", () => {
  it("accepts 32-byte base58 addresses", () => {
    expect(isValidAddress("11111111111111111111111111111111")).toBe(true); // system program
    expect(isValidAddress("So11111111111111111111111111111111111111112")).toBe(true); // wSOL mint
  });
  it("rejects garbage and wrong lengths", () => {
    expect(isValidAddress("")).toBe(false);
    expect(isValidAddress("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toBe(false); // not base58
    expect(isValidAddress("1111111111111111111111111111111")).toBe(false); // too short
    expect(isValidAddress("z".repeat(44))).toBe(false); // decodes to 33 bytes
  });
  it("anon names use the last 4 chars", () => {
    expect(anonName("So11111111111111111111111111111111111111112")).toBe("anon-1112");
  });
});
