"use client";
/**
 * `ssr: false` is only allowed inside a Client Component, so the landing page
 * (a Server Component) renders this wrapper. three.js and the loaders stay out
 * of the server bundle and out of the page's first-load JS.
 *
 * It also renders the showcase's pause/play button (WCAG 2.2.2: the hero
 * moves on its own, indefinitely, beside other content). The button is a
 * sibling of the role="img" host, placed over the canvas by the parent's
 * `relative` box, and appears once the showcase is drawing: without WebGL
 * there is nothing to pause. Under prefers-reduced-motion the showcase starts
 * paused and the button offers Play.
 */
import dynamic from "next/dynamic";
import { useState } from "react";
import type { ShowcaseControls } from "@/game/react/ShowcaseCanvas";

const ShowcaseCanvas = dynamic(() => import("@/game/react/ShowcaseCanvas"), { ssr: false });

export function ShowcaseSlot({ className }: { className?: string }) {
  const [controls, setControls] = useState<ShowcaseControls | null>(null);
  return (
    <>
      <ShowcaseCanvas className={className} onControls={setControls} />
      {controls && <MotionToggle controls={controls} />}
    </>
  );
}

function MotionToggle({ controls }: { controls: ShowcaseControls }) {
  const { paused } = controls;
  return (
    <button
      type="button"
      onClick={() => controls.setPaused(!paused)}
      // The accessible name starts with the visible word (WCAG 2.5.3).
      aria-label={paused ? "Play animation" : "Pause animation"}
      className="absolute right-3 bottom-3 z-10 inline-flex h-9 items-center gap-2 rounded-full border border-chrome/25 bg-pit/75 px-3.5 text-xs font-semibold tracking-widest text-chrome uppercase transition hover:border-neon-cyan/70 hover:text-neon-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-cyan"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 fill-current">
        {paused ? <path d="M4 2.5v11l9.5-5.5z" /> : <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />}
      </svg>
      {paused ? "Play" : "Pause"}
    </button>
  );
}
