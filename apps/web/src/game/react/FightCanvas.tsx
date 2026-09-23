"use client";

import { useEffect, useRef } from "react";
import { createFightEngine, type FightEngine, type FightOptions } from "../engine/createFightEngine";

/**
 * Mounts the fight engine into a div. The engine owns a fresh canvas per
 * mount and force-loses its context on dispose, which keeps StrictMode's
 * double mount and fast navigation safe.
 */
export default function FightCanvas({
  options,
  onEngine,
  className,
}: {
  options: FightOptions;
  onEngine?: (e: FightEngine | null) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const optsRef = useRef(options);
  const onEngineRef = useRef(onEngine);
  useEffect(() => {
    onEngineRef.current = onEngine;
    optsRef.current = options;
  });
  // Restart only when the match identity changes.
  const key = `${options.matchId}|${options.mode}|${options.difficulty}|${options.tiers.join(",")}`;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const engine = createFightEngine(el, optsRef.current);
    onEngineRef.current?.(engine);
    return () => {
      onEngineRef.current?.(null);
      engine.dispose();
    };
  }, [key]);

  return <div ref={host} className={className} data-testid="fight-canvas-host" />;
}
