"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NetSnapshot } from "@/game/net/session";
import type { WebGLRenderer } from "three";
import { RULES, runReplay, type CpuLevel, type Replay } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import FightHud from "@/components/hud/FightHud";
import { useHud } from "@/components/hud/useHud";
import { TouchControls } from "@/components/touch/TouchControls";
import { useTouchMode } from "@/components/touch/useTouchMode";
import { createAudio, type GameAudio } from "@/game/audio";
import type { FightEngine, FightMode } from "@/game/engine/createFightEngine";
import { defaultTier, loadTier, saveTier, type QualityTier } from "@/game/engine/quality";
import { HudStore } from "@/game/hud/hudStore";
import { OnlineLobby } from "@/components/online/OnlineLobby";
import { OnlineOverlay } from "@/components/online/OnlineOverlay";
import type { NetSession } from "@/game/net/session";
import { BenchPanel } from "./BenchPanel";
import { ModePicker, type PlayConfig } from "./ModePicker";
import "./play.css";

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
 * click come after a mouse press, when the activation is already there. The
 * on-screen buttons cancel touchstart (no click follows a tap on them), so
 * touchend is listened for too.
 */
const GESTURES = ["keydown", "pointerup", "click", "touchend"] as const;

/**
 * iOS plays web audio as "ambient" by default, which the ring/silent switch
 * mutes: most phones would get a silent game. "playback" plays through the
 * switch but stops the player's own music, so muting the game goes back to
 * "ambient" (their music can play again).
 */
function setAudioSession(muted: boolean): void {
  try {
    const session = (navigator as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = muted ? "ambient" : "playback";
  } catch {
    // Not supported: the default category it is.
  }
}

export interface PlayParams {
  /** Autostart: a local mode, or "online" (opens the online lobby). */
  mode: FightMode | null;
  /** /play?mode=online&wallet=… (the landing page's wallet box) pre-fills the gate. */
  wallet: string | null;
  difficulty: CpuLevel;
  tier: Tier;
  seed: string | null;
  manual: boolean;
  debug: boolean;
  fps: boolean;
  bench: boolean;
  quality: QualityTier | null;
  arena: boolean;
  /** ?touch=1 shows the on-screen buttons anywhere, ?touch=0 hides them; null decides by device. */
  touch: boolean | null;
  /** Debug only (?debug=1&cpu=idle): the CPU stands still. */
  idleCpu: boolean;
}

type ActiveConfig = Omit<PlayConfig, "mode"> & { mode: FightMode; net?: NetSession };

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
  const autostart = params.mode !== null && params.mode !== "online";
  // Autostart links (/play?mode=cpu) have no FIGHT click to start audio. e2e
  // runs (manual) stay silent, and so does a bench, so that its frame times
  // never include audio work.
  const autoAudio = autostart && !params.manual && !params.bench;
  const [cfg, setCfg] = useState<ActiveConfig | null>(
    autostart ? { mode: params.mode as FightMode, difficulty: params.difficulty, tier: params.tier } : null,
  );
  /** The online lobby (before a match); `auto` re-queues at once (after a match). */
  const [lobby, setLobby] = useState<{ auto: boolean } | null>(params.mode === "online" ? { auto: false } : null);
  const net = cfg?.net ?? null;
  const netSnap = useSyncExternalStore<NetSnapshot | null>(
    net ? net.subscribe : noSubscribe,
    () => (net ? net.snapshot() : null),
    () => null,
  );
  // An online match is left (a forfeit if it is still on) when its fight screen goes away.
  useEffect(() => {
    if (!net) return;
    return () => {
      void net.leave();
      net.dispose();
    };
  }, [net]);
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
  const fightArea = useRef<HTMLDivElement>(null);
  const touchMode = useTouchMode(params.touch);

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
    setAudioSession(mutedRef.current);
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
  useEffect(() => {
    audio.current?.setMuted(muted);
    if (audio.current) setAudioSession(muted);
  }, [muted]);

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
  const uiSoundRef = useRef(uiSound);

  const start = useCallback(
    async (c: PlayConfig) => {
      // The FIGHT click is a user gesture: create the audio here (it starts
      // at once), or wake a context that is still suspended.
      const a = audio.current;
      if (a) void a.resume();
      else await getAudio();
      if (c.mode === "online") {
        setLobby({ auto: false });
        return;
      }
      setCfg(c);
      setRound((r) => r + 1);
    },
    [getAudio],
  );

  const matchId = useMemo(
    () =>
      net
        ? net.matchId
        : params.seed
          ? `${params.seed}-${round}`
          : `local-${round}-${cfg?.mode ?? "x"}-${Math.floor(performance.timeOrigin % 1e9)}`,
    [net, params.seed, round, cfg?.mode],
  );

  const onMatched = useCallback((session: NetSession) => {
    setLobby(null);
    setCfg({ mode: "online", difficulty: "normal", tier: session.seating.tiers[session.side], net: session });
    setRound((r) => r + 1);
  }, []);
  /** After an online match: straight back into the queue. */
  const requeue = useCallback(() => {
    uiSoundRef.current?.("ui_select");
    setCfg(null);
    setLobby({ auto: true });
  }, []);

  const togglePause = useCallback(() => {
    const c = hud.get();
    // An online match runs on the server: nothing to pause.
    if (!engine || c.matchWinner >= 0 || c.loading || c.mode === "online") return;
    if (engine.paused) {
      uiSound("ui_select");
      engine.resume();
    } else {
      uiSound("pause");
      engine.pause();
    }
  }, [engine, hud, uiSound]);

  // Phones: the system back gesture (an edge swipe on Android and in iOS
  // Safari) is easy to hit with a thumb on the d-pad, and it would leave the
  // fight. While a touch fight runs, one extra history entry sits on top;
  // going back to it pauses instead. From the pause menu (or a finished
  // match), back leaves as usual. Next's router copies its own state into
  // the entry, so going back restores the same page without a reload.
  const touchFight = touchMode && (cfg?.mode === "cpu" || cfg?.mode === "online");
  // The back gesture pauses a CPU fight; an online fight can't pause, so back leaves as usual.
  const backGuard = touchMode && cfg?.mode === "cpu";
  const guard = useRef(false);
  useEffect(() => {
    if (!backGuard) return;
    const arm = () => {
      if (guard.current) return;
      window.history.pushState(null, "");
      guard.current = true;
    };
    const onPop = () => {
      if (!guard.current) return;
      guard.current = false;
      const e = engineRef.current;
      const c = hud.get();
      if (e && !e.paused && c.matchWinner < 0 && !c.loading) {
        uiSound("pause");
        e.pause();
      }
    };
    // Re-armed whenever play resumes (the pause flag clears).
    const onHud = () => {
      const c = hud.get();
      if (!c.paused && c.matchWinner < 0 && !c.loading) arm();
    };
    onHud();
    window.addEventListener("popstate", onPop);
    const off = hud.subscribe(onHud);
    return () => {
      window.removeEventListener("popstate", onPop);
      off();
    };
  }, [backGuard, hud, uiSound]);

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
      if (e.code === "KeyR" && !e.repeat && hud.get().matchWinner >= 0 && cfg.mode !== "online") rematch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cfg, togglePause, rematch, hud]);

  if (!cfg && lobby) {
    return (
      <main className="min-h-dvh bg-[radial-gradient(ellipse_at_top,#3b1d12,#0b0a10_60%)] text-white">
        <OnlineLobby auto={lobby.auto} wallet={params.wallet} onMatched={onMatched} onBack={() => setLobby(null)} />
      </main>
    );
  }

  if (!cfg) {
    return (
      <main className="min-h-dvh bg-[radial-gradient(ellipse_at_top,#3b1d12,#0b0a10_60%)] text-white">
        <ModePicker initial={{ mode: "cpu", difficulty: params.difficulty, tier: params.tier }} onStart={start} />
      </main>
    );
  }

  const tiers: [Tier, Tier] = net ? net.seating.tiers : [cfg.tier, cfg.mode === "2p" ? cfg.tier : "rust"];
  const fightNames: [string, string] | undefined = net
    ? (net.seating.names.map((n, i) => (i === net.side ? "YOU" : n)) as [string, string])
    : undefined;
  // The on-screen buttons play P1 against the CPU (2P needs a keyboard; a demo needs nobody).
  const touch = touchFight;
  const online = cfg.mode === "online";
  const ended = cold.matchWinner >= 0 && !online;
  // An online match that's over (or off, or lost): the result card takes the taps, not the fight controls.
  const netDone = !!netSnap && (netSnap.status === "over" || netSnap.status === "cancelled" || netSnap.lost);
  return (
    <main
      className="fight-screen fixed inset-0 touch-none overflow-hidden overscroll-none bg-black text-white"
      data-testid="fight-screen"
      data-touch={touch ? "" : undefined}
    >
      {/* One tree for every layout: moving the canvas under another parent would remount it (a new fight). */}
      <div ref={fightArea} className="fight-area" data-testid="fight-area">
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
            idleCpu: params.idleCpu,
            bench: params.bench,
            arena: params.arena ? buildJunkyard : undefined,
            net: net ?? undefined,
            names: fightNames,
          }}
        />
        <FightHud store={hud} onPause={cfg.mode === "demo" || online ? undefined : togglePause} />
        {net ? <OnlineOverlay session={net} loading={cold.loading} onRequeue={requeue} /> : null}
        {cold.loading ? (
          <div className="absolute inset-0 grid place-items-center bg-black/70 font-display text-2xl text-zinc-300">LOADING…</div>
        ) : null}
        {cold.error ? (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-red-300" role="alert">
            <div className="flex flex-col items-center gap-3">
              <p>{cold.error}</p>
              {online ? (
                <div className="flex gap-2">
                  <button type="button" className="rounded-lg bg-amber-400 px-4 py-2 font-display text-black" onClick={requeue}>
                    FIND ANOTHER MATCH
                  </button>
                  <Link href="/" className="rounded-lg border border-zinc-600 px-4 py-2 font-display text-zinc-200">
                    HOME
                  </Link>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {touch ? (
        <TouchControls
          engine={engine}
          hud={hud}
          active={!!engine && !cold.loading && !cold.error && !cold.paused && !ended && !netDone}
          area={fightArea}
          onPause={togglePause}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
        />
      ) : null}
      {cold.paused && !ended ? (
        // Scrolls on its own if a short screen (a phone held sideways) can't fit the menu.
        <div
          className="absolute inset-0 grid touch-pan-y place-items-center overflow-y-auto overscroll-contain bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Paused"
        >
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
                className="rounded bg-zinc-800 px-2 py-1 text-base"
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
              <select className="rounded bg-zinc-800 px-2 py-1 text-base" value={shake} onChange={(e) => setShake(Number(e.target.value))}>
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
      {ended ? (
        <div className="fight-end touch-manipulation" data-testid="match-end">
          <button
            type="button"
            autoFocus
            className="rounded-lg bg-gradient-to-b from-orange-400 to-red-600 px-5 py-3 font-display text-lg tracking-wider shadow-[0_4px_0_#7c2d12] sm:px-6 sm:text-xl"
            onClick={() => {
              uiSound("ui_select");
              rematch();
            }}
          >
            {touch ? "REMATCH" : "REMATCH (R)"}
          </button>
          <button
            type="button"
            className="rounded-lg border border-zinc-500 bg-black/60 px-5 py-3 font-display text-lg sm:px-6 sm:text-xl"
            onClick={() => setCfg(null)}
          >
            CHANGE MODE
          </button>
          <Link href="/" className="rounded-lg border border-zinc-700 bg-black/60 px-5 py-3 font-display text-lg text-zinc-300 sm:px-6 sm:text-xl">
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
