"use client";
import { useEffect, useState } from "react";
import { Client, type Room } from "@colyseus/sdk";
import { publicEnv } from "@/env.public";

/**
 * The Phase 0 FightRoom state. No schema class is passed to join, so the SDK
 * decodes the state from the reflection the server sends in the handshake;
 * the fields are read defensively because Phase 2 replaces this protocol.
 */
interface FightStateView {
  tick?: number;
  phase?: number | string;
}

type Probe =
  | { kind: "connecting" }
  | { kind: "joined"; roomId: string; sessionId: string; tick: number | null; phase: string; patches: number; pingMs: number | null }
  | { kind: "left"; code: number; reason?: string }
  | { kind: "error"; message: string };

const ROOM = "fight";

export function NetProbe() {
  const url = publicEnv.NEXT_PUBLIC_GAME_WS_URL;
  const [probe, setProbe] = useState<Probe>({ kind: "connecting" });

  useEffect(() => {
    // StrictMode mounts twice in dev: the first join may resolve after its
    // cleanup ran, so it must leave instead of taking over the view.
    let active = true;
    let room: Room<unknown, FightStateView> | null = null;
    let pinger: ReturnType<typeof setInterval> | undefined;

    new Client(url)
      .joinOrCreate<FightStateView>(ROOM)
      .then((r) => {
        if (!active) {
          void r.leave();
          return;
        }
        room = r;
        setProbe({ kind: "joined", roomId: r.roomId, sessionId: r.sessionId, tick: null, phase: "?", patches: 0, pingMs: null });
        r.onStateChange((state) => {
          setProbe((p) =>
            p.kind === "joined"
              ? { ...p, tick: typeof state.tick === "number" ? state.tick : null, phase: String(state.phase ?? "?"), patches: p.patches + 1 }
              : p,
          );
        });
        r.onLeave((code, reason) => setProbe({ kind: "left", code, reason }));
        r.onError((code, message) => setProbe({ kind: "error", message: `room error ${code}${message ? `: ${message}` : ""}` }));
        const ping = () => r.ping((ms) => setProbe((p) => (p.kind === "joined" ? { ...p, pingMs: ms } : p)));
        ping();
        pinger = setInterval(ping, 2000);
      })
      .catch((err: unknown) => {
        if (active) setProbe({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      active = false;
      clearInterval(pinger);
      void room?.leave();
    };
  }, [url]);

  return (
    <section className="mt-6 rounded-xl border border-steel bg-ink p-5 font-mono text-sm" aria-live="polite">
      <Row k="endpoint" v={url} />
      <Row k="room" v={ROOM} />
      {probe.kind === "connecting" && <Row k="status" v="connecting…" />}
      {probe.kind === "joined" && (
        <>
          <Row k="status" v="joined" />
          <Row k="roomId" v={probe.roomId} />
          <Row k="sessionId" v={probe.sessionId} />
          <Row k="tick" v={probe.tick === null ? "—" : String(probe.tick)} testId="net-tick" />
          <Row k="phase" v={probe.phase} testId="net-phase" />
          <Row k="patches" v={String(probe.patches)} />
          <Row k="ping" v={probe.pingMs === null ? "—" : `${probe.pingMs} ms`} />
        </>
      )}
      {probe.kind === "left" && <Row k="status" v={`left (code ${probe.code}${probe.reason ? `, ${probe.reason}` : ""})`} />}
      {probe.kind === "error" && <Row k="status" v={`error: ${probe.message}`} />}
    </section>
  );
}

function Row({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return (
    <div className="flex gap-4 py-0.5">
      <span className="w-24 shrink-0 text-ash">{k}</span>
      <span className="break-all text-chrome" data-testid={testId}>
        {v}
      </span>
    </div>
  );
}
