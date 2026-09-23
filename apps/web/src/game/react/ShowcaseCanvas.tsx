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
 */
import { useEffect, useRef } from "react";
import { Showcase } from "../showcase/Showcase";

export default function ShowcaseCanvas({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let showcase: Showcase | null = null;
    try {
      showcase = new Showcase(el);
    } catch (err) {
      // No WebGL (blocklisted GPU, disabled hardware acceleration): the poster stays.
      console.warn("[showcase] WebGL unavailable; keeping the static poster", err);
    }
    return () => showcase?.dispose();
  }, []);

  return <div ref={host} className={className} role="img" aria-label="Two robot chickens squaring off in a neon-lit junkyard pit" />;
}
