/**
 * Cloudflare Turnstile server-side check (spec: Turnstile on queue entry).
 * A token is single use and valid for 300 s.
 */
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's documented always-pass test secret (dev and tests only). */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

/**
 * `hosts`: when given, the widget must have been solved on one of these
 * hostnames (a token solved on some other site that embeds our site key
 * doesn't count).
 */
export async function verifyTurnstile(
  secret: string,
  token: unknown,
  ip: string | null,
  f: typeof fetch = fetch,
  hosts?: readonly string[],
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await f(VERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { success?: boolean; hostname?: string };
    if (body.success !== true) return false;
    return !hosts || hosts.length === 0 || (typeof body.hostname === "string" && hosts.includes(body.hostname));
  } catch {
    return false;
  }
}
