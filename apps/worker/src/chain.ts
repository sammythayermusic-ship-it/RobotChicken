/**
 * The Chain the treasury talks to, on Solana: PUMP transfers from the hot
 * wallet (ATA created for first-time winners), creator-fee distribution from
 * the pump.fun sharing config, the seed and cold moves, the Jupiter price.
 *
 * The hot and seed keys live only here, parsed from env at boot (Fly
 * secrets). Every transfer is signed before it is broadcast, so its
 * signature is in the ledger before the network ever sees it.
 */
import type { Chain, ClaimResult, Price, PreparedTransfer, TxStatus } from "@cockfight/economy";
import {
  JupiterPrice, Keypair, SolanaRpc, TOKEN_2022_PROGRAM, associatedTokenAddress, buildTransaction, createAssociatedTokenAccountIdempotent,
  decodeBondingCurve, decodeSharingConfig, distributeCreatorFeesV2, memo, pumpPda, setComputeUnitLimit, setComputeUnitPrice,
  transferChecked, transferCreatorFeesToPumpV2, type Instruction,
} from "@cockfight/solana";

export interface SolanaChainOptions {
  rpc: SolanaRpc;
  hot: Keypair;
  seed?: Keypair;
  cold?: string;
  /** The payout token (PUMP). */
  payoutMint: string;
  /** The coin whose creator fees we claim ($COCK); undefined disables claims. */
  cockMint?: string;
  prices: JupiterPrice;
  /** Priority fee in micro-lamports per compute unit. */
  priorityMicroLamports?: bigint;
  now?: () => number;
  /** Poll interval while waiting for a claim / seed / sweep to confirm (tests shorten it). */
  pollMs?: number;
}

/** A signed transaction older than this and still unseen can never land (a blockhash lives ~60-90 s). */
export const EXPIRED_AFTER_MS = 5 * 60_000;

export class SolanaChain implements Chain {
  readonly rpc: SolanaRpc;
  readonly hot: Keypair;
  readonly seed: Keypair | undefined;
  readonly cold: string | undefined;
  readonly payoutMint: string;
  readonly cockMint: string | undefined;
  private readonly prices: JupiterPrice;
  private readonly priority: bigint;
  private readonly now: () => number;
  private readonly pollMs: number;
  /** Set by init(): the payout mint's decimals and token program. */
  decimals = -1;
  tokenProgram = TOKEN_2022_PROGRAM;
  /** Blockhash of every transaction this process signed, to tell expired from pending. */
  private readonly blockhashes = new Map<string, string>();

  constructor(o: SolanaChainOptions) {
    this.rpc = o.rpc;
    this.hot = o.hot;
    this.seed = o.seed;
    this.cold = o.cold;
    this.payoutMint = o.payoutMint;
    this.cockMint = o.cockMint;
    this.prices = o.prices;
    this.priority = o.priorityMicroLamports ?? 100_000n;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? 1500;
  }

  /** Read the mint once: decimals and which token program owns it. */
  async init(): Promise<void> {
    const m = await this.rpc.getMint(this.payoutMint);
    this.decimals = m.decimals;
    this.tokenProgram = m.tokenProgram;
  }

  get hotAta(): string {
    return associatedTokenAddress(this.hot.publicKey, this.payoutMint, this.tokenProgram);
  }

  async price(): Promise<Price> {
    if (this.decimals < 0) await this.init();
    const usd = await this.prices.usdPrice(this.payoutMint);
    if (usd === null) throw new Error(`no price for ${this.payoutMint}`);
    return { usd, decimals: this.decimals };
  }

  async hotBalance(): Promise<bigint> {
    return (await this.rpc.getTokenAccountBalance(this.hotAta))?.amount ?? 0n;
  }

  async hotSol(): Promise<bigint> {
    return this.rpc.getBalance(this.hot.publicKey);
  }

  #budget(): Instruction[] {
    return [setComputeUnitLimit(80_000), setComputeUnitPrice(this.priority)];
  }

  /** Sign a PUMP transfer from `from` to `to`'s ATA (created if missing, rent paid by the hot wallet). */
  async #signTransfer(from: Keypair, to: string, amount: bigint, note: string): Promise<{ sig: string; base64: string }> {
    if (this.decimals < 0) await this.init();
    const { blockhash } = await this.rpc.getLatestBlockhash();
    const fromAta = associatedTokenAddress(from.publicKey, this.payoutMint, this.tokenProgram);
    const toAta = associatedTokenAddress(to, this.payoutMint, this.tokenProgram);
    const tx = buildTransaction({
      feePayer: this.hot,
      signers: from === this.hot ? [] : [from],
      recentBlockhash: blockhash,
      instructions: [
        ...this.#budget(),
        createAssociatedTokenAccountIdempotent(this.hot.publicKey, to, this.payoutMint, this.tokenProgram),
        transferChecked({ source: fromAta, mint: this.payoutMint, destination: toAta, owner: from.publicKey, amount, decimals: this.decimals, tokenProgram: this.tokenProgram }),
        memo(note),
      ],
    });
    this.blockhashes.set(tx.signature, blockhash);
    return { sig: tx.signature, base64: tx.base64 };
  }

  async prepareTransfer(to: string, amount: bigint, note: string): Promise<PreparedTransfer> {
    const { sig, base64 } = await this.#signTransfer(this.hot, to, amount, note);
    return { sig, submit: async () => void (await this.rpc.sendTransaction(base64)) };
  }

  async status(sig: string, sentAt: number): Promise<TxStatus> {
    const [st] = await this.rpc.getSignatureStatuses([sig]);
    if (st) {
      if (st.err) return "failed";
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "confirmed";
      return "unknown"; // processed: wait for confirmation
    }
    const bh = this.blockhashes.get(sig);
    if (bh) {
      if (await this.rpc.isBlockhashValid(bh)) return "unknown";
      this.blockhashes.delete(sig);
      return "expired";
    }
    return this.now() - sentAt > EXPIRED_AFTER_MS ? "expired" : "unknown";
  }

  /** Wait for a signature to confirm, fail or expire (for the sequential moves: claim, seed, sweep). */
  async #settle(sig: string, base64: string): Promise<string> {
    await this.rpc.sendTransaction(base64);
    const started = this.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      const st = await this.status(sig, started);
      if (st === "confirmed") return sig;
      if (st === "failed") throw new Error(`transaction failed: ${sig}`);
      if (st === "expired") throw new Error(`transaction expired unconfirmed: ${sig}`);
      if (this.now() - started > 120_000) throw new Error(`transaction still unconfirmed after 2 min: ${sig}`);
      // Not landed yet: send the same signed bytes again (same signature, so it can
      // only land once). Leaders drop transactions when busy; rebroadcasting until
      // the blockhash expires is what gets them through.
      await this.rpc.sendTransaction(base64).catch(() => undefined);
    }
  }

  /**
   * Distribute the coin's creator vault to the sharing config's shareholders
   * (the hot wallet is one of them). Permissionless: paid for and signed by
   * the hot wallet. After graduation the AMM-side fees are swept into the
   * vault first. Returns what landed in the hot wallet's PUMP account.
   */
  async claim(): Promise<ClaimResult | null> {
    if (!this.cockMint) return null;
    if (this.decimals < 0) await this.init();
    const curveAcc = await this.rpc.getAccountInfo(pumpPda.bondingCurve(this.cockMint));
    if (!curveAcc) throw new Error("bonding curve account not found: is COCK_MINT a pump.fun coin?");
    const curve = decodeBondingCurve(curveAcc.data);
    if (curve.quoteMint !== this.payoutMint) throw new Error(`the coin's quote mint ${curve.quoteMint} is not PAYOUT_MINT`);
    const sharingConfig = pumpPda.sharingConfig(this.cockMint);
    if (curve.creator !== sharingConfig) throw new Error("creator fees are not shared yet: set up 'Share creator rewards' on pump.fun first");
    const cfgAcc = await this.rpc.getAccountInfo(sharingConfig);
    if (!cfgAcc) throw new Error("sharing config account not found");
    const cfg = decodeSharingConfig(cfgAcc.data);
    if (!cfg.shareholders.some((s) => s.address === this.hot.publicKey)) throw new Error("the hot wallet is not a shareholder of the creator fees");

    const vault = pumpPda.creatorVault(sharingConfig);
    const vaultAta = associatedTokenAddress(vault, this.payoutMint, this.tokenProgram);
    const stage: "curve" | "amm" = curve.complete ? "amm" : "curve";
    const ixs: Instruction[] = [...this.#budget()];
    if (curve.complete) {
      const ammAuthority = pumpPda.ammCreatorVaultAuthority(sharingConfig);
      const ammAta = associatedTokenAddress(ammAuthority, this.payoutMint, this.tokenProgram);
      const amm = await this.rpc.getTokenAccountBalance(ammAta);
      if (amm && amm.amount > 0n) {
        ixs.push(transferCreatorFeesToPumpV2({ payer: this.hot.publicKey, coinCreator: sharingConfig, quoteMint: this.payoutMint, quoteTokenProgram: this.tokenProgram }));
      }
    }
    const inVault = (await this.rpc.getTokenAccountBalance(vaultAta))?.amount ?? 0n;
    if (inVault === 0n && ixs.length === 2) return null;
    ixs.push(
      distributeCreatorFeesV2({
        payer: this.hot.publicKey,
        mint: this.cockMint,
        quoteMint: this.payoutMint,
        quoteTokenProgram: this.tokenProgram,
        shareholders: cfg.shareholders.map((s) => s.address),
        initializeAta: true,
      }),
    );
    const before = await this.hotBalance();
    const { blockhash } = await this.rpc.getLatestBlockhash();
    const tx = buildTransaction({ feePayer: this.hot, recentBlockhash: blockhash, instructions: ixs });
    this.blockhashes.set(tx.signature, blockhash);
    await this.#settle(tx.signature, tx.base64);
    const after = await this.hotBalance();
    return { stage, received: after > before ? after - before : 0n, sig: tx.signature };
  }

  async seedTransfer(amount: bigint): Promise<string> {
    if (!this.seed) throw new Error("no SEED_WALLET_KEYPAIR: the seed cannot be drawn by the worker");
    const { sig, base64 } = await this.#signTransfer(this.seed, this.hot.publicKey, amount, "cockfight:seed");
    return this.#settle(sig, base64);
  }

  async sweep(amount: bigint): Promise<string | null> {
    if (!this.cold) return null;
    const { sig, base64 } = await this.#signTransfer(this.hot, this.cold, amount, "cockfight:sweep");
    return this.#settle(sig, base64);
  }
}
