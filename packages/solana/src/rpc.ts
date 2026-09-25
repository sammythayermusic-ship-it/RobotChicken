/**
 * The few JSON-RPC calls the worker makes, over fetch (injected, so tests
 * run offline). Helius or any RPC.
 */
export type Fetch = typeof fetch;

export interface RpcOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  commitment?: "processed" | "confirmed" | "finalized";
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`rpc ${method}: ${message} (${code})`);
    this.code = code;
    this.data = data;
  }
}

export class SolanaRpc {
  readonly url: string;
  private readonly f: Fetch;
  private readonly timeoutMs: number;
  readonly commitment: "processed" | "confirmed" | "finalized";
  private id = 0;

  constructor(url: string, o: RpcOptions = {}) {
    this.url = url;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.commitment = o.commitment ?? "confirmed";
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.f(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data);
    return body.result as T;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: this.commitment }]);
    return r.value;
  }

  async isBlockhashValid(blockhash: string): Promise<boolean> {
    const r = await this.call<{ value: boolean }>("isBlockhashValid", [blockhash, { commitment: this.commitment }]);
    return r.value;
  }

  /** Lamports. */
  async getBalance(address: string): Promise<bigint> {
    const r = await this.call<{ value: number }>("getBalance", [address, { commitment: this.commitment }]);
    return BigInt(r.value);
  }

  /** Raw units of a token account, or null when the account does not exist. */
  async getTokenAccountBalance(tokenAccount: string): Promise<{ amount: bigint; decimals: number } | null> {
    try {
      const r = await this.call<{ value: { amount: string; decimals: number } }>("getTokenAccountBalance", [tokenAccount, { commitment: this.commitment }]);
      return { amount: BigInt(r.value.amount), decimals: r.value.decimals };
    } catch (e) {
      // "could not find account" comes back as an invalid-params error.
      if (e instanceof RpcError && (e.code === -32602 || /could not find account/i.test(e.message))) return null;
      throw e;
    }
  }

  /** Account data (raw bytes) and owner, or null when it does not exist. */
  async getAccountInfo(address: string): Promise<{ data: Uint8Array; owner: string; lamports: bigint } | null> {
    const r = await this.call<{ value: { data: [string, string]; owner: string; lamports: number } | null }>("getAccountInfo", [
      address,
      { commitment: this.commitment, encoding: "base64" },
    ]);
    if (!r.value) return null;
    return { data: Uint8Array.from(Buffer.from(r.value.data[0], "base64")), owner: r.value.owner, lamports: BigInt(r.value.lamports) };
  }

  /** The mint's decimals and its token program. */
  async getMint(mint: string): Promise<{ decimals: number; tokenProgram: string }> {
    const r = await this.call<{ value: { owner: string; data: { parsed?: { info?: { decimals?: number } } } } | null }>("getAccountInfo", [
      mint,
      { commitment: this.commitment, encoding: "jsonParsed" },
    ]);
    const decimals = r.value?.data?.parsed?.info?.decimals;
    if (!r.value || typeof decimals !== "number") throw new Error(`mint ${mint} not found or not a token mint`);
    return { decimals, tokenProgram: r.value.owner };
  }

  async sendTransaction(base64: string, o: { skipPreflight?: boolean; maxRetries?: number } = {}): Promise<string> {
    return this.call<string>("sendTransaction", [
      base64,
      { encoding: "base64", skipPreflight: o.skipPreflight ?? false, preflightCommitment: this.commitment, maxRetries: o.maxRetries ?? 3 },
    ]);
  }

  /** Statuses in signature order (null: not seen). searchTransactionHistory looks past the recent cache. */
  async getSignatureStatuses(sigs: string[], searchHistory = true): Promise<(SignatureStatus | null)[]> {
    if (sigs.length === 0) return [];
    const r = await this.call<{ value: (SignatureStatus | null)[] }>("getSignatureStatuses", [sigs, { searchTransactionHistory: searchHistory }]);
    return r.value;
  }
}
