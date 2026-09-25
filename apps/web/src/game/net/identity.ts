/**
 * What this browser remembers between visits: the playtest name and guest
 * id, the last wallet pasted, and the last queue token (5 minutes; lets
 * "find another match" skip the bot check). Browser storage can be missing or
 * throw (private windows, blocked storage), so every access is guarded and
 * the game works without it.
 */
const KEYS = { name: "cf.name", guest: "cf.guest", wallet: "cf.wallet", token: "cf.token" } as const;

function read(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}

function write(k: string, v: string | null): void {
  try {
    if (v === null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch {
    // no storage: nothing is remembered
  }
}

export const savedName = () => read(KEYS.name) ?? "";
export const saveName = (n: string) => write(KEYS.name, n);
export const savedWallet = () => read(KEYS.wallet) ?? "";
export const saveWallet = (w: string) => write(KEYS.wallet, w);

/** A random id that keeps one ticket per browser in the open queue. */
export function guestId(): string {
  const have = read(KEYS.guest);
  if (have && /^[A-Za-z0-9_-]{8,40}$/.test(have)) return have;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  write(KEYS.guest, id);
  return id;
}

export interface SavedToken {
  token: string;
  address: string;
  tier: string;
  usd: number;
  /** The claimed username, when the wallet has one. */
  name?: string | null;
}

export function saveToken(t: SavedToken | null): void {
  write(KEYS.token, t ? JSON.stringify(t) : null);
}

/** The last queue token if it still has at least `minLeftS` seconds (read from its payload). */
export function savedToken(minLeftS = 30): SavedToken | null {
  const raw = read(KEYS.token);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as SavedToken;
    const payload = JSON.parse(atob(t.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    if (typeof payload.exp !== "number" || payload.exp - Date.now() / 1000 < minLeftS) return null;
    return t;
  } catch {
    return null;
  }
}
