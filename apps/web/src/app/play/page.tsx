import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import PlayFromUrl from "./PlayFromUrl";

export const metadata: Metadata = { title: "Fight · COCKFIGHT" };

/**
 * The fight runs edge to edge on phones (under the notch and the home bar);
 * the fight screen keeps its HUD and buttons inside the safe area itself
 * (play.css). Pinch zoom stays allowed by the viewport: the fight screen
 * turns it off with touch-action instead.
 */
export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/** Static page: the URL options (mode, difficulty, tier, bench, ...) are read in the browser. */
export default function PlayPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-[#0b0a10]" />}>
      <PlayFromUrl />
    </Suspense>
  );
}
