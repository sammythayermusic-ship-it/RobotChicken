"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import type { NetSession } from "@/game/net/session";

const REASON: Record<string, string> = {
  ko: "by KO",
  ringout: "by ring-out",
  timeout: "on time",
  sudden_death: "in sudden death",
  decision: "on rounds",
  draw: "",
};

/**
 * What the room says, over the fight: waiting for the opponent to load, a
 * disconnect countdown, and the result card (winner, rating change, replay
 * link, find another match).
 */
export function OnlineOverlay({ session, loading, onRequeue }: { session: NetSession; loading: boolean; onRequeue: () => void }) {
  const s = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const me = session.side;
  const them = me === 0 ? 1 : 0;
  const opp = session.seating.names[them];
  if (loading) return null;

  const banner = (text: string, testid: string) => (
    <div className="pointer-events-none absolute inset-x-0 top-1/3 flex justify-center px-4" data-testid={testid}>
      <p className="rounded-lg bg-black/70 px-5 py-3 text-center font-display text-xl tracking-wide text-white sm:text-2xl">{text}</p>
    </div>
  );

  if (s.status === "over" || s.status === "cancelled" || s.lost) {
    const lost = s.lost && s.status !== "over" && s.status !== "cancelled";
    const cancelled = s.status === "cancelled" || lost;
    const won = s.winner === me;
    const draw = s.winner === 2;
    const title = lost ? "CONNECTION LOST" : cancelled ? "MATCH OFF" : draw ? "DRAW" : won ? "YOU WIN" : "YOU LOSE";
    const how = lost
      ? "You were disconnected from the match."
      : cancelled
      ? s.reason
      : s.reason === "forfeit"
        ? won
          ? `${opp} left the match`
          : "you left the match"
        : REASON[s.reason] ?? "";
    const seat = s.seats[me];
    return (
      <div className="online-result absolute inset-x-0 bottom-0 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" data-testid="online-result">
        <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-zinc-700 bg-zinc-950/90 p-5 text-center shadow-2xl">
          <p className={`font-display text-4xl ${won ? "text-amber-300" : "text-white"}`} data-testid="online-result-title">
            {title}
          </p>
          {how ? <p className="text-zinc-300">{how}</p> : null}
          {!cancelled && seat.elo > 0 ? (
            <p className="font-mono text-sm text-zinc-400" data-testid="online-elo">
              {s.recorded ? (
                <>
                  ELO {seat.elo + seat.eloDelta}{" "}
                  <span className={seat.eloDelta >= 0 ? "text-lime-300" : "text-red-300"}>
                    ({seat.eloDelta >= 0 ? "+" : ""}
                    {seat.eloDelta})
                  </span>
                </>
              ) : (
                "saving the result…"
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              autoFocus
              data-testid="find-another"
              className="rounded-lg bg-gradient-to-b from-orange-400 to-red-600 px-5 py-3 font-display text-lg tracking-wider shadow-[0_4px_0_#7c2d12]"
              onClick={onRequeue}
            >
              FIND ANOTHER MATCH
            </button>
            {!cancelled && s.recorded ? (
              <Link href={`/m/${session.matchId}`} className="rounded-lg border border-zinc-500 px-5 py-3 font-display text-lg" data-testid="replay-link">
                REPLAY
              </Link>
            ) : null}
            <Link href="/" className="rounded-lg border border-zinc-700 px-5 py-3 font-display text-lg text-zinc-300">
              HOME
            </Link>
          </div>
        </div>
      </div>
    );
  }
  if (s.reconnecting) return banner("RECONNECTING…", "online-reconnecting");
  if (s.status === "paused") return banner(`${opp} LOST CONNECTION · ${s.pauseLeft}s`, "online-paused");
  if (s.status === "waiting") return banner(`WAITING FOR ${opp.toUpperCase()}…`, "online-waiting");
  return null;
}
