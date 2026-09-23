import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NetProbe } from "./NetProbe";

export const metadata: Metadata = { title: "dev/net", robots: { index: false } };

/** Dev-only connectivity probe for the Colyseus game server. Production builds 404. */
export default function DevNetPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="font-display text-2xl text-chrome">dev / net</h1>
      <p className="mt-2 text-sm text-ash">
        Joins the <code className="font-mono">fight</code> room and shows its tick and phase as patches arrive. Start the
        server with <code className="font-mono">pnpm dev</code> at the repo root.
      </p>
      <NetProbe />
    </main>
  );
}
