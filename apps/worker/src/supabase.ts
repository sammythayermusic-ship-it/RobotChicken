/** Headers for the Data API. New secret keys (sb_secret_…) go in apikey only; legacy JWT keys also as a bearer token. */
export function supabaseHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) h.authorization = `Bearer ${key}`;
  return h;
}
