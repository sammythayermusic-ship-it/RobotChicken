"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { WebGLRenderer } from "three";
import { RULES, runReplay, type CpuLevel, type Replay } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import FightHud from "@/components/hud/FightHud";
import { useHud } from "@/components/hud/useHud";
import { createAudio, type GameAudio } from "@/game/audio";
import type { FightEngine, FightMode } from "@/game/engine/createFightEngine";
import { defaultTier, loadTier, saveTier, type QualityTier } from "@/game/engine/quality";
import { HudStore } from "@/game/hud/hudStore";
import { BenchPanel } from "./BenchPanel";
import { ModePicker, type PlayConfig } from "./ModePicker";

const FightCanvas = dynamic(() => import("@/game/react/FightCanvas"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center font-display text-zinc-400">LOADING…</div>,
});

/**
 * Builds the junkyard arena for a fight. Module scope on purpose: an inline
 * arrow in PlayClient would share the render's closure scope, which also
 * holds the `engine` state (the previous fight), so every engine would keep
 * the one before it alive, canvas and WebGL context included.
 */
const buildJunkyard = (renderer: WebGLRenderer) => import("@/game/view/arena/Junkyard").then((m) => m.createJunkyard(renderer));

/**
 * Events that can carry the user activation audio needs. A browser grants it
 * on keydown (but not Esc), a mouse press and a tap's release; pointerup and
 * click come after a mouse press, when the activation is already there.
 */
const GESTURES = ["keydown", "pointerup", "click"] as const;

export interface PlayParams {
  mode: FightMode | null;
  difficulty: CpuLevel;
  tier: Tier;
  seed: string | null;
  manual: boolean;
  debug: boolean;
  fps: boolean;
  bench: boolean;
  quality: QualityTier | null;
  arena: boolean;
}

type ActiveConfig = Omit<PlayConfig, "mode"> & { mode: FightMode };

const noSubscribe = () => () => {};
/** Stored quality choice, else by pointer type (client only; "high" while server rendering). */
function useDefaultQuality(): QualityTier {
  return useSyncExternalStore(
    noSubscribe,
    () => loadTier(defaultTier(window.matchMedia?.("(pointer: coarse)").matches ?? false)),
    () => "high",
  );
}
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    () => false,
  );
}

export default function PlayClient({ params }: { params: PlayParams }) {
  const autostart = params.mode !== null;
  // Autostart links (/play?mode=cpu) have no FIGHT click to start audio. e2e
  // runs (manual) stay silent, and so does a bench, so that its frame times
  // never include audio work.
  const autoAudio = autostart && !params.manual && !params.bench;
  const [cfg, setCfg] = useState<ActiveConfig | null>(
    autostart ? { mode: params.mode as FightMode, difficulty: params.difficulty, tier: params.tier } : null,
  );
  const [round, setRound] = useState(0);
  const [engine, setEngine] = useState<FightEngine | null>(null);
  const defaultQuality = useDefaultQuality();
  const reducedMotion = useReducedMotion();
  const [chosenQuality, setQuality] = useState<QualityTier | null>(params.quality);
  const quality = chosenQuality ?? defaultQuality;
  const [muted, setMuted] = useState(false);
  const [chosenShake, setShake] = useState<number | null>(null);
  const shake = chosenShake ?? (reducedMotion ? 0.3 : 1);
  const audio = useRef<GameAudio | null>(null);
  const audioStart = useRef<Promise<GameAudio | null> | null>(null);
  // Latest values for callbacks that finish later (audio creation).
  const engineRef = useRef<FightEngine | null>(null);
  const mutedRef = useRef(muted);
  useEffect(() => {
    engineRef.current = engine;
    mutedRef.current = muted;
  });
  const hud = useMemo(() => new HudStore(), []);

  // Debug: expose the sim's replay runner so e2e can check determinism in every browser engine.
  useEffect(() => {
    if (!params.debug) return;
    const w = window as unknown as { __cockfight?: Record<string, unknown> };
    w.__cockfight = {
      ...(w.__cockfight ?? {}),
      sim: { rulesHash: RULES.hash, run: (r: Replay) => {
        const res = runReplay(r);
        return { hash: res.hash, ticks: res.ticks };
      } },
    };
  }, [params.debug]);
  const cold = useHud(hud);

  useEffect(() => engine?.setQuality(quality), [engine, quality]);
  useEffect(() => engine?.setShake(shake), [engine, shake]);

  /**
   * Creates the audio once; later calls share it. createAudio builds the
   * AudioContext synchronously, so called from a gesture it starts at once.
   */
  const getAudio = useCallback((): Promise<GameAudio | null> => {
    if (audioStart.current) return audioStart.current;
    const p: Promise<GameAudio | null> = createAudio()
      .catch(() => null)
      .then((a) => {
        // The page let go of it meanwhile (unmounted).
        if (audioStart.current !== p) {
          a?.dispose();
          return null;
        }
        audio.current = a;
        if (a) {
          a.setMuted(mutedRef.current);
          const e = engineRef.current;
          if (e) {
            void e.ready.then(() => {
              if (engineRef.current === e) e.setAudio(a);
            });
          }
        }
        return a;
      });
    audioStart.current = p;
    return p;
  }, []);
  useEffect(
    () => () => {
      audio.current?.dispose();
      audio.current = null;
      audioStart.current = null;
    },
    [],
  );

  useEffect(() => {
    // The engine's director exists only once it is ready (model loaded), so attach then.
    const a = audio.current;
    if (!engine || !a) return;
    let live = true;
    void engine.ready.then(() => {
      if (live) engine.setAudio(a);
    });
    return () => {
      live = false;
    };
  }, [engine]);
  useEffect(() => audio.current?.setMuted(muted), [muted]);

  // Autostart links: create the audio right away, under LOADING, where the
  // AudioContext constructor's ~130 ms stall does not show (on a first key
  // press it froze the fight for about 8 frames). With no gesture yet the
  // context waits suspended.
  useEffect(() => {
    if (autoAudio) void getAudio();
  }, [autoAudio, getAudio]);

  // ...and the first real gesture starts it. Esc, or a touch's pointerdown,
  // carries no user activation, so listening only once would leave the
  // context suspended for the whole session: keep listening until it runs.
  useEffect(() => {
    if (!engine || !autoAudio || audio.current?.running) return;
    const unlock = () => {
      const a = audio.current;
      if (!a) {
        void getAudio();
        return;
      }
      if (a.running) off();
      else
        void a.resume().then((ok) => {
          if (ok) off();
        });
    };
    const off = () => {
      for (const t of GESTURES) window.removeEventListener(t, unlock, true);
    };
    for (const t of GESTURES) window.addEventListener(t, unlock, true);
    return off;
  }, [engine, autoAudio, getAudio]);

  const uiSound = useCallback((name: "pause" | "ui_select" | "ui_back") => audio.current?.play(name), []);

  const start = useCallback(
    async (c: PlayConfig) => {
      // The FIGHT click is a user gesture: create the audio here (it starts
      // at once), or wake a context that is still suspended.
      const a = audio.current;
      if (a) void a.resume();
      else await getAudio();
      setCfg(c);
      setRound((r) => r + 1);
    },
    [getAudio],
  );

  const matchId = useMemo(
    () => (params.seed ? `${params.seed}-${round}` : `local-${round}-${cfg?.mode ?? "x"}-${Math.floor(performance.timeOrigin % 1e9)}`),
    [params.seed, round, cfg?.mode],
  );

  const togglePause = useCallback(() => {
    const c = hud.get();
    if (!engine || c.matchWinner >= 0 || c.loading) return;
    if (engine.paused) {
      uiSound("ui_select");
      engine.resume();
    } else {
      uiSound("pause");
      engine.pause();
    }
  }, [engine, hud, uiSound]);

  /**
   * The next fight (REMATCH, RESTART, R). One per press: until the new fight
   * has loaded, more presses (a held R's key repeat, a double click) do nothing.
   */
  const rematch = useCallback(() => {
    if (hud.get().loading) return;
    hud.set({ loading: true });
    setRound((r) => r + 1);
  }, [hud]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!cfg) return;
      if (e.code === "Escape" || e.code === "KeyP") {
        e.preventDefault();
        if (!e.repeat) togglePause();
      }
      // Read the store, not a render's snapshot: it is current even between a press and the re-render.
      if (e.code === "KeyR" && !e.repeat && hud.get().matchWinner >= 0) rematch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cfg, togglePause, rematch, hud]);

  if (!cfg) {
    return (
      <main className="min-h-dvh bg-[radial-gradient(ellipse_at_top,#3b1d12,#0b0a10_60%)] text-white">
        <ModePicker initial={{ mode: "cpu", difficulty: params.difficulty, tier: params.tier }} onStart={start} />
      </main>
    );
  }

  const tiers: [Tier, Tier] = [cfg.tier, cfg.mode === "2p" ? cfg.tier : "rust"];
  return (
    <main className="fixed inset-0 overflow-hidden overscroll-none bg-black text-white" data-testid="fight-screen">
      <FightCanvas
        key={matchId}
        className="absolute inset-0 touch-none select-none"
        onEngine={setEngine}
        options={{
          mode: cfg.mode,
          difficulty: cfg.difficulty,
          tiers,
          matchId,
          hud,
          quality,
          shake,
          manual: params.manual,
          debug: params.debug,
          bench: params.bench,
          arena: params.arena ? buildJunkyard : undefined,
        }}
      />
      <FightHud store={hud} />
      {cold.loading ? (
        <div className="absolute inset-0 grid place-items-center bg-black/70 font-display text-2xl text-zinc-300">LOADING…</div>
      ) : null}
      {cold.error ? (
        <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-red-300" role="alert">
          {cold.error}
        </div>
      ) : null}
      {cold.paused && cold.matchWinner < 0 ? (
        <div className="absolute inset-0 grid place-items-center bg-black/60" role="dialog" aria-modal="true" aria-label="Paused">
          <div className="flex w-72 flex-col gap-2 rounded-xl border border-zinc-700 bg-zinc-950/95 p-5">
            <h2 className="font-display text-3xl">PAUSED</h2>
            <button type="button" autoFocus className="rounded bg-amber-400 py-2 font-display text-black" onClick={togglePause}>
              RESUME
            </button>
            <button
              type="button"
              className="rounded border border-zinc-600 py-2 font-display"
              onClick={() => {
                uiSound("ui_select");
                rematch();
              }}
            >
              RESTART
            </button>
            <label className="flex items-center justify-between text-sm text-zinc-300">
              Quality
              <select
                className="rounded bg-zinc-800 px-2 py-1"
                value={quality}
                onChange={(e) => {
                  const q = e.target.value as QualityTier;
                  setQuality(q);
                  saveTier(q);
                }}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low (no particles)</option>
              </select>
            </label>
            <label className="flex items-center justify-between text-sm text-zinc-300">
              Screen shake
              <select className="rounded bg-zinc-800 px-2 py-1" value={shake} onChange={(e) => setShake(Number(e.target.value))}>
                <option value={1}>Full</option>
                <option value={0.3}>Reduced</option>
                <option value={0}>Off</option>
              </select>
            </label>
            <label className="flex items-center justify-between text-sm text-zinc-300">
              Sound
              <input type="checkbox" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} />
            </label>
            <button type="button" className="rounded border border-zinc-700 py-2 font-display text-zinc-300" onClick={() => setCfg(null)}>
              QUIT
            </button>
          </div>
        </div>
      ) : null}
      {cold.matchWinner >= 0 ? (
        <div className="absolute inset-x-0 bottom-10 flex justify-center gap-3" data-testid="match-end">
          <button
            type="button"
            autoFocus
            className="rounded-lg bg-gradient-to-b from-orange-400 to-red-600 px-6 py-3 font-display text-xl tracking-wider shadow-[0_4px_0_#7c2d12]"
            onClick={() => {
              uiSound("ui_select");
              rematch();
            }}
          >
            REMATCH (R)
          </button>
          <button type="button" className="rounded-lg border border-zinc-500 bg-black/60 px-6 py-3 font-display text-xl" onClick={() => setCfg(null)}>
            CHANGE MODE
          </button>
          <Link href="/" className="rounded-lg border border-zinc-700 bg-black/60 px-6 py-3 font-display text-xl text-zinc-300">
            HOME
          </Link>
        </div>
      ) : null}
      {params.fps ? <FpsOverlay engine={engine} /> : null}
      {params.bench ? <BenchPanel engine={engine} done={cold.matchWinner >= 0} /> : null}
    </main>
  );
}

function FpsOverlay({ engine }: { engine: FightEngine | null }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!engine) return;
    const id = setInterval(() => {
      const p = engine.perf();
      setText(
        `${p.fps.toFixed(0)} fps · p50 ${p.p50.toFixed(1)} · p95 ${p.p95.toFixed(1)} ms · ${p.drawCalls} calls · ${(p.triangles / 1000).toFixed(0)}k tris · dpr ${p.dpr.toFixed(2)} · ${p.tier}`,
      );
    }, 500);
    return () => clearInterval(id);
  }, [engine]);
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 font-mono text-[11px] text-lime-300" data-testid="fps-meter">
      {text}
    </div>
  );
}
