/**
 * SolanaChain against a fake JSON-RPC: transfers are signed before they are
 * sent, statuses map to the treasury's four states, expiry is told from
 * pending, and the claim builds the pump.fun distribution from the on-chain
 * bonding curve and sharing config.
 */
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { JupiterPrice, Keypair, SolanaRpc, TOKEN_2022_PROGRAM, associatedTokenAddress, pumpPda, u64le } from "@cockfight/solana";
import { EXPIRED_AFTER_MS, SolanaChain } from "../src/chain";

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + n) & 0xff);
const hot = Keypair.fromSecret(bs58.encode(seed(1)));
const seedWallet = Keypair.fromSecret(bs58.encode(seed(2)));
const winner = Keypair.fromSecret(bs58.encode(seed(3))).publicKey;
const cold = Keypair.fromSecret(bs58.encode(seed(4))).publicKey;
const launch = Keypair.fromSecret(bs58.encode(seed(5))).publicKey;
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const COCK = "HFypaAkLk4XwKJvLK5hTvL65dhY2F61davhjo1x8pump";
const BLOCKHASH = bs58.encode(seed(9));

interface Sent {
  base64: string;
}

/** A fake node: balances, accounts, statuses set by the test; every sendTransaction is recorded. */
class FakeRpc {
  sent: Sent[] = [];
  statuses = new Map<string, { err: unknown; confirmationStatus: string }>();
  blockhashValid = true;
  balances = new Map<string, bigint>();
  accounts = new Map<string, Uint8Array>();
  sol = 1_000_000_000n;
  price = 0.005;
  calls: string[] = [];
  /** Called with every broadcast's signature (a test can confirm it and move balances). */
  onSend: ((sig: string) => void) | null = null;

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.startsWith("https://price/")) {
      return Response.json({ [PUMP]: { usdPrice: this.price } });
    }
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    this.calls.push(req.method);
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: req.id, result });
    const error = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id: req.id, error: { code, message } });
    switch (req.method) {
      case "getAccountInfo": {
        const [addr, opts] = req.params as [string, { encoding: string }];
        if (addr === PUMP && opts.encoding === "jsonParsed") return reply({ value: { owner: TOKEN_2022_PROGRAM, data: { parsed: { info: { decimals: 6 } } } } });
        const data = this.accounts.get(addr);
        return reply({ value: data ? { data: [Buffer.from(data).toString("base64"), "base64"], owner: "x", lamports: 1 } : null });
      }
      case "getLatestBlockhash":
        return reply({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } });
      case "isBlockhashValid":
        return reply({ value: this.blockhashValid });
      case "getBalance":
        return reply({ value: Number(this.sol) });
      case "getTokenAccountBalance": {
        const [acc] = req.params as [string];
        const b = this.balances.get(acc);
        return b === undefined ? error(-32602, `Invalid param: could not find account`) : reply({ value: { amount: b.toString(), decimals: 6 } });
      }
      case "sendTransaction": {
        const [base64] = req.params as [string];
        this.sent.push({ base64 });
        const bytes = Buffer.from(base64, "base64");
        const sig = bs58.encode(bytes.subarray(1, 65));
        this.onSend?.(sig);
        return reply(sig);
      }
      case "getSignatureStatuses": {
        const [sigs] = req.params as [string[]];
        return reply({ value: sigs.map((s) => this.statuses.get(s) ?? null) });
      }
      default:
        return error(-32601, `unknown method ${req.method}`);
    }
  };
}

function make(o: { seed?: boolean; cold?: boolean; cock?: boolean; now?: () => number } = {}) {
  const rpc = new FakeRpc();
  const chain = new SolanaChain({
    rpc: new SolanaRpc("https://rpc/", { fetch: rpc.fetch }),
    hot,
    seed: o.seed ? seedWallet : undefined,
    cold: o.cold ? cold : undefined,
    payoutMint: PUMP,
    cockMint: o.cock ? COCK : undefined,
    prices: new JupiterPrice("https://price/", undefined, rpc.fetch),
    now: o.now,
    pollMs: 5,
  });
  return { rpc, chain };
}

describe("SolanaChain", () => {
  it("reads the mint once, prices from Jupiter, and reads balances", async () => {
    const { rpc, chain } = make();
    await chain.init();
    expect(chain.decimals).toBe(6);
    expect(chain.tokenProgram).toBe(TOKEN_2022_PROGRAM);
    expect(await chain.price()).toEqual({ usd: 0.005, decimals: 6 });
    expect(await chain.hotBalance()).toBe(0n); // no ATA yet
    rpc.balances.set(chain.hotAta, 5_000_000n);
    expect(await chain.hotBalance()).toBe(5_000_000n);
    expect(await chain.hotSol()).toBe(1_000_000_000n);
  });

  it("signs a transfer before it is sent, sends it on submit, and reports its status", async () => {
    const t = 1_000_000;
    const { rpc, chain } = make({ now: () => t });
    const tx = await chain.prepareTransfer(winner, 1_450_000_000n, "win:m1");
    expect(rpc.sent).toEqual([]);
    expect(tx.sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(await chain.status(tx.sig, t)).toBe("unknown"); // signed, unseen, blockhash still valid
    await tx.submit();
    expect(rpc.sent).toHaveLength(1);
    // The broadcast bytes carry the signature the ledger already holds, and the right instructions.
    const bytes = Buffer.from(rpc.sent[0]!.base64, "base64");
    expect(bs58.encode(bytes.subarray(1, 65))).toBe(tx.sig);
    const body = bytes.toString("latin1");
    expect(body).toContain("win:m1");
    rpc.statuses.set(tx.sig, { err: null, confirmationStatus: "processed" });
    expect(await chain.status(tx.sig, t)).toBe("unknown");
    rpc.statuses.set(tx.sig, { err: null, confirmationStatus: "confirmed" });
    expect(await chain.status(tx.sig, t)).toBe("confirmed");
    rpc.statuses.set(tx.sig, { err: { InstructionError: [3, "Custom"] }, confirmationStatus: "confirmed" });
    expect(await chain.status(tx.sig, t)).toBe("failed");
  });

  it("calls an unseen transaction expired once its blockhash is dead, or after five minutes when the blockhash is unknown", async () => {
    let t = 1_000_000;
    const { rpc, chain } = make({ now: () => t });
    const tx = await chain.prepareTransfer(winner, 1n, "win:m2");
    rpc.blockhashValid = false;
    expect(await chain.status(tx.sig, t)).toBe("expired");
    // A signature from a previous process (no blockhash on record).
    expect(await chain.status("5".repeat(88), t)).toBe("unknown");
    t += EXPIRED_AFTER_MS + 1;
    expect(await chain.status("5".repeat(88), 1_000_000)).toBe("expired");
  });

  it("refuses a seed draw without the seed key and a sweep without a cold wallet", async () => {
    const { chain } = make();
    await expect(chain.seedTransfer(1n)).rejects.toThrow(/SEED_WALLET_KEYPAIR/);
    expect(await chain.sweep(1n)).toBeNull();
    expect(await chain.claim()).toBeNull();
  });

  it("claims: distributes the creator vault to the sharing config's shareholders and reports what the hot wallet received", async () => {
    let t = 0;
    const { rpc, chain } = make({ cock: true, now: () => (t += 2000) });
    const cfg = pumpPda.sharingConfig(COCK);
    const vault = pumpPda.creatorVault(cfg);
    const key = (s: string) => Buffer.from(bs58.decode(s));
    // BondingCurve: creator = the sharing config (fees are shared), quote = PUMP, not graduated.
    rpc.accounts.set(
      pumpPda.bondingCurve(COCK),
      Buffer.concat([Buffer.alloc(8), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from([0]), key(cfg), Buffer.from([0, 0]), key(PUMP), Buffer.from(u64le(300n)), Buffer.from([1, 0])]),
    );
    rpc.accounts.set(cfg, Buffer.concat([Buffer.alloc(8), Buffer.from([255, 2, 1]), key(COCK), key(launch), Buffer.from([1]), Buffer.from([2, 0, 0, 0]), key(hot.publicKey), Buffer.from([0x58, 0x1b]), key(launch), Buffer.from([0xb8, 0x0b])]));
    rpc.balances.set(associatedTokenAddress(vault, PUMP, TOKEN_2022_PROGRAM), 1_000_000n);
    rpc.balances.set(chain.hotAta, 10n);
    // The fake confirms whatever is sent, and credits the hot wallet 70%.
    rpc.onSend = (sig) => {
      rpc.statuses.set(sig, { err: null, confirmationStatus: "confirmed" });
      rpc.balances.set(chain.hotAta, 10n + 700_000n);
    };
    const r = await chain.claim();
    expect(r).toMatchObject({ stage: "curve", received: 700_000n });
    expect(rpc.sent).toHaveLength(1);
    // Nothing left in the vault: the next claim is a no-op without a transaction.
    rpc.balances.set(associatedTokenAddress(vault, PUMP, TOKEN_2022_PROGRAM), 0n);
    expect(await chain.claim()).toBeNull();
    expect(rpc.sent).toHaveLength(1);
  });

  it("rebroadcasts a claim the network dropped (same bytes, same signature) until it lands", async () => {
    let t = 0;
    const { rpc, chain } = make({ cock: true, now: () => (t += 2000) });
    const cfg = pumpPda.sharingConfig(COCK);
    const vault = pumpPda.creatorVault(cfg);
    const key = (s: string) => Buffer.from(bs58.decode(s));
    rpc.accounts.set(
      pumpPda.bondingCurve(COCK),
      Buffer.concat([Buffer.alloc(8), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from(u64le(1n)), Buffer.from([0]), key(cfg), Buffer.from([0, 0]), key(PUMP), Buffer.from(u64le(300n)), Buffer.from([1, 0])]),
    );
    rpc.accounts.set(cfg, Buffer.concat([Buffer.alloc(8), Buffer.from([255, 2, 1]), key(COCK), key(launch), Buffer.from([1]), Buffer.from([2, 0, 0, 0]), key(hot.publicKey), Buffer.from([0x58, 0x1b]), key(launch), Buffer.from([0xb8, 0x0b])]));
    rpc.balances.set(associatedTokenAddress(vault, PUMP, TOKEN_2022_PROGRAM), 1_000_000n);
    rpc.balances.set(chain.hotAta, 0n);
    // The first two broadcasts are dropped; the third lands.
    let sends = 0;
    rpc.onSend = (sig) => {
      if (++sends < 3) return;
      rpc.statuses.set(sig, { err: null, confirmationStatus: "confirmed" });
      rpc.balances.set(chain.hotAta, 700_000n);
    };
    expect(await chain.claim()).toMatchObject({ received: 700_000n });
    expect(rpc.sent).toHaveLength(3);
    expect(new Set(rpc.sent.map((s) => s.base64)).size).toBe(1);
  });

  it("claims nothing until pump.fun's creator fee sharing points at the hot wallet", async () => {
    const { rpc, chain } = make({ cock: true });
    const key = (s: string) => Buffer.from(bs58.decode(s));
    rpc.accounts.set(
      pumpPda.bondingCurve(COCK),
      Buffer.concat([Buffer.alloc(8), Buffer.alloc(40), Buffer.from([0]), key(launch), Buffer.from([0, 0]), key(PUMP), Buffer.from(u64le(300n)), Buffer.from([1, 0])]),
    );
    await expect(chain.claim()).rejects.toThrow(/Share creator rewards/);
  });
});
