"use client";
/**
 * `ssr: false` is only allowed inside a Client Component, so the landing page
 * (a Server Component) renders this wrapper. three.js and the loaders stay out
 * of the server bundle and out of the page's first-load JS.
 */
import dynamic from "next/dynamic";

const ShowcaseCanvas = dynamic(() => import("@/game/react/ShowcaseCanvas"), { ssr: false });

export function ShowcaseSlot({ className }: { className?: string }) {
  return <ShowcaseCanvas className={className} />;
}
