import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Play" };

/** Phase 0 stub: the local fighter (vs CPU and 2P on one keyboard) replaces this in Phase 1. */
export default function PlayPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="chrome-text font-display text-5xl sm:text-7xl">THE PIT</h1>
      <p className="max-w-md text-lg text-ash">
        The local fighter lands in Phase 1: vs CPU, or two players on one keyboard.
      </p>
      <Link href="/" className="font-semibold text-neon-cyan underline-offset-4 hover:underline">
        Back to the yard
      </Link>
    </main>
  );
}
