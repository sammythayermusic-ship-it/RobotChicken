import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import ReplayClient from "./ReplayClient";

export const metadata: Metadata = { title: "Replay · COCKFIGHT" };

export const viewport: Viewport = { themeColor: "#000000", width: "device-width", initialScale: 1, viewportFit: "cover" };

/**
 * Replay page for any finished match: /m/<match id> (rewritten to this static
 * page) or /m?id=<match id>. The match plays back from its input log in the
 * deterministic sim, so it reproduces the fight exactly.
 */
export default function ReplayPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-[#0b0a10]" />}>
      <ReplayClient />
    </Suspense>
  );
}
