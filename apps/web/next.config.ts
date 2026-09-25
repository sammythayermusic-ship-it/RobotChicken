import type { NextConfig } from "next";
import { publicEnv } from "./src/env.public";
import { securityHeaders } from "./src/lib/csp";

const dev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source with no build step. Turbopack
  // compiles them anyway; this also covers a webpack fallback.
  transpilePackages: ["@cockfight/sim", "@cockfight/shared", "@cockfight/solana"],
  // The floating dev indicator covers the bottom-left of the viewport, where
  // the fight HUD lives.
  devIndicators: false,
  async headers() {
    return [
      // connect-src is derived from the same parsed NEXT_PUBLIC_GAME_WS_URL the
      // client inlines at this same build, so the two cannot disagree.
      { source: "/:path*", headers: securityHeaders({ dev, gameWsUrl: publicEnv.NEXT_PUBLIC_GAME_WS_URL }) },
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
  },
};

export default nextConfig;
