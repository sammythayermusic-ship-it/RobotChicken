"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { B } from "@cockfight/sim";
import { useHud } from "@/components/hud/useHud";
import type { FightEngine } from "@/game/engine/createFightEngine";
import type { HudStore } from "@/game/hud/hudStore";
import { dpadBits, type TouchInput } from "@/game/match/input/touch";
import "./touch.css";

type Control = "dpad" | "peck" | "ctx";

interface Gesture {
  control: Control;
  /** Where the finger is now (CSS px): a d-pad finger that inherits the pad reads from here. */
  x: number;
  y: number;
}

/** Bits that pick a ground move with PECK (↑ doesn't: ↑ + PECK is a plain peck, or the super). */
const MOVE_DIRS = B.L | B.R | B.D;

/**
 * The on-screen buttons: a d-pad (the arrow keys), PECK (Space) and a
 * context button that reads JUMP, SLAM with ↓ held, or DIVE in the air.
 * Upright they sit on a controller panel under the fight; sideways they sit
 * see-through in the bottom corners (the layout is CSS only, in play.css and
 * touch.css, so turning the phone never remounts anything).
 *
 * Input goes to the engine's TouchInput, which turns it into the same five
 * bits the keyboard makes. The elements are divs, never focusable: a focused
 * control would take the keyboard's keys (isControlTarget). Each half of the
 * pad is one big hit zone: a thumb anywhere on the left drives the d-pad, a
 * thumb on the right presses whichever button is nearer.
 */
export function TouchControls({
  engine,
  hud,
  active,
  area,
  onPause,
  muted,
  onToggleMute,
}: {
  engine: FightEngine | null;
  hud: HudStore;
  /** Taking input: the fight is on screen and not paused or over. */
  active: boolean;
  /** The fight area (its bottom edge is where the buttons start covering the fight). */
  area: RefObject<HTMLElement | null>;
  onPause: () => void;
  muted: boolean;
  onToggleMute: () => void;
}) {
  const cold = useHud(hud);
  const root = useRef<HTMLDivElement>(null);
  const dpadEl = useRef<HTMLDivElement>(null);
  const peckEl = useRef<HTMLDivElement>(null);
  const ctxEl = useRef<HTMLDivElement>(null);
  const [dirs, setDirs] = useState(0);
  const [ctxFrozen, setCtxFrozen] = useState<string | null>(null);
  /** Lets go of every thumb (set by the listener effect). */
  const releaseControls = useRef<(() => void) | null>(null);

  // Latest values for the native listeners (attached once per engine).
  const live = useRef({ touch: null as TouchInput | null, active, air: false });
  useEffect(() => {
    live.current = { touch: engine?.touch ?? null, active, air: cold.air };
  });

  const air = cold.air;
  const ctxLabel = ctxFrozen ?? (air ? "DIVE" : dirs & B.D ? "SLAM" : "JUMP");
  // In the air but past the dive (spent, too low, knocked up): the button can't dive now.
  const ctxOff = ctxLabel === "DIVE" && ctxFrozen === null && !cold.dive;
  const peckLabel = cold.heatFull[cold.you ?? 0] && (dirs & MOVE_DIRS) === 0 && !air ? "SUPER" : "PECK";

  useEffect(() => {
    const el = root.current;
    const pad = dpadEl.current;
    const peck = peckEl.current;
    const ctx = ctxEl.current;
    if (!el || !pad || !peck || !ctx) return;
    const gestures = new Map<number, Gesture>();
    let dpadOwner = -1;
    let dpad = 0;
    let dpadRect: DOMRect | null = null;
    const held = { peck: 0, ctx: 0 };

    const showDpad = (bits: number) => {
      pad.dataset.l = bits & B.L ? "1" : "";
      pad.dataset.r = bits & B.R ? "1" : "";
      pad.dataset.u = bits & B.U ? "1" : "";
      pad.dataset.d = bits & B.D ? "1" : "";
    };
    const setDpad = (bits: number) => {
      if (bits === dpad) return;
      dpad = bits;
      live.current.touch?.setDpad(bits);
      showDpad(bits);
      setDirs(bits);
    };
    /** The d-pad for a finger at (x, y); `fresh`: a finger just taking the pad over (no stickiness from the last one). */
    const dpadAt = (x: number, y: number, fresh = false) => {
      const r = dpadRect ?? pad.getBoundingClientRect();
      dpadRect = r;
      setDpad(dpadBits(x - (r.left + r.width / 2), y - (r.top + r.height / 2), r.width / 2, fresh ? 0 : dpad));
    };
    const nearer = (e: PointerEvent): "peck" | "ctx" => {
      const d = (b: HTMLElement) => {
        const r = b.getBoundingClientRect();
        return Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) - r.width / 2;
      };
      return d(peck) <= d(ctx) ? "peck" : "ctx";
    };

    const down = (e: PointerEvent) => {
      if (!live.current.active || (e.pointerType === "mouse" && e.button !== 0)) return;
      const zone = (e.target as Element | null)?.closest("[data-zone]") as HTMLElement | null;
      if (!zone) return; // the pills are plain click targets
      e.preventDefault();
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers (tests) can't be captured; their moves still arrive.
      }
      const control: Control = zone.dataset.zone === "dpad" ? "dpad" : nearer(e);
      gestures.set(e.pointerId, { control, x: e.clientX, y: e.clientY });
      if (control === "dpad") {
        // The newest thumb on the d-pad wins it.
        dpadOwner = e.pointerId;
        dpadRect = null;
        dpadAt(e.clientX, e.clientY, true);
      } else if (control === "peck") {
        held.peck++;
        peck.dataset.pressed = "1";
        live.current.touch?.press("peck");
      } else if (control === "ctx") {
        held.ctx++;
        ctx.dataset.pressed = "1";
        // Show what this press does, and keep showing it until release.
        if (held.ctx === 1) setCtxFrozen(live.current.air ? "DIVE" : dpad & B.D ? "SLAM" : "JUMP");
        // A second finger is one more press of the same (TouchInput decides what).
        live.current.touch?.press("ctx");
      }
    };

    const move = (e: PointerEvent) => {
      const g = gestures.get(e.pointerId);
      if (!g) return;
      g.x = e.clientX;
      g.y = e.clientY;
      if (e.pointerId === dpadOwner && g.control === "dpad") dpadAt(g.x, g.y);
    };

    const end = (e: PointerEvent) => {
      const g = gestures.get(e.pointerId);
      if (!g) return;
      gestures.delete(e.pointerId);
      if (g.control === "dpad") {
        if (dpadOwner === e.pointerId) {
          // Another finger still on the pad takes it back (the newest one), from where it is now.
          let next = -1;
          for (const [id, o] of gestures) if (o.control === "dpad") next = id;
          dpadOwner = next;
          const o = gestures.get(next);
          if (o) {
            dpadRect = null;
            dpadAt(o.x, o.y, true);
          } else setDpad(0);
        }
      } else if (g.control === "peck") {
        held.peck = Math.max(0, held.peck - 1);
        if (held.peck === 0) peck.dataset.pressed = "";
        live.current.touch?.release("peck");
      } else if (g.control === "ctx") {
        held.ctx = Math.max(0, held.ctx - 1);
        if (held.ctx === 0) {
          ctx.dataset.pressed = "";
          setCtxFrozen(null);
          live.current.touch?.release("ctx");
        }
      }
    };

    /** Every thumb off (a lost gesture, the controls switching off): nothing stays held. */
    const releaseAll = () => {
      const hadPeck = held.peck > 0;
      const hadCtx = held.ctx > 0;
      gestures.clear();
      dpadOwner = -1;
      setDpad(0);
      held.peck = 0;
      held.ctx = 0;
      peck.dataset.pressed = "";
      ctx.dataset.pressed = "";
      if (hadPeck) live.current.touch?.release("peck");
      if (hadCtx) live.current.touch?.release("ctx");
      setCtxFrozen(null);
    };

    // React's touch listeners are passive: preventDefault there does nothing
    // (and Chrome logs an intervention). These stop scrolling, pinch zoom,
    // double-tap zoom, text selection and the long-press menu on the pad.
    const stop = (e: Event) => {
      // Not on the pills: cancelling a tap there would cancel its click too.
      if (e.cancelable && !(e.target as Element | null)?.closest?.("[data-pill]")) e.preventDefault();
    };
    const lastTouch = (e: TouchEvent) => {
      if (e.touches.length === 0 && gestures.size > 0) releaseAll();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
    el.addEventListener("touchstart", stop, { passive: false });
    el.addEventListener("touchmove", stop, { passive: false });
    el.addEventListener("touchend", lastTouch);
    el.addEventListener("touchcancel", lastTouch);
    el.addEventListener("contextmenu", stop);
    // iOS pinch zoom on the whole page.
    document.addEventListener("gesturestart", stop);
    // TouchInput drops everything on blur / a hidden tab / pagehide: let go here too, or a thumb
    // still down would light an arrow the fight no longer gets (and send nothing until it moves).
    const onHidden = () => {
      if (document.visibilityState === "hidden") releaseAll();
    };
    window.addEventListener("blur", releaseAll);
    window.addEventListener("pagehide", releaseAll);
    document.addEventListener("visibilitychange", onHidden);
    releaseControls.current = releaseAll;
    return () => {
      releaseAll();
      releaseControls.current = null;
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      el.removeEventListener("lostpointercapture", end);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("touchmove", stop);
      el.removeEventListener("touchend", lastTouch);
      el.removeEventListener("touchcancel", lastTouch);
      el.removeEventListener("contextmenu", stop);
      document.removeEventListener("gesturestart", stop);
      window.removeEventListener("blur", releaseAll);
      window.removeEventListener("pagehide", releaseAll);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [engine]);

  // Switching off (pause, match end, loading) lets go of everything; switching
  // back on starts clean, so nothing touched meanwhile fires.
  useEffect(() => {
    releaseControls.current?.();
    if (active) engine?.touch?.releaseAll();
  }, [active, engine]);

  // Tell the camera how far the buttons reach up into the fight (sideways,
  // they sit over its bottom corners; upright, they're under it: 0).
  useEffect(() => {
    if (!engine) return;
    const measure = () => {
      const a = area.current?.getBoundingClientRect();
      if (!a || a.height <= 0) return;
      let top = Infinity;
      for (const r of [dpadEl, peckEl, ctxEl]) {
        const b = r.current?.getBoundingClientRect();
        if (b && b.height > 0) top = Math.min(top, b.top);
      }
      engine.setBottomInset(Number.isFinite(top) ? Math.min(a.height, Math.max(0, a.bottom - top)) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    if (area.current) ro.observe(area.current);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", measure);
      // No buttons any more (touch mode off): nothing over the fight to keep clear.
      engine.setBottomInset(0);
    };
  }, [engine, area]);

  return (
    <div ref={root} className="touch-root" data-active={active ? "1" : "0"} data-testid="touch-controls">
      {/* The pad is for thumbs (screen readers get the timer and the pause menu). */}
      <div className="touch-zone touch-zone-dpad" data-zone="dpad" aria-hidden="true">
        <div ref={dpadEl} className="touch-dpad" role="img" aria-label="Direction pad" data-testid="touch-dpad">
          <span className="touch-arm touch-arm-u" />
          <span className="touch-arm touch-arm-d" />
          <span className="touch-arm touch-arm-l" />
          <span className="touch-arm touch-arm-r" />
          <span className="touch-hub" />
        </div>
      </div>
      <div className="touch-zone touch-zone-btns" data-zone="btns" aria-hidden="true">
        <div
          ref={ctxEl}
          className="touch-btn touch-btn-ctx"
          role="button"
          aria-label={ctxLabel}
          aria-disabled={ctxOff || undefined}
          data-testid="touch-ctx"
          data-label={ctxLabel}
          data-off={ctxOff ? "1" : ""}
        >
          <span>{ctxLabel}</span>
        </div>
        <div
          ref={peckEl}
          className="touch-btn touch-btn-peck"
          role="button"
          aria-label={peckLabel}
          data-testid="touch-peck"
          data-label={peckLabel}
          data-super={peckLabel === "SUPER" ? "1" : ""}
        >
          <span>{peckLabel}</span>
        </div>
      </div>
      <div className="touch-pills">
        {/* Clicks (a tap makes one here: touchstart isn't cancelled on the pills), so screen readers can press them too. */}
        <div
          className="touch-pill"
          role="button"
          aria-label={muted ? "Sound on" : "Sound off"}
          data-pill="mute"
          data-testid="touch-mute"
          onClick={() => active && onToggleMute()}
        >
          <span className="touch-pill-cap" />
          <span>{muted ? "SOUND OFF" : "SOUND"}</span>
        </div>
        <div className="touch-pill" role="button" aria-label="Pause" data-pill="pause" data-testid="touch-pause" onClick={() => active && onPause()}>
          <span className="touch-pill-cap" />
          <span>PAUSE</span>
        </div>
      </div>
    </div>
  );
}
