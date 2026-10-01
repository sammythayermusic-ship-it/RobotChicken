"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Tier } from "@cockfight/shared";
import { anonName, isWalletAddress } from "@cockfight/solana";
import { publicEnv } from "@/env.public";
import { fetchConfig, postGate, probeRtt, type ServerConfig } from "@/game/net/api";
import { guestId, saveName, saveToken, saveWallet, savedName, savedToken, savedWallet } from "@/game/net/identity";
import { QueueKick, joinQueue, type NetSession, type QueueHandle } from "@/game/net/session";
import { Turnstile } from "./Turnstile";

type Phase =
  | { kind: "loading" }
  | { kind: "form" }
  | { kind: "checking" }
  | { kind: "short"; usd: number; shortUsd: number; gateUsd: number }
  | { kind: "queue"; since: number }
  | { kind: "matched"; opponent: string }
  | { kind: "error"; message: string; retry: boolean };

const TIER_LOOK: Record<Tier, string> = {
  rust: "border-orange-700 bg-orange-900/40 text-orange-200",
  chrome: "border-sky-300 bg-sky-900/30 text-sky-100",
  gold: "border-yellow-400 bg-yellow-700/30 text-yellow-100",
  diamond: "border-fuchsia-300 bg-fuchsia-800/30 text-fuchsia-100",
};

export function TierBadge({ tier }: { tier: Tier }) {
  return <span className={`rounded-full border px-2 py-0.5 font-display text-xs tracking-widest ${TIER_LOOK[tier]}`}>{tier.toUpperCase()}</span>;
}

/** Where to buy $COCK (Jupiter swap from SOL). */
export function buyUrl(mint: string | null): string | null {
  return mint ? `https://jup.ag/swap/SOL-${mint}` : null;
}

/**
 * Online entry: the open playtest (a name) or the wallet gate (paste +
 * Turnstile + balance check), then the queue until the server pairs this
 * player. `auto` re-queues straight away when it can (after a match).
 */
export function OnlineLobby({ auto, wallet: walletParam, onMatched, onBack }: {
  auto: boolean;
  wallet?: string | null;
  onMatched: (s: NetSession) => void;
  onBack: () => void;
}) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Rendered only in the browser (/play reads its URL there), so storage is readable here.
  const [name, setName] = useState(() => (typeof window === "undefined" ? "" : savedName()));
  const [wallet, setWallet] = useState(() =>
    typeof window === "undefined" ? "" : walletParam && isWalletAddress(walletParam) ? walletParam : savedWallet(),
  );
  const [turnstile, setTurnstile] = useState<string | null>(null);
  const [tsKey, setTsKey] = useState(0);
  const [tsFailed, setTsFailed] = useState(false);
  const [size, setSize] = useState(0);
  const [full, setFull] = useState(false);
  const [rtt, setRtt] = useState<number | null>(null);
  const [me, setMe] = useState<{ tier: Tier; usd: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const queue = useRef<QueueHandle | null>(null);
  /**
   * Each queue attempt gets a number; cancelling, going back or unmounting
   * bumps it. Every await re-checks it, so a stale attempt (a join or a
   * "matched" that lands after the player cancelled) cleans up after itself
   * instead of taking over the screen.
   */
  const attempt = useRef(0);
  const vsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMatchedRef = useRef(onMatched);
  const gateUsdRef = useRef(30);
  useEffect(() => {
    onMatchedRef.current = onMatched;
    gateUsdRef.current = config?.gateUsd ?? 30;
  });

  const stopQueue = useCallback(async () => {
    attempt.current++;
    if (vsTimer.current) clearTimeout(vsTimer.current);
    vsTimer.current = null;
    const q = queue.current;
    queue.current = null;
    await q?.leave();
  }, []);

  const enterQueue = useCallback(
    async (opts: { token?: string; name?: string }, who: { name: string; tier: Tier }) => {
      await stopQueue();
      const my = attempt.current;
      const live = () => attempt.current === my;
      setPhase({ kind: "queue", since: Date.now() });
      let q: QueueHandle | null = null;
      try {
        const ms = await probeRtt();
        if (!live()) return;
        setRtt(ms);
        // The per-browser id: the open queue's one ticket per browser, and ranked mode's fingerprint.
        q = await joinQueue({ ...opts, guestId: opts.name ? guestId() : undefined, fp: opts.token ? guestId() : undefined, rtt: ms }, who);
        if (!live()) {
          await q.leave();
          return;
        }
        queue.current = q;
        q.onSize(setSize);
        q.onFull(setFull);
        const session = await q.matched;
        if (!live()) {
          await session.leave();
          session.dispose();
          return;
        }
        queue.current = null;
        setPhase({ kind: "matched", opponent: session.seating.names[session.side === 0 ? 1 : 0] });
        // A beat to read the VS card, then the fight loads.
        vsTimer.current = setTimeout(() => {
          vsTimer.current = null;
          if (live()) onMatchedRef.current(session);
          else {
            void session.leave();
            session.dispose();
          }
        }, 900);
      } catch (e) {
        if (!live()) return;
        if (queue.current === q) queue.current = null;
        if (e instanceof QueueKick && e.reason === "gate") {
          saveToken(null);
          setPhase({ kind: "short", usd: e.usd ?? 0, shortUsd: e.shortUsd ?? 0, gateUsd: gateUsdRef.current });
          return;
        }
        const msg = e instanceof Error && e.message ? e.message : "Couldn't reach the game server.";
        // A saved queue token the server no longer takes: forget it (the form asks for a fresh check).
        if (opts.token && /token/i.test(msg)) saveToken(null);
        setPhase({ kind: "error", message: msg, retry: true });
      }
    },
    [stopQueue],
  );

  const loadConfig = useCallback(
    (autoQueue: boolean) => {
      let alive = true;
      fetchConfig()
        .then((c) => {
          if (!alive) return;
          setConfig(c);
          setPhase({ kind: "form" });
          if (!autoQueue) return;
          if (c.gate === "open") {
            const n = savedName();
            if (n) void enterQueue({ name: n }, { name: n, tier: "rust" });
          } else {
            const t = savedToken();
            if (t) {
              setMe({ tier: t.tier as Tier, usd: t.usd });
              void enterQueue({ token: t.token }, { name: t.name ?? anonName(t.address), tier: t.tier as Tier });
            }
          }
        })
        .catch(() => alive && setPhase({ kind: "error", message: "Can't reach the game server right now.", retry: false }));
      return () => {
        alive = false;
      };
    },
    [enterQueue],
  );

  // Server config (open or gated), remembered identity, and auto re-queue.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  useEffect(() => loadConfig(auto), []);

  // Leave the queue (and drop a match not yet shown) if this screen goes away.
  useEffect(
    () => () => {
      void stopQueue();
    },
    [stopQueue],
  );

  useEffect(() => {
    if (phase.kind !== "queue") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [phase.kind]);

  const submitOpen = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!/^[A-Za-z0-9 _-]{1,16}$/.test(n)) {
      setPhase({ kind: "error", message: "Names are 1–16 letters, digits, spaces, _ or -.", retry: true });
      return;
    }
    saveName(n);
    void enterQueue({ name: n }, { name: n, tier: "rust" });
  };

  const submitWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    const w = wallet.trim();
    if (!isWalletAddress(w)) {
      setPhase({ kind: "error", message: "That isn't a Solana wallet address. Paste the address your $COCK is in.", retry: true });
      return;
    }
    if (!turnstile) return;
    saveWallet(w);
    setPhase({ kind: "checking" });
    const token = turnstile;
    setTurnstile(null);
    setTsKey((k) => k + 1); // a token is single use: the next check needs a fresh one
    const ans = await postGate(w, token).catch(() => null);
    if (!ans) {
      setPhase({ kind: "error", message: "Can't reach the game server right now.", retry: true });
    } else if (ans.ok) {
      setMe({ tier: ans.tier, usd: ans.usd });
      saveToken({ token: ans.token, address: w, tier: ans.tier, usd: ans.usd, name: ans.name ?? null });
      void enterQueue({ token: ans.token }, { name: ans.name ?? anonName(w), tier: ans.tier });
    } else if ("shortUsd" in ans) {
      setPhase({ kind: "short", usd: ans.usd, shortUsd: ans.shortUsd, gateUsd: ans.gateUsd });
    } else {
      setPhase({ kind: "error", message: ans.message, retry: true });
    }
  };

  const cancel = async () => {
    setPhase({ kind: "form" });
    await stopQueue();
  };

  const back = () => {
    void stopQueue();
    onBack();
  };

  const gated = config?.gate === "required";
  const buy = buyUrl(config?.mint ?? null);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-8" data-testid="online-lobby">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl text-white sm:text-5xl">ONLINE</h1>
        <button type="button" className="text-sm text-zinc-400 underline underline-offset-4" onClick={back}>
          Back
        </button>
      </div>

      {phase.kind === "loading" ? <p className="text-zinc-400">Connecting to the pit…</p> : null}

      {config && !gated && (phase.kind === "form" || phase.kind === "error") ? (
        <form className="flex flex-col gap-3" onSubmit={submitOpen} data-testid="open-form">
          <p className="rounded-lg border border-cyan-400/40 bg-cyan-950/30 p-3 text-sm text-cyan-100">
            Playtest mode: anyone can fight, no wallet needed. Matches here don&apos;t count toward the real leaderboard or pay out.
          </p>
          <label htmlFor="fighter-name" className="text-xs uppercase tracking-widest text-zinc-400">
            Your fighter&apos;s name
          </label>
          <input
            id="fighter-name"
            value={name}
            maxLength={16}
            autoComplete="nickname"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sir Clucks"
            className="rounded-lg border border-zinc-600 bg-black/50 px-3 py-3 text-base text-white placeholder:text-zinc-500 focus:border-amber-300 focus:outline-none"
          />
          <button
            type="submit"
            data-testid="find-match"
            className="rounded-lg bg-gradient-to-b from-orange-400 to-red-600 py-4 font-display text-2xl tracking-widest text-white shadow-[0_6px_0_#7c2d12] transition active:translate-y-1 active:shadow-[0_2px_0_#7c2d12]"
          >
            FIND MATCH
          </button>
        </form>
      ) : null}

      {config && gated && (phase.kind === "form" || phase.kind === "error") ? (
        <form className="flex flex-col gap-3" onSubmit={submitWallet} data-testid="wallet-form">
          <label htmlFor="wallet" className="text-xs uppercase tracking-widest text-zinc-400">
            Solana wallet address
          </label>
          <input
            id="wallet"
            value={wallet}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="Paste the wallet that holds your $COCK"
            className="rounded-lg border border-zinc-600 bg-black/50 px-3 py-3 font-mono text-sm text-white placeholder:text-zinc-500 focus:border-amber-300 focus:outline-none"
          />
          <p className="text-xs text-zinc-400">
            Hold at least ${config.gateUsd} of $COCK to play. The address is only read, never charged, and nothing you hold is wagered.
            {isWalletAddress(wallet.trim()) ? (
              <>
                {" "}
                <Link href={`/p/${wallet.trim()}`} className="text-cyan-300">
                  Your profile & name →
                </Link>
              </>
            ) : null}
          </p>
          <Turnstile key={tsKey} siteKey={publicEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY} onToken={setTurnstile} onError={() => setTsFailed(true)} />
          {tsFailed ? (
            <p className="text-sm text-red-200" role="alert">
              The bot check didn&apos;t load. Check your connection (or ad blocker), then{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setTsFailed(false);
                  setTsKey((k) => k + 1);
                }}
              >
                try again
              </button>
              .
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!turnstile}
            data-testid="check-wallet"
            className="rounded-lg bg-gradient-to-b from-orange-400 to-red-600 py-4 font-display text-2xl tracking-widest text-white shadow-[0_6px_0_#7c2d12] transition enabled:active:translate-y-1 disabled:opacity-50"
          >
            {turnstile ? "CHECK WALLET & FIGHT" : "CHECKING YOU'RE HUMAN…"}
          </button>
        </form>
      ) : null}

      {phase.kind === "error" ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-500/50 bg-red-950/40 p-3 text-sm text-red-200" data-testid="lobby-error">
          <p>{phase.message}</p>
          {!config ? (
            <button type="button" className="self-start rounded border border-red-300/60 px-3 py-1 font-display text-red-100" onClick={() => {
                setPhase({ kind: "loading" });
                loadConfig(auto);
              }}>
              TRY AGAIN
            </button>
          ) : null}
          {/reload/i.test(phase.message) ? (
            <button type="button" className="self-start rounded border border-red-300/60 px-3 py-1 font-display text-red-100" onClick={() => window.location.reload()}>
              RELOAD
            </button>
          ) : null}
        </div>
      ) : null}

      {phase.kind === "checking" ? <p className="text-zinc-300">Reading your wallet…</p> : null}

      {phase.kind === "short" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-400/50 bg-amber-950/30 p-5" data-testid="gate-short">
          <p className="font-display text-2xl text-amber-200">
            ${phase.shortUsd.toFixed(2)} TO GO
          </p>
          <p className="text-zinc-200">
            This wallet holds ${phase.usd.toFixed(2)} of $COCK. The pit opens at ${phase.gateUsd}. Nothing is wagered: you keep every token.
          </p>
          {buy ? (
            <a href={buy} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-amber-400 py-3 text-center font-display text-xl text-black">
              BUY $COCK
            </a>
          ) : null}
          <button type="button" className="rounded-lg border border-zinc-600 py-3 font-display text-zinc-200" onClick={() => setPhase({ kind: "form" })}>
            CHECK AGAIN
          </button>
        </div>
      ) : null}

      {phase.kind === "queue" ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-zinc-700 bg-black/40 p-6 text-center" data-testid="queue">
          <p className="animate-pulse font-display text-3xl text-white">FINDING AN OPPONENT</p>
          {full ? (
            <p className="text-sm text-amber-300" data-testid="queue-full">
              Every pit is busy. You keep your place in line; a fight starts as soon as one ends.
            </p>
          ) : null}
          <p className="font-mono text-4xl text-amber-300" aria-live="off">
            {Math.max(0, Math.floor((now - phase.since) / 1000))}s
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-zinc-400">
            {me ? <TierBadge tier={me.tier} /> : null}
            <span data-testid="queue-size">{size} in queue</span>
            {rtt !== null ? <span>ping {rtt} ms</span> : null}
            {config ? <span>region {config.region}</span> : null}
          </div>
          <button type="button" className="rounded-lg border border-zinc-600 px-6 py-2 font-display text-zinc-200" onClick={() => void cancel()}>
            CANCEL
          </button>
        </div>
      ) : null}

      {phase.kind === "matched" ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-amber-400/60 bg-black/50 p-8 text-center" data-testid="matched">
          <p className="font-display text-xl text-zinc-400">OPPONENT FOUND</p>
          <p className="font-display text-4xl text-white">VS {phase.opponent}</p>
        </div>
      ) : null}
    </div>
  );
}
