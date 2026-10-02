"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The landing page's one way in: paste the wallet, press FIGHT. /play opens
 * the online lobby with the address filled in and checks it at once, so this
 * is the only press. Empty, FIGHT still goes to the lobby.
 */
export function LandingFight({ gateUsd }: { gateUsd: number }) {
  const router = useRouter();
  const [wallet, setWallet] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3"
        data-testid="landing-wallet"
        onSubmit={(e) => {
          e.preventDefault();
          const w = wallet.trim();
          router.push(w ? `/play?wallet=${encodeURIComponent(w)}` : "/play");
        }}
      >
        <label htmlFor="wallet" className="text-sm font-semibold uppercase tracking-wider text-ash">
          Solana wallet address
        </label>
        <input
          id="wallet"
          name="wallet"
          type="text"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="Paste your wallet address"
          autoComplete="off"
          aria-describedby="wallet-note"
          spellCheck={false}
          className="w-full rounded-lg border border-steel bg-pit/70 px-3 py-3 font-mono text-sm text-chrome placeholder:text-ash/60 focus:border-neon-cyan focus:outline-none"
        />
        <button
          type="submit"
          className="block rounded-xl bg-neon-pink py-4 text-center font-display text-2xl tracking-wider text-pit shadow-[0_0_28px_-4px_rgb(255_46_136/0.8)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neon-cyan"
        >
          FIGHT
        </button>
      </form>
      <p id="wallet-note" className="text-sm text-ash">
        Hold ${gateUsd} of $COCK to play. The address is only read, never charged, and nothing is wagered.
      </p>
      <Link href="/play?practice=1" className="self-start text-sm text-ash underline underline-offset-4 hover:text-chrome">
        No $COCK yet? Practice against the CPU for free →
      </Link>
    </div>
  );
}
