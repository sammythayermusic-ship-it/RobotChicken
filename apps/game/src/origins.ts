/**
 * Browser origin policy for the two browser-facing entry points: the HTTP
 * matchmaking endpoint (CORS) and the WebSocket upgrade (Origin check).
 *
 * This keeps other websites from using a visitor's browser to reach the game
 * server. It is not authentication: a non-browser client can send any Origin
 * or none. Phase 2 adds the queue JWT for that.
 */
import type { BeforeUpgradeHandler } from "@colyseus/core";

export interface OriginPolicy {
  /** Normalized allowlist (scheme://host[:port]). */
  readonly allowed: ReadonlySet<string>;
  /** True when a request carrying this Origin header value may proceed. */
  allows(origin: string | null): boolean;
  /**
   * Replacement for Colyseus' `matchMaker.controller.getCorsHeaders`. Colyseus
   * merges this over its defaults (whose Allow-Origin is `*`), so it must always
   * return Allow-Origin: an allowed origin is echoed, anything else gets the
   * first allowed origin, which the browser then rejects as a mismatch. It is
   * never `*` (the SDK sends credentials) and never `null` (sandboxed iframes
   * and file:// pages send `Origin: null`).
   */
  corsHeaders(headers: Headers): Record<string, string>;
  /**
   * WebSocket `beforeUpgrade` hook: 403 for a browser Origin outside the
   * allowlist. No Origin (Node clients, curl) passes, because CORS-style checks
   * only constrain browsers.
   */
  beforeUpgrade: BeforeUpgradeHandler;
}

/**
 * Parse ALLOWED_ORIGINS entries into origins. Throws on anything that is not
 * a bare http(s) origin, so a typo fails at boot instead of silently locking
 * the web client out. A trailing slash is accepted and dropped.
 */
export function parseAllowedOrigins(entries: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of entries) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`ALLOWED_ORIGINS: "${raw}" is not a URL (expected e.g. https://cockfight.example)`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`ALLOWED_ORIGINS: "${raw}" must be http:// or https://`);
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error(`ALLOWED_ORIGINS: "${raw}" must be a bare origin (scheme://host[:port]) with no path`);
    }
    out.add(url.origin);
  }
  if (out.size === 0) throw new Error("ALLOWED_ORIGINS: at least one origin is required");
  return out;
}

export function originPolicy(entries: readonly string[]): OriginPolicy {
  const allowed = parseAllowedOrigins(entries);
  const fallback = allowed.values().next().value as string;
  const allows = (origin: string | null): boolean => origin !== null && allowed.has(origin);

  return {
    allowed,
    allows,
    corsHeaders(headers) {
      const origin = headers.get("origin");
      return {
        "Access-Control-Allow-Origin": allows(origin) ? (origin as string) : fallback,
        // The response depends on the request's Origin; keep caches from mixing them up.
        Vary: "Origin",
      };
    },
    beforeUpgrade(_request, context) {
      // Read the raw upgrade headers, not the synthesized Request's, which a
      // fetch implementation may filter (Origin is a forbidden header name).
      const origin = context.headers.get("origin");
      if (origin !== null && !allowed.has(origin)) {
        return new Response("origin not allowed", { status: 403, headers: { "content-type": "text/plain" } });
      }
      return undefined;
    },
  };
}
