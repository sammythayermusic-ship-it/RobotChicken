"use client";
/**
 * React mount point for the landing showcase. The engine creates its own
 * canvas inside `host` and removes it on dispose, so StrictMode's
 * mount/unmount/mount in dev gets a fresh canvas and context each time and
 * never touches one that was force-lost.
 *
 * Load this with next/dynamic `ssr: false` (three touches `window`); the
 * parent keeps a CSS poster behind it for first paint and for machines
 * without WebGL.
 *
 * The host is role="img", so it cannot contain a control. The parent renders
 * the pause/play button from `onControls`: called with the live state once
 * the first frame is drawn and on every change, and with null when the
 * showcase goes away (or never starts, for lack of WebGL).
 */
import { useEffect, useEffectEvent, useRef } from "react";
import { Showcase, type ShowcaseMotion } from "../showcase/Showcase";

export interface ShowcaseControls extends ShowcaseMotion {
  setPaused(paused: boolean): void;
}

export default function ShowcaseCanvas({
  className,
  onControls,
}: {
  className?: string;
  onControls?: (controls: ShowcaseControls | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const report = useEffectEvent((controls: ShowcaseControls | null) => onControls?.(controls));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let showcase: Showcase | null = null;
    try {
      showcase = new Showcase(el, {
        onMotionChange: (motion) => report({ ...motion, setPaused: (paused) => showcase?.setPaused(paused) }),
      });
    } catch (err) {
      // No WebGL (blocklisted GPU, disabled hardware acceleration): the poster stays.
      console.warn("[showcase] WebGL unavailable; keeping the static poster", err);
    }
    return () => {
      showcase?.dispose();
      report(null);
    };
  }, []);

  return <div ref={host} className={className} role="img" aria-label="Two robot chickens squaring off in a neon-lit junkyard pit" />;
}
