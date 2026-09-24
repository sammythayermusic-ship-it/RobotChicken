/**
 * Cloudflare Turnstile server-side check (spec: Turnstile on queue entry).
 * A token is single use and valid for 300 s.
 */
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(secret: string, token: unknown, ip: string | null, f: typeof fetch = fetch): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await f(VERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { success?: boolean };
    return body.success === true;
  } catch {
    return false;
  }
}
