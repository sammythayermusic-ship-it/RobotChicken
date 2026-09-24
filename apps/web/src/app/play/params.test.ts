import { describe, expect, it } from "vitest";
import { parsePlayParams } from "./params";

const from = (q: string) => {
  const sp = new URLSearchParams(q);
  return parsePlayParams((k) => sp.get(k));
};

describe("parsePlayParams", () => {
  it("defaults to the mode picker", () => {
    expect(from("")).toMatchObject({ mode: null, difficulty: "normal", tier: "rust", seed: null, manual: false, arena: true, quality: null });
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
  it("ignores unknown values", () => {
    expect(from("mode=online&difficulty=insane&tier=platinum&quality=ultra")).toMatchObject({
      mode: null,
      difficulty: "normal",
      tier: "rust",
      quality: null,
    });
  });
});
