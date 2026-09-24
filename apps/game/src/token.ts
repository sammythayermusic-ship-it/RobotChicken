/**
 * Queue tokens: a compact HS256 JWT the gate issues and the queue verifies
 * (5 minutes, spec). Hand-rolled on node:crypto: one algorithm, fixed header,
 * constant-time comparison, no algorithm negotiation to get wrong.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Tier } from "@cockfight/shared";

export const QUEUE_TOKEN_TTL_S = 300;

export interface QueueClaims {
  /** Wallet address. */
  sub: string;
  tier: Tier;
  usd: number;
  /** Rating at gate time (display only). */
  elo: number | null;
  iat: number;
  exp: number;
}

const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

export class QueueTokens {
  private readonly key: Buffer;
  constructor(secret?: string) {
    this.key = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
  }

  sign(c: Omit<QueueClaims, "iat" | "exp">, nowS = Math.floor(Date.now() / 1000)): string {
    const payload = b64url(JSON.stringify({ ...c, iat: nowS, exp: nowS + QUEUE_TOKEN_TTL_S }));
    return `${HEADER}.${payload}.${this.mac(`${HEADER}.${payload}`)}`;
  }

  /** The claims, or null for anything forged, malformed or expired. */
  verify(token: unknown, nowS = Math.floor(Date.now() / 1000)): QueueClaims | null {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== HEADER) return null;
    const want = Buffer.from(this.mac(`${parts[0]}.${parts[1]}`));
    const got = Buffer.from(parts[2] as string);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const c = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as QueueClaims;
      if (typeof c.sub !== "string" || typeof c.exp !== "number" || c.exp <= nowS) return null;
      return c;
    } catch {
      return null;
    }
  }

  private mac(data: string): string {
    return createHmac("sha256", this.key).update(data).digest("base64url");
  }
}
