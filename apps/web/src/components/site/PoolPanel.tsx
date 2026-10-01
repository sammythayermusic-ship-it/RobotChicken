"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DAILY_SPLIT_BPS, fetchPayouts, fetchPool, formatRaw, formatUsd, rawUsd, txUrl, type PayoutRowView, type PoolView } from "@/lib/data";

const TIERS = [
  { id: "rust", label: "Rust", hold: "$30+" },
  { id: "chrome", label: "Chrome", hold: "$250+" },
  { id: "gold", label: "Gold", hold: "$1,000+" },
] as const;

/** hh:mm:ss until 00:00 UTC, from the server's clock offset by the time since it was read. */
function countdown(serverNow: string, readAt: number, now: number): string {
  const t = Date.parse(serverNow) + (now - readAt);
  const next = Math.ceil((t + 1) / 86_400_000) * 86_400_000;
  const s = Math.max(0, Math.floor((next - t) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

type State = { pool: PoolView | null; payouts: PayoutRowView[]; readAt: number; error?: string } | null;

/**
 * The live pool: what the next win pays per tier, today's top-10 pool with
 * its countdown, all-time fees and payouts, the prize pot, the last payouts
 * with their transactions. Every number comes from the ledger through
 * pool_v / payouts_v; nothing here is estimated.
 */
export function PoolPanel({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<State>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchPool(), fetchPayouts({ limit: compact ? 5 : 10 })])
        .then(([pool, payouts]) => alive && setState({ pool, payouts, readAt: Date.now() }))
        .catch(() => alive && setState({ pool: null, payouts: [], readAt: Date.now(), error: "Couldn't load the pool." }));
    void load();
    const poll = setInterval(() => void load(), 30_000);
    const tickNow = () => setNow(Date.now());
    const tick = setInterval(tickNow, 1000);
    tickNow();
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [compact]);

  if (state === null) {
    return (
      <section className="rounded-2xl border border-steel bg-ink/80 p-5" data-testid="pool" aria-busy="true">
        <p className="text-sm text-ash">Loading the pool…</p>
      </section>
    );
  }
  const { pool, payouts } = state;
  if (!pool) {
    return (
      <section className="rounded-2xl border border-steel bg-ink/80 p-5" data-testid="pool" data-state="offline">
        <h2 className="font-display text-xl text-amber">Prize pool</h2>
        <p className="mt-2 text-ash">
          {state.error ?? "Payouts start with the coin. Every win will pay from the trading fees, in PUMP, within seconds of the knockout."}
        </p>
        <Link href="/how-it-works" className="mt-3 inline-block text-sm font-semibold uppercase tracking-widest text-neon-cyan">
          How the pool works →
        </Link>
      </section>
    );
  }
  const d = pool.decimals;
  const usd = (raw: string) => formatUsd(rawUsd(raw, d, pool.priceUsd));
  const stale = now !== null && pool.computedAt !== null && now - Date.parse(pool.computedAt) > 10 * 60_000;
  return (
    <section className="rounded-2xl border border-steel bg-ink/80 p-5" data-testid="pool" data-state={pool.paused ? "paused" : stale ? "stale" : "live"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl text-amber">Prize pool</h2>
        <span className="text-xs uppercase tracking-widest text-ash">
          {pool.paused ? <span className="text-neon-pink">payouts paused</span> : stale ? <span className="text-amber">pool not updating</span> : "live · from the ledger"}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {TIERS.map((t) => (
          <div key={t.id} className="rounded-xl border border-steel/80 bg-pit/60 p-4" data-testid={`pool-win-${t.id}`}>
            <p className="text-xs uppercase tracking-widest text-ash">
              {t.label} <span className="text-ash/70">· hold {t.hold}</span>
            </p>
            <p className="mt-1 font-display text-2xl text-chrome">{usd(pool.win[t.id])}</p>
            <p className="font-mono text-xs text-ash">{formatRaw(pool.win[t.id], d)} per win</p>
          </div>
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-widest text-ash">Today&apos;s top-10 pool</dt>
          <dd className="font-display text-lg text-chrome" data-testid="pool-daily">
            {usd(pool.dailyPool)}
          </dd>
          <dd className="font-mono text-xs text-ash">{now !== null ? `pays in ${countdown(pool.now, state.readAt, now)}` : ""}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-widest text-ash">Fees claimed (24 h)</dt>
          <dd className="font-display text-lg text-chrome">{usd(pool.gross24h)}</dd>
          <dd className="font-mono text-xs text-ash">{formatRaw(pool.gross24h, d)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-widest text-ash">Paid to players</dt>
          <dd className="font-display text-lg text-chrome">{formatUsd(pool.paidUsdAll)}</dd>
          <dd className="font-mono text-xs text-ash">
            {pool.paidCountAll.toLocaleString("en-US")} payouts · {formatRaw(pool.paidAll, d)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-widest text-ash">Prize pot</dt>
          <dd className="font-display text-lg text-chrome" data-testid="pool-pot">{usd(pool.pot)}</dd>
          <dd className="font-mono text-xs text-ash">{formatRaw(pool.pot, d)}</dd>
        </div>
      </dl>

      {!compact ? (
        <div className="mt-4 rounded-xl border border-steel/60 p-3">
          <p className="text-xs uppercase tracking-widest text-ash">What each rank earns from today&apos;s pool right now</p>
          <ol className="mt-2 grid grid-cols-5 gap-1 font-mono text-xs text-chrome sm:grid-cols-10">
            {DAILY_SPLIT_BPS.map((bps, i) => (
              <li key={i} className="rounded bg-pit/60 px-1 py-1 text-center">
                <span className="text-ash">#{i + 1}</span> {formatUsd((rawUsd(pool.dailyPool, d, pool.priceUsd) * bps) / 10_000)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {payouts.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-widest text-ash">Latest payouts</p>
          <ul className="mt-2 divide-y divide-steel/60 text-sm" data-testid="pool-payouts">
            {payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  <Link href={`/p/${p.address}`} className="font-semibold text-chrome hover:text-neon-cyan">
                    {p.name}
                  </Link>{" "}
                  <span className="text-ash">{p.kind === "daily" ? `#${p.rank} on ${p.day}` : "won"}</span>
                </span>
                <span className="font-mono text-xs">
                  <span className="text-chrome">{formatUsd(p.usd)}</span> <span className="text-ash">{formatRaw(p.amount, d)}</span>{" "}
                  {p.sig ? (
                    <a href={txUrl(p.sig)} target="_blank" rel="noreferrer" className="text-neon-cyan">
                      tx ↗
                    </a>
                  ) : (
                    <span className="text-ash">{p.status === "deferred" ? "queued" : "sending…"}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-ash">
        3% of every $COCK trade on pump.fun is the creator fee; 70% of it is the players&apos;. Every win pays a share of the pot (Rust 5%, Chrome 8%, Gold 12%), so it can never pay out more than it holds.{" "}
        <Link href="/how-it-works" className="text-neon-cyan">
          How it works →
        </Link>
      </p>
    </section>
  );
}
