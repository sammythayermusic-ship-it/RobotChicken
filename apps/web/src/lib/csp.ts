/**
 * Security headers, built here (not in vercel.json) so `next dev`, `next start`
 * and a Vercel deploy all send exactly the same policy: a CSP that only exists
 * in production is a CSP nobody has tested. Adapted from soltendogs.
 */

export interface CspOptions {
  /** `next dev`: Turbopack HMR and React refresh need eval and any websocket. */
  dev: boolean;
  /** NEXT_PUBLIC_GAME_WS_URL, the Colyseus endpoint (ws:// or wss://). */
  gameWsUrl: string;
  /** NEXT_PUBLIC_SUPABASE_URL: the replay page and leaderboard read its public views. */
  supabaseUrl?: string;
}

/** Cloudflare Turnstile (the bot check before the queue): its script and its widget iframe. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function origin(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? [u.origin] : [];
  } catch {
    return [];
  }
}

const SOCKET_FOR: Record<string, string> = { "ws:": "ws:", "wss:": "wss:", "http:": "ws:", "https:": "wss:" };
const HTTP_FOR: Record<string, string> = { "ws:": "http:", "wss:": "https:", "http:": "http:", "https:": "https:" };

/**
 * The game server's websocket origin plus its http(s) twin: the Colyseus SDK
 * reserves a seat over HTTP (`POST /matchmake/...`) before it opens the socket,
 * so both must be reachable. Paths are dropped; CSP matches origins. A value
 * that is not a ws/http URL contributes nothing rather than failing the build
 * (env.public.ts has already validated it as a URL).
 */
export function gameOrigins(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  const ws = SOCKET_FOR[url.protocol];
  const http = HTTP_FOR[url.protocol];
  if (!ws || !http || !url.host) return [];
  return [`${ws}//${url.host}`, `${http}//${url.host}`];
}

export function buildCsp({ dev, gameWsUrl, supabaseUrl }: CspOptions): string {
  const connect = ["'self'", "blob:", ...gameOrigins(gameWsUrl), ...origin(supabaseUrl), ...(dev ? ["ws:", "wss:"] : [])];
  return [
    "default-src 'self'",
    // 'unsafe-inline': the App Router streams its flight payload through inline
    // <script> tags, and a nonce would need request-time middleware.
    // 'wasm-unsafe-eval': the Draco and Basis decoders compile WebAssembly
    // (WebAssembly only, not JS eval). blob: covers the decoders' worker bootstrap.
    // 'unsafe-eval' is dev-only, for Turbopack HMR and React refresh.
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: ${TURNSTILE_ORIGIN}${dev ? " 'unsafe-eval'" : ""}`,
    // Turnstile renders its challenge in an iframe.
    `frame-src ${TURNSTILE_ORIGIN}`,
    // Tailwind injects a <style> in dev; production inlines critical CSS.
    "style-src 'self' 'unsafe-inline'",
    // GLTFLoader turns embedded glb images into blob: URLs.
    "img-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    // next/font self-hosts its files at build time.
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    // DRACOLoader and KTX2Loader run their decoders in blob: workers.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export interface Header {
  key: string;
  value: string;
}

export function securityHeaders(opts: CspOptions): Header[] {
  return [
    // Report-only until a real session (showcase, fight, wallet, matchmaking)
    // has run clean under it; the e2e smoke test counts violations meanwhile.
    { key: "Content-Security-Policy-Report-Only", value: buildCsp(opts) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Real framing protection while the CSP above only reports.
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Permissions-Policy", value: "microphone=(), camera=(), geolocation=()" },
  ];
}
