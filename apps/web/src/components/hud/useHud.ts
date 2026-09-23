"use client";

import { useSyncExternalStore } from "react";
import type { HudCold, HudStore } from "@/game/hud/hudStore";

export function useHud(store: HudStore): HudCold {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
