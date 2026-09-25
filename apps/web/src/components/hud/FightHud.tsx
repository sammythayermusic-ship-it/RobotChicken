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

/**
 * One fighter's corner. Sizes follow the fight area (container queries, see
 * globals.css and game/view/camera/hudBand.ts): `hud-wide` on desktops and
 * tablets, `hud-short` on a phone held sideways (the whole band squeezed into
 * HUD_BAND_PX.short), the base styles on a portrait phone.
 */
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
    <div className={`flex w-[42%] flex-col gap-1 hud-short:gap-0.5 ${right ? "items-end" : "items-start"}`}>
      <div className={`flex max-w-full items-center gap-2 ${right ? "flex-row-reverse" : ""}`}>
        {/* One line always (a wrapped name would push the bars past the band the camera keeps clear). */}
        <span
          className="min-w-0 truncate whitespace-nowrap font-display text-xs tracking-wider text-white drop-shadow hud-wide:text-lg hud-short:text-sm"
          data-testid={`hud-name-${side}`}
        >
          {hud.names[side]}
        </span>
        <div className="flex shrink-0 gap-1" aria-label={`${wins} round${wins === 1 ? "" : "s"} won`}>
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
        className="relative h-4 w-full overflow-hidden rounded-sm border-2 border-zinc-200/80 bg-zinc-900/80 hud-wide:h-6 hud-short:h-3"
        role="meter"
        aria-label={`${hud.names[side]} health`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={100}
      >
        <Bar store={store} bar={`trail${side}` as HotBar} right={right} className="hud-trail bg-red-600" />
        <Bar store={store} bar={`hp${side}` as HotBar} right={right} className="bg-gradient-to-b from-lime-300 to-lime-600" />
      </div>
      {/* Short screens put SUPER READY beside the Heat bar instead of under it. */}
      <div
        className={`flex w-full flex-col gap-1 hud-short:items-center hud-short:gap-2 ${
          right ? "items-end hud-short:flex-row-reverse" : "items-start hud-short:flex-row"
        }`}
      >
        <div
          className={`relative h-2 w-2/3 overflow-hidden rounded-sm border border-orange-300/70 bg-zinc-900/80 hud-wide:h-2.5 hud-short:w-1/2 ${hud.heatFull[side] ? "hud-heat-full" : ""}`}
          role="meter"
          aria-label={`${hud.names[side]} heat`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <Bar store={store} bar={`heat${side}` as HotBar} right={right} className="bg-gradient-to-r from-orange-500 via-amber-400 to-yellow-200" />
        </div>
        {hud.heatFull[side] ? (
          <span className="whitespace-nowrap font-display text-[10px] leading-none tracking-widest text-amber-300 hud-wide:text-xs">SUPER READY</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * DOM overlay over the fight canvas. Cold values re-render; bars are driven
 * by the engine. With `onPause`, the timer is also the on-screen pause button
 * (the only way to pause without a keyboard).
 */
export default function FightHud({ store, onPause }: { store: HudStore; onPause?: () => void }) {
  const hud = useHud(store);
  const low = hud.phase === 1 && hud.timerSec <= 10;
  const hold = hud.banner.tone !== "info";
  const clock = (
    <>
      <span
        className={`font-display text-3xl tabular-nums text-white drop-shadow-[0_2px_0_#000] hud-wide:text-5xl hud-short:text-2xl ${low ? "hud-timer-low" : ""}`}
        data-testid="hud-timer"
      >
        {hud.timerSec}
      </span>
      {hud.sd ? <span className="whitespace-nowrap font-display text-[10px] tracking-widest text-red-400">SUDDEN DEATH</span> : null}
      <span className="flex items-center gap-1 whitespace-nowrap font-display text-[10px] tracking-widest text-zinc-300">
        ROUND {hud.round}
        {onPause ? <span className="hud-pause-glyph" aria-hidden="true" /> : null}
      </span>
    </>
  );
  return (
    <div className="pointer-events-none absolute inset-0 select-none" data-testid="fight-hud">
      <div className="flex items-start justify-between px-3 pt-3 hud-wide:px-6 hud-wide:pt-5 hud-short:px-4 hud-short:pt-1.5">
        <Side store={store} side={0} />
        {onPause ? (
          <button
            type="button"
            aria-label={`Pause (${hud.timerSec} seconds left, round ${hud.round})`}
            data-testid="hud-pause"
            // Keyboard players have Esc / P: kept out of the tab order, and a mouse press doesn't
            // focus it (a focused button would take Space and Enter, the peck keys).
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            className="pointer-events-auto -mt-1 flex min-h-11 min-w-14 touch-manipulation flex-col items-center rounded-lg px-1 pt-1 outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
            onClick={onPause}
          >
            {clock}
          </button>
        ) : (
          <div className="flex flex-col items-center pt-1">{clock}</div>
        )}
        <Side store={store} side={1} />
      </div>
      {hud.banner.text ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            key={hud.banner.key}
            data-testid="hud-banner"
            className={`${hold ? "hud-banner-hold" : "hud-banner"} font-display text-6xl text-white drop-shadow-[0_4px_0_#7c2d12] hud-wide:text-8xl ${
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
