"use client";

import { useSyncExternalStore } from "react";

const SEEN_KEY = "cockfight:touch:1";
const COARSE = "(pointer: coarse)";
const TOUCH_ONLY = "(hover: none) and (pointer: coarse)";

let seen: boolean | null = null;
const listeners = new Set<() => void>();

function readSeen(): boolean {
  if (seen === null) {
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === "1";
    } catch {
      seen = false;
    }
  }
  return seen;
}

function markSeen(): void {
  if (readSeen()) return;
  seen = true;
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private mode or blocked storage: this page load still remembers.
  }
  for (const fn of listeners) fn();
}

const onPointerDown = (e: PointerEvent) => {
  if (e.pointerType === "touch") markSeen();
};

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const mq = window.matchMedia?.(COARSE);
  mq?.addEventListener?.("change", fn);
  if (listeners.size === 1) window.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    listeners.delete(fn);
    mq?.removeEventListener?.("change", fn);
    if (listeners.size === 0) window.removeEventListener("pointerdown", onPointerDown, true);
  };
}

const snapshot = () => (window.matchMedia?.(COARSE).matches ?? false) || readSeen();

/**
 * Whether to show the on-screen buttons: a touch screen is the main pointer
 * (phones, tablets), or this tab has seen a finger (a touch laptop). `forced`
 * (?touch=1 / ?touch=0) wins either way.
 */
export function useTouchMode(forced: boolean | null): boolean {
  const auto = useSyncExternalStore(subscribe, snapshot, () => false);
  return forced ?? auto;
}

function subscribeMedia(query: string) {
  return (fn: () => void) => {
    const mq = window.matchMedia?.(query);
    mq?.addEventListener?.("change", fn);
    return () => mq?.removeEventListener?.("change", fn);
  };
}
const subscribeTouchOnly = subscribeMedia(TOUCH_ONLY);

/** A phone or tablet with no mouse (and most likely no keyboard): keyboard-only options get a note. */
export function useTouchOnly(): boolean {
  return useSyncExternalStore(subscribeTouchOnly, () => window.matchMedia?.(TOUCH_ONLY).matches ?? false, () => false);
}
