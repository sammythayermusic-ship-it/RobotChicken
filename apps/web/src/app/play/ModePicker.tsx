"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CpuLevel } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import { CONTROL_LABELS, SOLO, VERSUS } from "@/game/match/input/bindings";
import { isControlTarget } from "@/game/match/input/keyboard";
import { useTouchOnly } from "@/components/touch/useTouchMode";

export interface PlayConfig {
  mode: "cpu" | "2p";
  difficulty: CpuLevel;
  tier: Tier;
}

const TIERS: Tier[] = ["rust", "chrome", "gold", "diamond"];
const LEVELS: CpuLevel[] = ["easy", "normal", "hard"];

/** A key the game binds in either mode. */
const gameKey = (code: string) => SOLO.has(code) || VERSUS.has(code);

function KeyTester() {
  const [held, setHeld] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Take focus from the Controls toggle that opened the tester. Left there,
    // Space (a peck key) clicks the toggle on release, Enter on press, and the
    // tester closes mid-test.
    box.current?.focus({ preventScroll: true });
    // Game keys under test must not scroll the page or press anything either,
    // unless the player has moved focus to a control on purpose.
    const own = (e: KeyboardEvent) => {
      if (gameKey(e.code) && !isControlTarget(e.target)) e.preventDefault();
    };
    const down = (e: KeyboardEvent) => {
      own(e);
      setHeld((h) => (h.includes(e.code) ? h : [...h, e.code]));
    };
    const up = (e: KeyboardEvent) => {
      own(e);
      setHeld((h) => h.filter((c) => c !== e.code));
    };
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
    <div
      ref={box}
      tabIndex={-1}
      role="group"
      aria-label="Key tester"
      className="rounded-lg border border-zinc-700 bg-black/40 p-3 text-xs text-zinc-300 outline-none focus-visible:border-amber-300"
    >
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

/**
 * One option of a choice group. aria-pressed carries the selection, so
 * assistive tech hears "pressed" rather than relying on the amber fill.
 */
function Choice({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: ReactNode }) {
  const look = selected ? "border-amber-300 bg-amber-400 text-black" : "border-zinc-600 bg-zinc-900/70 text-zinc-200 hover:border-amber-300";
  return (
    <button type="button" aria-pressed={selected} className={`rounded-md border px-3 py-2 font-display text-sm tracking-wide transition ${look}`} onClick={onSelect}>
      {children}
    </button>
  );
}

/** A captioned row of choices; the caption names the group for assistive tech. */
function ChoiceGroup({ id, caption, wrap, children }: { id: string; caption: string; wrap?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-xs uppercase tracking-widest text-zinc-400">
        {caption}
      </span>
      <div role="group" aria-labelledby={id} className={`flex gap-2 ${wrap ? "flex-wrap" : ""}`}>
        {children}
      </div>
    </div>
  );
}

/** What the on-screen buttons do (phones and tablets). */
function TouchHelp() {
  return (
    <div data-testid="touch-help">
      <h2 className="mb-1 font-display text-amber-300">ON-SCREEN BUTTONS</h2>
      <Row label="Walk" keys="◀ ▶ on the pad" />
      <Row label="Block" keys="hold ▼" />
      <Row label="Dash" keys="double-tap ◀ or ▶" />
      <Row label="Peck" keys="PECK" />
      <Row label="Jump" keys="JUMP" />
      <Row label="Slam" keys="hold ▼ + SLAM" />
      <Row label="Dive kick" keys="DIVE (in the air)" />
      <Row label="Pause" keys="tap the timer" />
      <p className="mt-2 text-xs text-zinc-400">Upright or sideways: both work. Turning the phone keeps the fight going.</p>
    </div>
  );
}

export function ModePicker({ initial, onStart }: { initial: PlayConfig; onStart: (c: PlayConfig) => void }) {
  const [cfg, setCfg] = useState<PlayConfig>(initial);
  const [controls, setControls] = useState(false);
  const touchOnly = useTouchOnly();
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-8" data-testid="mode-picker">
      <h1 className="font-display text-4xl text-white sm:text-5xl">PICK YOUR FIGHT</h1>
      <ChoiceGroup id="pick-mode" caption="Mode">
        <Choice selected={cfg.mode === "cpu"} onSelect={() => setCfg({ ...cfg, mode: "cpu" })}>
          VS CPU
        </Choice>
        <Choice selected={cfg.mode === "2p"} onSelect={() => setCfg({ ...cfg, mode: "2p" })}>
          2 PLAYERS · 1 KEYBOARD
        </Choice>
      </ChoiceGroup>
      {touchOnly && cfg.mode === "2p" ? (
        <p className="-mt-3 text-xs text-amber-200/80" data-testid="needs-keyboard">
          2 players needs a keyboard. On a phone, fight the CPU with the on-screen buttons.
        </p>
      ) : null}
      {cfg.mode === "cpu" ? (
        <ChoiceGroup id="pick-cpu" caption="CPU">
          {LEVELS.map((l) => (
            <Choice key={l} selected={cfg.difficulty === l} onSelect={() => setCfg({ ...cfg, difficulty: l })}>
              {l.toUpperCase()}
            </Choice>
          ))}
        </ChoiceGroup>
      ) : null}
      <ChoiceGroup id="pick-look" caption="Look (preview · tiers unlock by holding $COCK)" wrap>
        {TIERS.map((t) => (
          <Choice key={t} selected={cfg.tier === t} onSelect={() => setCfg({ ...cfg, tier: t })}>
            {t.toUpperCase()}
          </Choice>
        ))}
      </ChoiceGroup>
      <button
        type="button"
        data-testid="fight-button"
        className="rounded-lg bg-gradient-to-b from-orange-400 to-red-600 py-4 font-display text-3xl tracking-widest text-white shadow-[0_6px_0_#7c2d12] transition active:translate-y-1 active:shadow-[0_2px_0_#7c2d12]"
        onClick={() => onStart(cfg)}
      >
        FIGHT!
      </button>
      <button
        type="button"
        aria-expanded={controls}
        className="self-start text-sm text-zinc-400 underline underline-offset-4"
        onClick={() => setControls((v) => !v)}
      >
        {controls ? "Hide controls" : "Controls"}
      </button>
      {controls ? (
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          {touchOnly && cfg.mode === "cpu" ? (
            <div className="sm:col-span-2">
              <TouchHelp />
            </div>
          ) : cfg.mode === "cpu" ? (
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
            <p>Double-tap a direction to dash. Peck + toward = shove, peck + down = slam (unblockable), peck in the air = dive kick. With full Heat, peck with no direction held for the Rooster Rocket (peck + away stays a peck and keeps the meter).</p>
          </div>
          {touchOnly ? null : (
            <div className="sm:col-span-2">
              <KeyTester />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
