/**
 * Anti-abuse identities (spec: caps are tied to fingerprint and IP as well
 * as the wallet; the queue never pairs two tickets sharing an IP /24 or a
 * fingerprint). Only salted hashes leave this module: the database and the
 * logs never see an IP or a raw fingerprint.
 */
import { createHmac, randomBytes } from "node:crypto";

export class AbuseIds {
  private readonly key: Buffer;
  constructor(salt?: string) {
    // Unsalted in dev is fine; in production the salt comes from QUEUE_JWT_SECRET
    // (or ANTI_ABUSE_SALT), so the hashes stay stable across restarts and the
    // daily caps keep counting.
    this.key = salt ? Buffer.from(salt, "utf8") : randomBytes(32);
  }

  /** The IP's /24 (IPv4) or /64 (IPv6), hashed. Null when the IP is unknown or private (local dev, tests: everyone is 127.0.0.1). */
  ip(ip: string | null | undefined): string | null {
    const bucket = ipNetwork(ip);
    return bucket && !isPrivate(ip as string) ? this.mac("ip", bucket) : null;
  }

  /** The browser's fingerprint (a stable random id the web app keeps), hashed. Null when absent or malformed. */
  fingerprint(fp: unknown): string | null {
    if (typeof fp !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(fp)) return null;
    return this.mac("fp", fp);
  }

  private mac(kind: string, value: string): string {
    return createHmac("sha256", this.key).update(`${kind}:${value}`).digest("hex").slice(0, 32);
  }
}

/** Loopback and RFC 1918 / ULA ranges: never a real client on Fly. */
export function isPrivate(ip: string): boolean {
  const t = ip.trim().toLowerCase();
  if (t === "::1" || t.startsWith("fc") || t.startsWith("fd") || t.startsWith("fe80")) return true;
  const v4 = /^(\d+)\.(\d+)\./.exec(t);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** "1.2.3.0/24" for IPv4, the /64 for IPv6, null for anything else. */
export function ipNetwork(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.trim());
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) {
    const head = ip.split("::")[0] ?? "";
    const parts = head.split(":").filter(Boolean);
    return `${parts.slice(0, 4).join(":")}::/64`;
  }
  return null;
}
