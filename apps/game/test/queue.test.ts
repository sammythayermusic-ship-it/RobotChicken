import { describe, expect, it } from "vitest";
import { ANY_RTT_AFTER_MS, WIDEN_AFTER_MS, rttAllows } from "../src/rooms/QueueRoom";
import { QueueTokens } from "../src/token";

describe("queue pairing by RTT (spec: 120 ms, 200 ms after 20 s)", () => {
  const t0 = 1_000_000;
  it("pairs players within 120 ms right away", () => {
    expect(rttAllows({ rtt: 110, joinedAt: t0 }, { rtt: 90, joinedAt: t0 }, t0 + 500)).toBe(true);
    expect(rttAllows({ rtt: 150, joinedAt: t0 }, { rtt: 90, joinedAt: t0 }, t0 + 500)).toBe(false);
  });
  it("widens to 200 ms once either has waited 20 s, and to anyone after 60 s", () => {
    expect(rttAllows({ rtt: 190, joinedAt: t0 }, { rtt: 30, joinedAt: t0 + 15_000 }, t0 + WIDEN_AFTER_MS)).toBe(true);
    expect(rttAllows({ rtt: 250, joinedAt: t0 }, { rtt: 30, joinedAt: t0 }, t0 + WIDEN_AFTER_MS)).toBe(false);
    expect(rttAllows({ rtt: 900, joinedAt: t0 }, { rtt: 30, joinedAt: t0 }, t0 + ANY_RTT_AFTER_MS)).toBe(true);
  });
});

describe("queue tokens", () => {
  it("verify what they signed, and nothing forged, tampered or expired", () => {
    const t = new QueueTokens("s".repeat(40));
    const tok = t.sign({ sub: "Addr", tier: "gold", usd: 1234.5, elo: 1100 }, 1000);
    expect(t.verify(tok, 1001)).toMatchObject({ sub: "Addr", tier: "gold", usd: 1234.5, elo: 1100, exp: 1300 });
    expect(t.verify(tok, 1300)).toBeNull(); // expired (5 min)
    expect(new QueueTokens("o".repeat(40)).verify(tok, 1001)).toBeNull();
    const [h, p, s] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "Addr", tier: "diamond", usd: 1e9, elo: 0, iat: 1000, exp: 1300 })).toString("base64url");
    expect(t.verify(`${h}.${forged}.${s}`, 1001)).toBeNull();
    expect(t.verify(`${h}.${p}`, 1001)).toBeNull();
    expect(t.verify(42, 1001)).toBeNull();
  });
});

describe("gate service", () => {
  it("in production, an unset Turnstile secret closes the gate instead of skipping the bot check", async () => {
    const { loadGameEnv } = await import("@cockfight/shared/env");
    const { GateService } = await import("../src/gate");
    let called = false;
    const f = (async () => {
      called = true;
      return Response.json({ success: true });
    }) as typeof fetch;
    const env = loadGameEnv({ NODE_ENV: "production", GATE_MODE: "required", ALLOWED_ORIGINS: "https://cockfight.fun" });
    const g = new GateService(env, null, f, null);
    const res = await g.enter({ address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", turnstile: "anything" }, "1.2.3.4");
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  it("checks the Turnstile hostname in production", async () => {
    const { verifyTurnstile } = await import("../src/turnstile");
    const f = (async () => Response.json({ success: true, hostname: "evil.example" })) as typeof fetch;
    expect(await verifyTurnstile("s", "tok", null, f, ["cockfight.fun"])).toBe(false);
    expect(await verifyTurnstile("s", "tok", null, f)).toBe(true);
  });

  it("rate-limits IPv6 by /64 and trusts only Fly-Client-IP on Fly", async () => {
    const { clientIp, ipBucket } = await import("../src/gate");
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe(ipBucket("2001:db8:1:2:bbbb::9"));
    expect(ipBucket("1.2.3.4")).toBe("1.2.3.4");
    const h = new Headers({ "x-forwarded-for": "6.6.6.6" });
    expect(clientIp(h, true)).toBeNull();
    expect(clientIp(h, false)).toBe("6.6.6.6");
    expect(clientIp(new Headers({ "fly-client-ip": "7.7.7.7", "x-forwarded-for": "6.6.6.6" }), true)).toBe("7.7.7.7");
  });
});
