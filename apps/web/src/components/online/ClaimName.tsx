"use client";

import { useState } from "react";
import bs58 from "bs58";
import { claimMessage, postUsername, postUsernameNonce } from "@/game/net/api";

/** The Solana wallet standard's window provider (Phantom, Solflare, Backpack): enough of it to sign a message. */
interface WalletProvider {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage(message: Uint8Array, display?: "utf8"): Promise<{ signature: Uint8Array } | Uint8Array>;
}

function provider(): WalletProvider | null {
  const w = window as unknown as { solana?: WalletProvider; phantom?: { solana?: WalletProvider } };
  return w.phantom?.solana ?? w.solana ?? null;
}

type Phase = { kind: "idle" } | { kind: "busy"; step: string } | { kind: "done"; name: string } | { kind: "error"; message: string };

/**
 * Claim a username by signing `cockfight:claim:<nonce>:<name>` with the
 * wallet. Nothing is sent on chain and nothing is spent: the signature only
 * proves the name belongs to the address.
 */
export function ClaimName({ address, onClaimed }: { address: string; onClaimed?: (name: string) => void }) {
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "busy";

  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) {
      setPhase({ kind: "error", message: "Names are 3-16 letters, digits or underscores." });
      return;
    }
    const wallet = provider();
    if (!wallet) {
      setPhase({ kind: "error", message: "No Solana wallet found in this browser. Open this page in your wallet's browser, or install Phantom." });
      return;
    }
    try {
      setPhase({ kind: "busy", step: "connecting the wallet…" });
      const connected = await wallet.connect();
      const pk = connected.publicKey.toBase58();
      if (pk !== address) {
        setPhase({ kind: "error", message: `The wallet is ${pk.slice(0, 4)}…${pk.slice(-4)}, not the address you play with. Switch accounts and try again.` });
        return;
      }
      setPhase({ kind: "busy", step: "getting a nonce…" });
      const nonce = await postUsernameNonce(address);
      if (!("nonce" in nonce)) {
        setPhase({ kind: "error", message: nonce.message });
        return;
      }
      setPhase({ kind: "busy", step: "sign the message in your wallet" });
      const signed = await wallet.signMessage(new TextEncoder().encode(claimMessage(nonce.nonce, n)), "utf8");
      const sig = signed instanceof Uint8Array ? signed : signed.signature;
      setPhase({ kind: "busy", step: "saving…" });
      const res = await postUsername({ address, name: n, nonce: nonce.nonce, signature: bs58.encode(sig) });
      if (!res.ok) {
        setPhase({ kind: "error", message: res.message });
        return;
      }
      setPhase({ kind: "done", name: res.name });
      onClaimed?.(res.name);
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error && err.message ? err.message : "The wallet didn't sign." });
    }
  };

  if (phase.kind === "done") {
    return (
      <p className="text-sm text-lime-300" data-testid="claim-name-done">
        You are <span className="font-display">{phase.name}</span> now.
      </p>
    );
  }
  return (
    <form className="flex flex-col gap-2" onSubmit={claim} data-testid="claim-name">
      <label htmlFor="claim-name" className="text-xs uppercase tracking-widest text-zinc-400">
        Claim a name (signed by your wallet, free)
      </label>
      <div className="flex gap-2">
        <input
          id="claim-name"
          value={name}
          maxLength={16}
          autoComplete="nickname"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. SirClucks"
          className="min-w-0 flex-1 rounded-lg border border-zinc-600 bg-black/50 px-3 py-2 text-base text-white placeholder:text-zinc-500 focus:border-amber-300 focus:outline-none"
        />
        <button type="submit" disabled={busy} className="rounded-lg border border-amber-300/60 px-4 font-display text-amber-200 disabled:opacity-50">
          {busy ? "…" : "SIGN & CLAIM"}
        </button>
      </div>
      {phase.kind === "busy" ? <p className="text-xs text-zinc-400">{phase.step}</p> : null}
      {phase.kind === "error" ? (
        <p className="text-xs text-red-200" role="alert">
          {phase.message}
        </p>
      ) : null}
    </form>
  );
}
