import { describe, expect, it } from "vitest";
import { loadWebPublicEnv } from "@cockfight/shared/env";
import { buildCsp, gameOrigins, securityHeaders } from "./csp";

/** Directive name -> source list, asserting each directive appears once. */
function parse(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    expect(out.has(name), `duplicate directive ${name}`).toBe(false);
    out.set(name, sources);
  }
  return out;
}

describe("gameOrigins", () => {
  it("pairs the socket origin with its http twin for matchmaking", () => {
    expect(gameOrigins("ws://localhost:2567")).toEqual(["ws://localhost:2567", "http://localhost:2567"]);
    expect(gameOrigins("wss://cockfight-game.fly.dev")).toEqual(["wss://cockfight-game.fly.dev", "https://cockfight-game.fly.dev"]);
  });

  it("accepts an http(s) endpoint and drops paths, queries and credentials", () => {
    expect(gameOrigins("https://user:pw@game.example.com:8443/colyseus?x=1")).toEqual([
      "wss://game.example.com:8443",
      "https://game.example.com:8443",
    ]);
  });

  it("contributes nothing for malformed or non-network URLs", () => {
    expect(gameOrigins("not a url")).toEqual([]);
    expect(gameOrigins("")).toEqual([]);
    expect(gameOrigins("javascript:alert(1)")).toEqual([]);
    expect(gameOrigins("file:///etc/passwd")).toEqual([]);
  });
});

describe("buildCsp", () => {
  const gameWsUrl = "wss://cockfight-game.fly.dev";

  it("production: WebAssembly allowed, no eval, no wildcard sockets", () => {
    const d = parse(buildCsp({ dev: false, gameWsUrl }));
    expect(d.get("script-src")).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "blob:"]);
    expect(d.get("connect-src")).toEqual(["'self'", "blob:", "wss://cockfight-game.fly.dev", "https://cockfight-game.fly.dev"]);
    expect(d.get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("dev: adds eval for HMR and any websocket", () => {
    const d = parse(buildCsp({ dev: true, gameWsUrl }));
    expect(d.get("script-src")).toContain("'unsafe-eval'");
    expect(d.get("connect-src")?.slice(-2)).toEqual(["ws:", "wss:"]);
  });

  it("locks down the rest", () => {
    const d = parse(buildCsp({ dev: false, gameWsUrl }));
    expect(d.get("default-src")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("frame-ancestors")).toEqual(["'self'"]);
    expect(d.get("img-src")).toEqual(["'self'", "blob:", "data:"]);
    expect(d.get("font-src")).toEqual(["'self'", "data:"]);
  });

  it("with zero env vars, allows the same game server the client defaults to", () => {
    const env = loadWebPublicEnv({});
    const d = parse(buildCsp({ dev: false, gameWsUrl: env.NEXT_PUBLIC_GAME_WS_URL }));
    expect(d.get("connect-src")).toEqual(["'self'", "blob:", "ws://localhost:2567", "http://localhost:2567"]);
  });
});

describe("securityHeaders", () => {
  it("ships the CSP report-only, plus the enforcing basics", () => {
    const h = new Map(securityHeaders({ dev: false, gameWsUrl: "ws://localhost:2567" }).map((x) => [x.key, x.value]));
    expect(h.has("Content-Security-Policy")).toBe(false);
    expect(h.get("Content-Security-Policy-Report-Only")).toContain("default-src 'self'");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("Permissions-Policy")).toBe("microphone=(), camera=(), geolocation=()");
  });
});
