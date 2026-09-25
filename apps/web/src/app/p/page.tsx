import type { Metadata } from "next";
import { Suspense } from "react";
import ProfileClient from "./ProfileClient";

export const metadata: Metadata = { title: "Fighter · COCKFIGHT" };

/** A wallet's profile: /p/<address> (rewritten to this static page) or /p?address=<address>. */
export default function ProfilePage() {
  return (
    <Suspense fallback={<main className="min-h-dvh" />}>
      <ProfileClient />
    </Suspense>
  );
}
