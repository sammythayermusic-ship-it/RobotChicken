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
  it("a configured gate moves the threshold; past it you are at least rust", () => {
    expect(tierForUsd(12, 10)).toBe("rust");
    expect(tierForUsd(9.99, 10)).toBeNull();
    expect(tierForUsd(40, 50)).toBeNull();
    expect(tierForUsd(Number.NaN)).toBeNull();
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
  it("WEB_PORT moves the default allowed origin with the dev web server", () => {
    expect(loadGameEnv({ WEB_PORT: "3001" }).ALLOWED_ORIGINS).toEqual(["http://localhost:3001", "http://127.0.0.1:3001"]);
    expect(loadGameEnv({ WEB_PORT: "3001", ALLOWED_ORIGINS: "https://a.fun" }).ALLOWED_ORIGINS).toEqual(["https://a.fun"]);
  });
  it("the gate is open outside production and required in production unless set", () => {
    expect(loadGameEnv({}).GATE_MODE).toBe("open");
    expect(loadGameEnv({ NODE_ENV: "production" }).GATE_MODE).toBe("required");
    expect(loadGameEnv({ NODE_ENV: "production", GATE_MODE: "open" }).GATE_MODE).toBe("open");
    expect(() => loadGameEnv({ GATE_MODE: "maybe" })).toThrow();
  });
  it("rejects a bad mint", () => {
    expect(() => loadGameEnv({ NEXT_PUBLIC_COCK_MINT: "not-an-address" })).toThrow();
  });
  it("requireEnv lists every missing key", () => {
    expect(() => requireEnv(loadGameEnv({}), ["QUEUE_JWT_SECRET", "REDIS_URL"], "queue")).toThrow(/QUEUE_JWT_SECRET, REDIS_URL/);
  });
});
