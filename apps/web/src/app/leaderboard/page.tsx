import type { Metadata } from "next";
import LeaderboardClient from "./LeaderboardClient";

export const metadata: Metadata = { title: "Leaderboard · COCKFIGHT" };

/** Static page; the standings load in the browser (Supabase's public view, or the game server in playtests). */
export default function LeaderboardPage() {
  return <LeaderboardClient />;
}
