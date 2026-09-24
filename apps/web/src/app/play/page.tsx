import type { Metadata } from "next";
import { Suspense } from "react";
import PlayFromUrl from "./PlayFromUrl";

export const metadata: Metadata = { title: "Fight · COCKFIGHT" };

/** Static page: the URL options (mode, difficulty, tier, bench, ...) are read in the browser. */
export default function PlayPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-[#0b0a10]" />}>
      <PlayFromUrl />
    </Suspense>
  );
}
