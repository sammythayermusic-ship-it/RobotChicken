"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TierBadge } from "@/components/online/OnlineLobby";
import { fetchLeaderboard, type Board, type LeaderRow } from "@/lib/data";

const TABS: { id: Board; label: string }[] = [
  { id: "today", label: "TODAY" },
  { id: "7d", label: "7 DAYS" },
  { id: "all", label: "ALL TIME" },
];

/** Time left until the daily board resets (00:00 UTC). */
function untilMidnightUtc(now: number): string {
  const next = Math.ceil((now + 1) / 86_400_000) * 86_400_000;
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export default function LeaderboardClient() {
  const [board, setBoard] = useState<Board>("today");
  const [data, setData] = useState<{ board: Board; rows: LeaderRow[]; source: string } | { board: Board; error: string } | null>(null);
  // Null while prerendered (the build's clock would never match the browser's): set after mount.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchLeaderboard(board)
        .then((d) => {
          if (!alive) return;
          setData({ board, ...d });
          setNow(Date.now());
        })
        .catch(() => alive && setData({ board, error: "Couldn't load the leaderboard." }));
    void load();
    const id = setInterval(() => {
      void load();
      setNow(Date.now());
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [board]);

  const current = data && data.board === board ? data : null;
  const wins = (r: LeaderRow) => (board === "today" ? [r.winsToday, r.matchesToday] : board === "7d" ? [r.wins7d, r.matches7d] : [r.winsAll, r.matchesAll]);

  return (
    <main className="min-h-dvh bg-[radial-gradient(ellipse_at_top,#3b1d12,#0b0a10_60%)] text-white" data-testid="leaderboard">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-4xl sm:text-5xl">LEADERBOARD</h1>
          <Link href="/play?mode=online" className="rounded-lg bg-amber-400 px-4 py-2 font-display text-black">
            FIGHT
          </Link>
        </div>
        <div role="tablist" className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={board === t.id}
              className={`rounded-md border px-3 py-2 font-display text-sm ${board === t.id ? "border-amber-300 bg-amber-400 text-black" : "border-zinc-600 bg-zinc-900/70 text-zinc-200"}`}
              onClick={() => setBoard(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {board === "today" ? (
          <p className="text-sm text-zinc-400">
            Ranked by wins today (UTC), ties by ELO.{now !== null ? ` Resets in ${untilMidnightUtc(now)}.` : ""} The daily prize pool for the top 10 starts with payouts.
          </p>
        ) : null}
        {!current ? <p className="text-zinc-400">Loading…</p> : null}
        {current && "error" in current ? <p className="text-red-300">{current.error}</p> : null}
        {current && "rows" in current ? (
          current.rows.length === 0 ? (
            <p className="text-zinc-400">No matches yet. Be the first on the board.</p>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="text-xs uppercase tracking-widest text-zinc-400">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Fighter</th>
                  <th className="py-2 pr-2 text-right">Wins</th>
                  <th className="hidden py-2 pr-2 text-right sm:table-cell">Win rate</th>
                  <th className="py-2 text-right">ELO</th>
                </tr>
              </thead>
              <tbody>
                {current.rows.map((r, i) => {
                  const [w, played] = wins(r) as [number, number];
                  return (
                    <tr key={r.id} className="border-t border-zinc-800" data-testid="leaderboard-row">
                      <td className="py-2 pr-2 font-display text-zinc-400">{i + 1}</td>
                      <td className="py-2 pr-2">
                        <span className="mr-2">{r.name}</span>
                        {r.tier ? <TierBadge tier={r.tier} /> : null}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">{w}</td>
                      <td className="hidden py-2 pr-2 text-right font-mono text-zinc-400 sm:table-cell">{played ? `${Math.round((w / played) * 100)}%` : "–"}</td>
                      <td className="py-2 text-right font-mono">{r.elo ?? "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : null}
        {current && "source" in current && current.source === "server" ? (
          <p className="text-xs text-zinc-500">Playtest standings from the game server (reset when it restarts).</p>
        ) : null}
      </div>
    </main>
  );
}
