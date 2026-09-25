"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { isWalletAddress } from "@cockfight/solana";
import { ClaimName } from "@/components/online/ClaimName";
import { TierBadge } from "@/components/online/OnlineLobby";
import { fetchPayouts, fetchProfile, formatRaw, formatUsd, txUrl, type PayoutRowView, type ProfileView } from "@/lib/data";

/** Spec caps, shown so a player knows where they stand. */
const MAX_PAID_WINS_PER_DAY = 40;
const PAYOUT_DECIMALS = 6;

function useAddress(): string | null | undefined {
  const sp = useSearchParams();
  const fromQuery = sp.get("address");
  const [fromPath, setFromPath] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = () => {
      const seg = window.location.pathname.split("/").filter(Boolean);
      setFromPath(seg[0] === "p" && seg[1] ? decodeURIComponent(seg[1]) : null);
    };
    read();
  }, []);
  if (fromPath === undefined) return undefined;
  return fromPath ?? fromQuery;
}

type State = { kind: "loading" } | { kind: "bad" } | { kind: "none" } | { kind: "error"; message: string } | { kind: "ready"; p: ProfileView; payouts: PayoutRowView[] };

export default function ProfileClient() {
  const address = useAddress();
  const [loaded, setLoaded] = useState<State>({ kind: "loading" });
  const bad = address !== undefined && (!address || !isWalletAddress(address));
  const state: State = bad ? { kind: "bad" } : loaded;

  useEffect(() => {
    if (address === undefined || !address || !isWalletAddress(address)) return;
    const setState = setLoaded;
    let alive = true;
    Promise.all([fetchProfile(address), fetchPayouts({ address, limit: 20 })])
      .then(([p, payouts]) => alive && setState(p ? { kind: "ready", p, payouts } : { kind: "none" }))
      .catch((e: unknown) => alive && setState({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load the profile." }));
    return () => {
      alive = false;
    };
  }, [address]);

  return (
    <main className="min-h-dvh" data-testid="profile">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between">
          <Link href="/" className="font-display text-sm tracking-wider text-chrome">
            COCKFIGHT
          </Link>
          <Link href="/leaderboard" className="text-sm font-semibold uppercase tracking-widest text-ash hover:text-chrome">
            Leaderboard
          </Link>
        </div>
        {state.kind === "loading" ? <p className="text-ash">Loading…</p> : null}
        {state.kind === "bad" ? <p className="text-ash">That isn&apos;t a wallet address.</p> : null}
        {state.kind === "none" ? (
          <>
            <p className="text-ash">
              No ranked matches for this wallet yet (or payouts aren&apos;t live). <Link href="/play?mode=online" className="text-neon-cyan">Fight →</Link>
            </p>
            {address ? <ClaimName address={address} /> : null}
          </>
        ) : null}
        {state.kind === "error" ? <p className="text-neon-pink">{state.message}</p> : null}
        {state.kind === "ready" ? <Profile p={state.p} payouts={state.payouts} /> : null}
        {state.kind === "ready" && address ? (
          <section className="rounded-xl border border-steel bg-ink/80 p-4">
            <ClaimName address={address} onClaimed={(name) => setLoaded((s) => (s.kind === "ready" ? { ...s, p: { ...s.p, name } } : s))} />
            <p className="mt-2 text-xs text-ash">Only the wallet&apos;s owner can sign; a pasted address can&apos;t take a name.</p>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function Profile({ p, payouts }: { p: ProfileView; payouts: PayoutRowView[] }) {
  const rate = (w: number, m: number) => (m ? `${Math.round((w / m) * 100)}%` : "–");
  return (
    <>
      <header>
        <h1 className="font-display text-4xl text-chrome sm:text-5xl">{p.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-ash">
          <span className="break-all">{p.address}</span>
          {p.tier ? <TierBadge tier={p.tier} /> : null}
        </p>
      </header>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="profile-stats">
        <Stat label="Today" value={`${p.winsToday} W / ${p.matchesToday - p.winsToday} L`} sub={p.rankToday ? `#${p.rankToday} on the board` : "not on the board yet"} />
        <Stat label="Earned today" value={formatUsd(p.earnedUsdToday)} sub={formatRaw(p.earnedToday, PAYOUT_DECIMALS)} />
        <Stat label="Earned all time" value={formatUsd(p.earnedUsdAll)} sub={formatRaw(p.earnedAll, PAYOUT_DECIMALS)} />
        <Stat label="ELO" value={String(p.elo ?? "–")} sub={`${p.winsAll} wins · ${rate(p.winsAll, p.matchesAll)} all time`} />
      </dl>
      <div className="rounded-xl border border-steel bg-ink/80 p-4 text-sm text-ash" data-testid="profile-caps">
        <p className="text-xs uppercase tracking-widest">Today&apos;s caps (reset 00:00 UTC)</p>
        <p className="mt-1">
          <span className="font-mono text-chrome">
            {Math.min(p.winsToday, MAX_PAID_WINS_PER_DAY)} / {MAX_PAID_WINS_PER_DAY}
          </span>{" "}
          paid wins used · 10 paid matches per opponent · 7-day record {p.wins7d} W / {p.matches7d - p.wins7d} L ({rate(p.wins7d, p.matches7d)})
        </p>
      </div>
      <section>
        <h2 className="font-display text-xl text-amber">Payouts</h2>
        {payouts.length === 0 ? (
          <p className="mt-2 text-ash">No payouts yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-steel/60 text-sm" data-testid="profile-payouts">
            {payouts.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-ash">
                  {x.kind === "daily" ? `#${x.rank} on ${x.day}` : "win"}
                  {x.matchId ? (
                    <>
                      {" · "}
                      <Link href={`/m/${x.matchId}`} className="text-neon-cyan">
                        replay
                      </Link>
                    </>
                  ) : null}
                </span>
                <span className="font-mono text-xs">
                  <span className="text-chrome">{formatUsd(x.usd)}</span> <span className="text-ash">{formatRaw(x.amount, PAYOUT_DECIMALS)}</span>{" "}
                  {x.sig ? (
                    <a href={txUrl(x.sig)} target="_blank" rel="noreferrer" className="text-neon-cyan">
                      tx ↗
                    </a>
                  ) : (
                    <span className="text-ash">{x.status}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-steel bg-ink/80 p-3">
      <dt className="text-xs uppercase tracking-widest text-ash">{label}</dt>
      <dd className="font-display text-xl text-chrome">{value}</dd>
      <dd className="font-mono text-xs text-ash">{sub}</dd>
    </div>
  );
}
