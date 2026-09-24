"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { WebGLRenderer } from "three";
import { resultHash } from "@cockfight/net";
import { RULES, runReplay } from "@cockfight/sim";
import FightHud from "@/components/hud/FightHud";
import { TierBadge } from "@/components/online/OnlineLobby";
import { defaultTier, loadTier } from "@/game/engine/quality";
import { HudStore } from "@/game/hud/hudStore";
import { UUID, fetchMatch, type MatchView } from "@/lib/data";
import "../play/play.css";

const FightCanvas = dynamic(() => import("@/game/react/FightCanvas"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center font-display text-zinc-400">LOADING…</div>,
});

const buildJunkyard = (renderer: WebGLRenderer) => import("@/game/view/arena/Junkyard").then((m) => m.createJunkyard(renderer));

const REASON: Record<string, string> = {
  ko: "by KO",
  ringout: "by ring-out",
  timeout: "on time",
  sudden_death: "in sudden death",
  decision: "on rounds",
  forfeit: "by forfeit",
  draw: "",
};

type Verify = { replay: boolean; result: boolean; rules: boolean };

/** The match id from /m/<id> (rewritten here) or /m?id=<id>. */
function useMatchId(): string | null {
  const sp = useSearchParams();
  const fromQuery = sp.get("id");
  const [fromPath, setFromPath] = useState<string | null>(null);
  useEffect(() => {
    const seg = window.location.pathname.split("/").filter(Boolean);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address bar is only readable after mount
    if (seg[0] === "m" && seg[1]) setFromPath(decodeURIComponent(seg[1]));
  }, []);
  return fromPath ?? fromQuery;
}

export default function ReplayClient() {
  const id = useMatchId();
  const sp = useSearchParams();
  const manual = sp.get("manual") === "1";
  const debug = sp.get("debug") === "1";
  const arena = sp.get("arena") !== "0";
  const [state, setState] = useState<{ kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready"; m: MatchView }>({
    kind: "loading",
  });
  const [verify, setVerify] = useState<Verify | null>(null);
  const [take, setTake] = useState(0);
  const hud = useMemo(() => new HudStore(), []);

  useEffect(() => {
    if (id === null) return;
    let alive = true;
    if (!UUID.test(id)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- derived from the address bar, once
      setState({ kind: "missing" });
      return;
    }
    fetchMatch(id)
      .then(async (m) => {
        if (!alive) return;
        if (!m) {
          setState({ kind: "missing" });
          return;
        }
        setState({ kind: "ready", m });
        if (debug) {
          const w = window as unknown as { __cockfight?: Record<string, unknown> };
          w.__cockfight = { ...(w.__cockfight ?? {}), replay: { ticks: m.replay.ticks, finalHash: m.replay.finalHash, winnerSide: m.winnerSide, reason: m.reason } };
        }
        // Re-run the whole match headless and check it against what the server stored.
        const rulesOk = m.replay.rulesHash === RULES.hash;
        const out = rulesOk ? runReplay(m.replay) : null;
        const hash = await resultHash(m.id, m.winnerAddress, m.inputLog);
        if (alive) setVerify({ rules: rulesOk, replay: out?.hash === m.replay.finalHash, result: hash === m.resultHash });
      })
      .catch((e: unknown) => alive && setState({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load the match." }));
    return () => {
      alive = false;
    };
  }, [id, debug]);

  const quality = useMemo(() => (typeof window === "undefined" ? "high" : loadTier(defaultTier(window.matchMedia?.("(pointer: coarse)").matches ?? false))), []);

  if (state.kind !== "ready") {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#0b0a10] p-6 text-center text-white" data-testid="replay-page">
        <div className="flex flex-col items-center gap-4">
          <p className="font-display text-2xl text-zinc-300" data-testid="replay-status">
            {state.kind === "loading" ? "LOADING REPLAY…" : state.kind === "missing" ? "NO SUCH MATCH" : state.message}
          </p>
          <Link href="/play" className="rounded-lg bg-amber-400 px-5 py-3 font-display text-black">
            FIGHT
          </Link>
        </div>
      </main>
    );
  }

  const m = state.m;
  const winner = m.winnerSide === null ? "Draw" : `${m.names[m.winnerSide]} wins ${REASON[m.reason] ?? ""}`.trim();
  const ok = verify && verify.rules && verify.replay && verify.result;
  return (
    <main className="fight-screen fixed inset-0 touch-none overflow-hidden bg-black text-white" data-testid="replay-page">
      <div className="fight-area" data-testid="fight-area">
        {verify?.rules === false ? (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-zinc-300">
            This match was played on an older version of the game and can&apos;t be replayed with today&apos;s rules.
          </div>
        ) : (
          <FightCanvas
            key={`${m.id}-${take}`}
            className="absolute inset-0 touch-none select-none"
            options={{
              mode: "replay",
              replay: m.replay,
              difficulty: "normal",
              tiers: m.tiers,
              matchId: `${m.id}#${take}`,
              names: m.names,
              hud,
              quality,
              shake: 1,
              manual,
              debug,
              arena: arena ? buildJunkyard : undefined,
            }}
          />
        )}
        <FightHud store={hud} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="pointer-events-auto flex max-w-2xl flex-wrap items-center justify-center gap-2 rounded-xl bg-black/70 px-4 py-2 text-sm">
          <span className="font-display text-amber-300" data-testid="replay-result">
            {winner}
          </span>
          <TierBadge tier={m.tiers[0]} />
          <span className="text-zinc-300">vs</span>
          <TierBadge tier={m.tiers[1]} />
          <span
            className={`rounded-full border px-2 py-0.5 text-xs ${ok ? "border-lime-400 text-lime-300" : verify ? "border-red-400 text-red-300" : "border-zinc-600 text-zinc-400"}`}
            data-testid="replay-verified"
            data-ok={ok ? "1" : verify ? "0" : ""}
            title="The match re-simulated from its input log reaches the exact final state the server recorded, and the result hash matches."
          >
            {ok ? "✓ verified" : verify ? "✗ doesn't verify" : "verifying…"}
          </span>
          <button type="button" className="rounded border border-zinc-500 px-3 py-1 font-display" onClick={() => setTake((t) => t + 1)}>
            WATCH AGAIN
          </button>
          <Link href="/play?mode=online" className="rounded bg-amber-400 px-3 py-1 font-display text-black">
            FIGHT
          </Link>
        </div>
      </div>
    </main>
  );
}
