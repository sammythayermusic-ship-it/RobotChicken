"use client";

import { useEffect, useRef } from "react";
import type { HudStore, HotBar } from "@/game/hud/hudStore";
import { useHud } from "./useHud";
import "./hud.css";

function Bar({ store, bar, right, className }: { store: HudStore; bar: HotBar; right?: boolean; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    store.registerBar(bar, ref.current);
    return () => store.registerBar(bar, null);
  }, [store, bar]);
  return <div ref={ref} className={`hud-bar ${right ? "hud-bar-right" : ""} absolute inset-0 ${className}`} />;
}

function Side({ store, side }: { store: HudStore; side: 0 | 1 }) {
  const hud = useHud(store);
  const right = side === 1;
  const flashRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    store.registerFlash(side, flashRef.current);
    return () => store.registerFlash(side, null);
  }, [store, side]);
  const wins = hud.wins[side];
  return (
    <div className={`flex w-[42%] flex-col gap-1 ${right ? "items-end" : "items-start"}`}>
      <div className={`flex items-center gap-2 ${right ? "flex-row-reverse" : ""}`}>
        <span className="font-display text-sm tracking-wider text-white drop-shadow sm:text-lg" data-testid={`hud-name-${side}`}>
          {hud.names[side]}
        </span>
        <div className="flex gap-1" aria-label={`${wins} round${wins === 1 ? "" : "s"} won`}>
          {[0, 1].map((i) => (
            <span
              key={i}
              className={`h-3 w-3 rounded-full border border-amber-300/80 ${i < wins ? "bg-amber-400 shadow-[0_0_8px_#fbbf24]" : "bg-black/40"}`}
            />
          ))}
        </div>
      </div>
      <div
        ref={flashRef}
        className="relative h-4 w-full overflow-hidden rounded-sm border-2 border-zinc-200/80 bg-zinc-900/80 sm:h-6"
        role="meter"
        aria-label={`${hud.names[side]} health`}
      >
        <Bar store={store} bar={`trail${side}` as HotBar} right={right} className="hud-trail bg-red-600" />
        <Bar store={store} bar={`hp${side}` as HotBar} right={right} className="bg-gradient-to-b from-lime-300 to-lime-600" />
      </div>
      <div
        className={`relative h-2 w-2/3 overflow-hidden rounded-sm border border-orange-300/70 bg-zinc-900/80 sm:h-2.5 ${hud.heatFull[side] ? "hud-heat-full" : ""}`}
        role="meter"
        aria-label={`${hud.names[side]} heat`}
      >
        <Bar store={store} bar={`heat${side}` as HotBar} right={right} className="bg-gradient-to-r from-orange-500 via-amber-400 to-yellow-200" />
      </div>
      {hud.heatFull[side] ? <span className="font-display text-[10px] tracking-widest text-amber-300 sm:text-xs">SUPER READY</span> : null}
    </div>
  );
}

/** DOM overlay over the fight canvas. Cold values re-render; bars are driven by the engine. */
export default function FightHud({ store }: { store: HudStore }) {
  const hud = useHud(store);
  const low = hud.phase === 1 && hud.timerSec <= 10;
  const hold = hud.banner.tone !== "info";
  return (
    <div className="pointer-events-none absolute inset-0 select-none" data-testid="fight-hud">
      <div className="flex items-start justify-between px-3 pt-3 sm:px-6 sm:pt-5">
        <Side store={store} side={0} />
        <div className="flex flex-col items-center pt-1">
          <span
            className={`font-display text-3xl tabular-nums text-white drop-shadow-[0_2px_0_#000] sm:text-5xl ${low ? "hud-timer-low" : ""}`}
            data-testid="hud-timer"
          >
            {hud.timerSec}
          </span>
          {hud.sd ? <span className="font-display text-[10px] tracking-widest text-red-400">SUDDEN DEATH</span> : null}
          <span className="font-display text-[10px] tracking-widest text-zinc-300">ROUND {hud.round}</span>
        </div>
        <Side store={store} side={1} />
      </div>
      {hud.banner.text ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            key={hud.banner.key}
            data-testid="hud-banner"
            className={`${hold ? "hud-banner-hold" : "hud-banner"} font-display text-6xl text-white drop-shadow-[0_4px_0_#7c2d12] sm:text-8xl ${
              hud.banner.tone === "ko" ? "text-amber-300" : ""
            }`}
          >
            {hud.banner.text}
          </span>
        </div>
      ) : null}
    </div>
  );
}
