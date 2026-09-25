import { describe, expect, it } from "vitest";
import { originPolicy, parseAllowedOrigins } from "../src/origins";

const ctx = (origin?: string) => ({
  ip: "127.0.0.1",
  headers: new Headers(origin === undefined ? {} : { origin }),
});
const req = new Request("http://game.local/");

describe("parseAllowedOrigins", () => {
  it("normalizes to URL origins", () => {
    expect([...parseAllowedOrigins(["https://Cockfight.Example/", "http://localhost:3000", "https://a.example:443"])]).toEqual([
      "https://cockfight.example",
      "http://localhost:3000",
      "https://a.example",
    ]);
  });

  it("rejects anything that is not a bare http(s) origin", () => {
    expect(() => parseAllowedOrigins(["cockfight.example"])).toThrow(/not a URL/);
    expect(() => parseAllowedOrigins(["ftp://cockfight.example"])).toThrow(/http/);
    expect(() => parseAllowedOrigins(["https://cockfight.example/play"])).toThrow(/bare origin/);
    expect(() => parseAllowedOrigins(["https://cockfight.example?x=1"])).toThrow(/bare origin/);
    expect(() => parseAllowedOrigins(["*"])).toThrow(/not a URL/);
    expect(() => parseAllowedOrigins([])).toThrow(/at least one/);
  });
});

describe("originPolicy", () => {
  const p = originPolicy(["https://cockfight.example", "http://localhost:3000"]);

  it("echoes allowed origins and never answers * or null", () => {
    const cors = (origin?: string) => p.corsHeaders(new Headers(origin === undefined ? {} : { origin }));
    expect(cors("http://localhost:3000")).toEqual({ "Access-Control-Allow-Origin": "http://localhost:3000", Vary: "Origin" });
    expect(cors("https://evil.example")["Access-Control-Allow-Origin"]).toBe("https://cockfight.example");
    expect(cors("null")["Access-Control-Allow-Origin"]).toBe("https://cockfight.example");
    expect(cors()["Access-Control-Allow-Origin"]).toBe("https://cockfight.example");
  });

  it("blocks WebSocket upgrades from foreign browser origins only", async () => {
    expect(await p.beforeUpgrade(req, ctx("https://cockfight.example"))).toBeUndefined();
    expect(await p.beforeUpgrade(req, ctx())).toBeUndefined();
    const denied = await p.beforeUpgrade(req, ctx("https://evil.example"));
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
    expect(((await p.beforeUpgrade(req, ctx("null"))) as Response).status).toBe(403);
  });
});
