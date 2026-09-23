import { describe, expect, it } from "vitest";
import { tierForUsd } from "../src/index";
import { clean, loadGameEnv, loadWebPublicEnv, loadWorkerEnv, requireEnv } from "../src/env";

describe("tiers", () => {
  it("maps USD holdings to cosmetic tiers at the spec's thresholds", () => {
    expect(tierForUsd(29.99)).toBeNull();
    expect(tierForUsd(30)).toBe("rust");
    expect(tierForUsd(249.99)).toBe("rust");
    expect(tierForUsd(250)).toBe("chrome");
    expect(tierForUsd(1000)).toBe("gold");
    expect(tierForUsd(5000)).toBe("diamond");
    expect(tierForUsd(1e9)).toBe("diamond");
  });
});

describe("env", () => {
  it("every process boots with zero env vars", () => {
    expect(loadGameEnv({}).PORT).toBe(2567);
    expect(loadWorkerEnv({}).PORT).toBe(8080);
    expect(loadWorkerEnv({}).PAYOUTS_ENABLED).toBe(false);
    expect(loadWebPublicEnv({}).NEXT_PUBLIC_GAME_WS_URL).toBe("ws://localhost:2567");
  });
  it("empty values fall back to defaults", () => {
    expect(clean({ A: "", B: "  ", C: "x" })).toEqual({ C: "x" });
    expect(loadGameEnv({ PORT: "" }).PORT).toBe(2567);
  });
  it('"false" parses as false', () => {
    expect(loadWorkerEnv({ PAYOUTS_ENABLED: "false" }).PAYOUTS_ENABLED).toBe(false);
    expect(loadWorkerEnv({ PAYOUTS_ENABLED: "true" }).PAYOUTS_ENABLED).toBe(true);
  });
  it("splits ALLOWED_ORIGINS", () => {
    expect(loadGameEnv({ ALLOWED_ORIGINS: "https://a.fun, https://b.fun" }).ALLOWED_ORIGINS).toEqual(["https://a.fun", "https://b.fun"]);
  });
  it("rejects a bad mint", () => {
    expect(() => loadGameEnv({ NEXT_PUBLIC_COCK_MINT: "not-an-address" })).toThrow();
  });
  it("requireEnv lists every missing key", () => {
    expect(() => requireEnv(loadGameEnv({}), ["QUEUE_JWT_SECRET", "REDIS_URL"], "queue")).toThrow(/QUEUE_JWT_SECRET, REDIS_URL/);
  });
});
