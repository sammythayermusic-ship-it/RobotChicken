import { describe, expect, it } from "vitest";
import { parsePlayParams } from "./params";

const from = (q: string) => {
  const sp = new URLSearchParams(q);
  return parsePlayParams((k) => sp.get(k));
};

describe("parsePlayParams", () => {
  it("defaults to the online lobby (no mode, not practice)", () => {
    expect(from("")).toMatchObject({ mode: null, practice: false, difficulty: "normal", tier: "rust", seed: null, manual: false, arena: true, quality: null, touch: null });
  });
  it("practice=1 opens the free vs-CPU picker", () => {
    expect(from("practice=1").practice).toBe(true);
  });
  it("forces the on-screen buttons on or off, else leaves it to the device", () => {
    expect(from("touch=1").touch).toBe(true);
    expect(from("touch=0").touch).toBe(false);
    expect(from("touch=yes").touch).toBe(null);
  });
  it("only a debug link can stand the CPU still", () => {
    expect(from("cpu=idle").idleCpu).toBe(false);
    expect(from("debug=1&cpu=idle").idleCpu).toBe(true);
  });
  it("reads a direct fight link", () => {
    expect(from("mode=cpu&difficulty=hard&tier=gold&quality=low&arena=0")).toMatchObject({
      mode: "cpu",
      difficulty: "hard",
      tier: "gold",
      quality: "low",
      arena: false,
    });
  });
  it("bench implies a seeded CPU demo with the FPS meter", () => {
    expect(from("bench=1")).toMatchObject({ mode: "demo", seed: "bench", fps: true, bench: true });
  });
  it("online opens the lobby, with a wallet from the landing page", () => {
    expect(from("mode=online&wallet=%209WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toMatchObject({
      mode: "online",
      wallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    });
  });
  it("ignores unknown values", () => {
    expect(from("mode=arcade&difficulty=insane&tier=platinum&quality=ultra")).toMatchObject({
      mode: null,
      difficulty: "normal",
      tier: "rust",
      quality: null,
    });
  });
});
