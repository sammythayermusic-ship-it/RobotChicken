/**
 * Usernames are claimed with a signed message, so a pasted address can't
 * take (or rename) someone else's name (spec; docs/decisions.md). Two steps:
 *
 *   POST /username/nonce {address}            → {nonce, message}
 *   POST /username {address, name, nonce, signature}
 *
 * The wallet signs `cockfight:claim:<nonce>:<name>` (the name is inside the
 * signed text, so a signature can't be reused for another name). Nonces are
 * stateless: an HMAC over the address and an expiry, 5 minutes.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { isWalletAddress } from "@cockfight/solana";
import { PermanentError, type SupabaseStore } from "./results";

export const NONCE_TTL_S = 300;
export const USERNAME = /^[A-Za-z0-9_]{3,16}$/;

export type UsernameResponse = { status: 200; body: Record<string, unknown> } | { status: 400 | 401 | 403 | 409 | 429 | 503; body: { ok: false; error: string; message: string } };

const fail = (status: 400 | 401 | 403 | 409 | 429 | 503, error: string, message: string): UsernameResponse => ({ status, body: { ok: false, error, message } });

export function claimMessage(nonce: string, name: string): string {
  return `cockfight:claim:${nonce}:${name}`;
}

export class UsernameService {
  private readonly key: Buffer;
  private readonly db: SupabaseStore | null;
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(secret: string | undefined, db: SupabaseStore | null, now: () => number = Date.now) {
    this.key = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
    this.db = db;
    this.now = now;
  }

  nonce(body: unknown): UsernameResponse {
    if (!this.db) return fail(503, "not_configured", "Usernames need the database (ranked mode).");
    const address = field(body, "address");
    if (!isWalletAddress(address)) return fail(400, "address", "That isn't a Solana wallet address.");
    const exp = Math.floor(this.now() / 1000) + NONCE_TTL_S;
    const nonce = `${exp}.${this.mac(address, exp)}`;
    return { status: 200, body: { ok: true, nonce, expiresAt: exp, messageTemplate: claimMessage(nonce, "<name>") } };
  }

  async claim(body: unknown, ip: string | null): Promise<UsernameResponse> {
    if (!this.db) return fail(503, "not_configured", "Usernames need the database (ranked mode).");
    if (!this.allow(ip ?? "?")) return fail(429, "slow_down", "Too many attempts. Wait a minute.");
    const address = field(body, "address");
    const name = field(body, "name");
    const nonce = field(body, "nonce");
    const signature = field(body, "signature");
    if (!isWalletAddress(address)) return fail(400, "address", "That isn't a Solana wallet address.");
    if (!USERNAME.test(name)) return fail(400, "name", "Names are 3-16 letters, digits or underscores.");
    if (!this.nonceValid(address, nonce)) return fail(401, "nonce", "That nonce is missing or expired: ask for a new one.");
    if (!verifySignature(address, claimMessage(nonce, name), signature)) return fail(403, "signature", "The signature doesn't match the wallet.");
    try {
      await this.db.claimUsername(address, name, signature);
    } catch (e) {
      if (e instanceof PermanentError) return fail(409, "taken", "That name is taken.");
      console.warn("[username] claim failed:", e instanceof Error ? e.message : e);
      return fail(503, "db", "Couldn't save the name right now. Try again in a moment.");
    }
    return { status: 200, body: { ok: true, address, name } };
  }

  private nonceValid(address: string, nonce: string): boolean {
    const [expS, mac] = nonce.split(".");
    const exp = Number(expS);
    if (!Number.isInteger(exp) || !mac || exp <= Math.floor(this.now() / 1000)) return false;
    const want = Buffer.from(this.mac(address, exp));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private mac(address: string, exp: number): string {
    return createHmac("sha256", this.key).update(`nonce:${address}:${exp}`).digest("base64url");
  }

  /** 10 claims per IP per minute. */
  private allow(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) return false;
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= 60_000)) this.hits.delete(k);
    return true;
  }
}

/** ed25519 over the UTF-8 message; the signature base58 (as wallets return it) or base64. */
export function verifySignature(address: string, message: string, signature: string): boolean {
  let sig: Uint8Array;
  try {
    sig = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) ? bs58.decode(signature) : Uint8Array.from(Buffer.from(signature, "base64"));
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, new TextEncoder().encode(message), bs58.decode(address));
  } catch {
    return false;
  }
}

function field(body: unknown, key: string): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const v = b[key];
  return typeof v === "string" ? v.trim() : "";
}
