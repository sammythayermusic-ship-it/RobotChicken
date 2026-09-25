import type { NextConfig } from "next";
import { publicEnv } from "./src/env.public";
import { securityHeaders } from "./src/lib/csp";

const dev = process.env.NODE_ENV !== "production";
/**
 * STATIC_EXPORT=1 (scripts/export-static.mjs) builds a plain static site into
 * out/ for test builds on any static host (e.g. Netlify). The local game needs
 * no server; headers then come from out/_headers, which the script writes.
 */
const staticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(staticExport ? { output: "export" as const, trailingSlash: true } : {}),
  // Workspace packages ship TypeScript source with no build step. Turbopack
  // compiles them anyway; this also covers a webpack fallback.
  transpilePackages: ["@cockfight/sim", "@cockfight/shared", "@cockfight/solana", "@cockfight/net"],
  // The floating dev indicator covers the bottom-left of the viewport, where
  // the fight HUD lives.
  devIndicators: false,
  ...(staticExport ? {} : { headers: securityAndCacheHeaders, rewrites: prettyRoutes }),
};

/**
 * /m/<match id> and /p/<address> are served by the static /m and /p pages,
 * which read the id from the address bar. A static export has no rewrites; scripts/export-static.mjs
 * writes the same rule into out/_redirects for Netlify.
 */
async function prettyRoutes() {
  return [
    { source: "/m/:id", destination: "/m" },
    { source: "/p/:address", destination: "/p" },
  ];
}

/** Security headers (src/lib/csp.ts) and cache rules, sent by `next start` and Vercel. */
async function securityAndCacheHeaders() {
  return [
    // connect-src is derived from the same parsed NEXT_PUBLIC_GAME_WS_URL the
    // client inlines at this same build, so the two cannot disagree.
    { source: "/:path*", headers: securityHeaders({ dev, gameWsUrl: publicEnv.NEXT_PUBLIC_GAME_WS_URL, supabaseUrl: publicEnv.NEXT_PUBLIC_SUPABASE_URL }) },
    {
      // scripts/copy-decoders.mjs puts the three.js revision in the path, so
      // these bytes can never change under a given URL.
      source: "/decoders/:rev(r\\d+)/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    },
    {
      // Model names are not content-hashed yet, so always revalidate (a cheap
      // 304) rather than pin a stale glb in browsers for a year.
      source: "/models/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
    },
  ];
}

export default nextConfig;
