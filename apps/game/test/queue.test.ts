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
