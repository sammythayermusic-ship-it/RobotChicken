"use client";

import { useEffect, useState } from "react";
import type { CpuLevel } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import { CONTROL_LABELS } from "@/game/match/input/bindings";

export interface PlayConfig {
  mode: "cpu" | "2p";
  difficulty: CpuLevel;
  tier: Tier;
}

const TIERS: Tier[] = ["rust", "chrome", "gold", "diamond"];
const LEVELS: CpuLevel[] = ["easy", "normal", "hard"];

function KeyTester() {
  const [held, setHeld] = useState<string[]>([]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => setHeld((h) => (h.includes(e.code) ? h : [...h, e.code]));
    const up = (e: KeyboardEvent) => setHeld((h) => h.filter((c) => c !== e.code));
    const clear = () => setHeld([]);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return (
    <div className="rounded-lg border border-zinc-700 bg-black/40 p-3 text-xs text-zinc-300">
      <p className="mb-2">
        Key tester: hold both players&apos; keys together. If a key doesn&apos;t light up, your keyboard can&apos;t register that
        combination (ghosting); try the alternate keys.
      </p>
      <div className="flex min-h-7 flex-wrap gap-1" data-testid="key-tester">
        {held.length === 0 ? <span className="text-zinc-500">press keys…</span> : null}
        {held.map((c) => (
          <kbd key={c} className="rounded border border-amber-400/70 bg-amber-400/10 px-1.5 py-0.5 font-mono text-amber-200">
            {c}
          </kbd>
        ))}
      </div>
    </div>
  );
}

function Row({ label, keys }: { label: string; keys: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-zinc-800 py-1 last:border-0">
      <span className="text-zinc-400">{label}</span>
      <kbd className="font-mono text-zinc-100">{keys}</kbd>
    </div>
  );
}

export function ModePicker({ initial, onStart }: { initial: PlayConfig; onStart: (c: PlayConfig) => void }) {
  const [cfg, setCfg] = useState<PlayConfig>(initial);
  const [controls, setControls] = useState(false);
  const btn = "rounded-md border px-3 py-2 font-display text-sm tracking-wide transition";
  const on = "border-amber-300 bg-amber-400 text-black";
  const off = "border-zinc-600 bg-zinc-900/70 text-zinc-200 hover:border-amber-300";
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-8" data-testid="mode-picker">
      <h1 className="font-display text-4xl text-white sm:text-5xl">PICK YOUR FIGHT</h1>
      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Mode</span>
        <div className="flex gap-2">
          <button type="button" className={`${btn} ${cfg.mode === "cpu" ? on : off}`} onClick={() => setCfg({ ...cfg, mode: "cpu" })}>
            VS CPU
          </button>
          <button type="button" className={`${btn} ${cfg.mode === "2p" ? on : off}`} onClick={() => setCfg({ ...cfg, mode: "2p" })}>
            2 PLAYERS · 1 KEYBOARD
          </button>
        </div>
      </div>
      {cfg.mode === "cpu" ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-widest text-zinc-400">CPU</span>
          <div className="flex gap-2">
            {LEVELS.map((l) => (
              <button key={l} type="button" className={`${btn} ${cfg.difficulty === l ? on : off}`} onClick={() => setCfg({ ...cfg, difficulty: l })}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Look (preview · tiers unlock by holding $COCK)</span>
        <div className="flex flex-wrap gap-2">
          {TIERS.map((t) => (
            <button key={t} type="button" className={`${btn} ${cfg.tier === t ? on : off}`} onClick={() => setCfg({ ...cfg, tier: t })}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        data-testid="fight-button"
        className="rounded-lg bg-gradient-to-b from-orange-400 to-red-600 py-4 font-display text-3xl tracking-widest text-white shadow-[0_6px_0_#7c2d12] transition active:translate-y-1 active:shadow-[0_2px_0_#7c2d12]"
        onClick={() => onStart(cfg)}
      >
        FIGHT!
      </button>
      <button type="button" className="self-start text-sm text-zinc-400 underline underline-offset-4" onClick={() => setControls((v) => !v)}>
        {controls ? "Hide controls" : "Controls"}
      </button>
      {controls ? (
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          {cfg.mode === "cpu" ? (
            <div>
              <h2 className="mb-1 font-display text-amber-300">YOU</h2>
              <Row label="Walk" keys={CONTROL_LABELS.solo.move} />
              <Row label="Jump" keys={CONTROL_LABELS.solo.jump} />
              <Row label="Block" keys={CONTROL_LABELS.solo.block} />
              <Row label="Peck" keys={CONTROL_LABELS.solo.peck} />
              <Row label="Also" keys={CONTROL_LABELS.solo.alt} />
            </div>
          ) : (
            <>
              <div>
                <h2 className="mb-1 font-display text-amber-300">P1 (left)</h2>
                <Row label="Walk" keys={CONTROL_LABELS.p1.move} />
                <Row label="Jump" keys={CONTROL_LABELS.p1.jump} />
                <Row label="Block" keys={CONTROL_LABELS.p1.block} />
                <Row label="Peck" keys={CONTROL_LABELS.p1.peck} />
              </div>
              <div>
                <h2 className="mb-1 font-display text-amber-300">P2 (right)</h2>
                <Row label="Walk" keys={CONTROL_LABELS.p2.move} />
                <Row label="Jump" keys={CONTROL_LABELS.p2.jump} />
                <Row label="Block" keys={CONTROL_LABELS.p2.block} />
                <Row label="Peck" keys={CONTROL_LABELS.p2.peck} />
              </div>
            </>
          )}
          <div className="text-zinc-400 sm:col-span-2">
            <p>Double-tap a direction to dash. Peck + toward = shove, peck + down = slam (unblockable), peck in the air = dive kick. Fill Heat and peck standing still for the Rooster Rocket.</p>
          </div>
          <div className="sm:col-span-2">
            <KeyTester />
          </div>
        </div>
      ) : null}
    </div>
  );
}
