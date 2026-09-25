/**
 * Just enough Solana to pay a player: legacy transactions built and signed
 * by hand (ed25519 from @noble/curves), program-derived addresses,
 * associated token accounts, and the handful of instructions the worker
 * sends. No web3.js at runtime; a test checks byte-for-byte parity with it.
 *
 * Everything here is pure: no network, no clock. rpc.ts talks to the node.
 */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";

export type Bytes = Uint8Array;

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEES_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

export function toBytes(address: string): Bytes {
  const b = bs58.decode(address);
  if (b.length !== 32) throw new Error(`not a 32-byte address: ${address}`);
  return b;
}

export function toAddress(bytes: Bytes): string {
  return bs58.encode(bytes);
}

export function sha256(...parts: Bytes[]): Bytes {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return Uint8Array.from(h.digest());
}

export function isOnCurveBytes(b: Bytes): boolean {
  try {
    ed25519.Point.fromBytes(b, true);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** Program-derived address: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(seeds: Bytes[], programId: string): { address: string; bump: number } {
  const prog = toBytes(programId);
  for (const s of seeds) if (s.length > 32) throw new Error("PDA seed over 32 bytes");
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(...seeds, Uint8Array.of(bump), prog, PDA_MARKER);
    if (!isOnCurveBytes(h)) return { address: toAddress(h), bump };
  }
  throw new Error("no PDA bump found");
}

/** The canonical associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  return findProgramAddress([toBytes(owner), toBytes(tokenProgram), toBytes(mint)], ASSOCIATED_TOKEN_PROGRAM).address;
}

export const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

export function u64le(n: bigint): Bytes {
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError("u64 out of range");
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
}

export function u32le(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function readU64le(b: Bytes, off: number): bigint {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[off + i] as number);
  return n;
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Bytes;
}

const meta = (pubkey: string, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });
export const signer = (k: string, writable = true) => meta(k, true, writable);
export const writable = (k: string) => meta(k, false, true);
export const readonly = (k: string) => meta(k, false, false);

// Instructions -----------------------------------------------------------------

export function setComputeUnitLimit(units: number): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat(Uint8Array.of(2), u32le(units)) };
}

export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat(Uint8Array.of(3), u64le(microLamports)) };
}

export function memo(text: string, signers: string[] = []): Instruction {
  return { programId: MEMO_PROGRAM, keys: signers.map((s) => signer(s, false)), data: utf8(text) };
}

/** Create the ATA if it does not exist yet (instruction 1 of the ATA program). */
export function createAssociatedTokenAccountIdempotent(payer: string, owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      signer(payer),
      writable(associatedTokenAddress(owner, mint, tokenProgram)),
      readonly(owner),
      readonly(mint),
      readonly(SYSTEM_PROGRAM),
      readonly(tokenProgram),
    ],
    data: Uint8Array.of(1),
  };
}

/** SPL Token TransferChecked (instruction 12): amount and decimals are checked against the mint. */
export function transferChecked(o: { source: string; mint: string; destination: string; owner: string; amount: bigint; decimals: number; tokenProgram?: string }): Instruction {
  return {
    programId: o.tokenProgram ?? TOKEN_PROGRAM,
    keys: [writable(o.source), readonly(o.mint), writable(o.destination), signer(o.owner, false)],
    data: concat(Uint8Array.of(12), u64le(o.amount), Uint8Array.of(o.decimals)),
  };
}

// pump.fun ----------------------------------------------------------------------

export const pumpPda = {
  bondingCurve: (mint: string) => findProgramAddress([utf8("bonding-curve"), toBytes(mint)], PUMP_PROGRAM).address,
  creatorVault: (creator: string) => findProgramAddress([utf8("creator-vault"), toBytes(creator)], PUMP_PROGRAM).address,
  eventAuthority: () => findProgramAddress([utf8("__event_authority")], PUMP_PROGRAM).address,
  sharingConfig: (mint: string) => findProgramAddress([utf8("sharing-config"), toBytes(mint)], PUMP_FEES_PROGRAM).address,
  ammCreatorVaultAuthority: (creator: string) => findProgramAddress([utf8("creator_vault"), toBytes(creator)], PUMP_AMM_PROGRAM).address,
  ammEventAuthority: () => findProgramAddress([utf8("__event_authority")], PUMP_AMM_PROGRAM).address,
};

/** Anchor discriminator: the first 8 bytes of sha256("global:<name>"). */
export function anchorDiscriminator(name: string): Bytes {
  return sha256(utf8(`global:${name}`)).slice(0, 8);
}

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: string;
  creatorFeeBps: bigint;
}

/** pump.json BondingCurve (after the 8-byte discriminator). */
export function decodeBondingCurve(data: Bytes): BondingCurve {
  if (data.length < 8 + 5 * 8 + 1 + 32 + 2 + 32 + 8) throw new Error("bonding curve account too short");
  let o = 8;
  const u64 = () => {
    const v = readU64le(data, o);
    o += 8;
    return v;
  };
  const bool = () => data[o++] === 1;
  const key = () => {
    const k = toAddress(data.slice(o, o + 32));
    o += 32;
    return k;
  };
  return {
    virtualTokenReserves: u64(),
    virtualQuoteReserves: u64(),
    realTokenReserves: u64(),
    realQuoteReserves: u64(),
    tokenTotalSupply: u64(),
    complete: bool(),
    creator: key(),
    isMayhemMode: bool(),
    isCashbackCoin: bool(),
    quoteMint: key(),
    creatorFeeBps: u64(),
  };
}

export interface SharingConfig {
  version: number;
  status: number;
  mint: string;
  admin: string;
  adminRevoked: boolean;
  shareholders: { address: string; shareBps: number }[];
}

/** pump_fees.json SharingConfig: bump, version, status, mint, admin, admin_revoked, Vec<Shareholder{pubkey, u16}>. */
export function decodeSharingConfig(data: Bytes): SharingConfig {
  let o = 8;
  o += 1; // bump
  const version = data[o++] as number;
  const status = data[o++] as number;
  const mint = toAddress(data.slice(o, o + 32));
  o += 32;
  const admin = toAddress(data.slice(o, o + 32));
  o += 32;
  const adminRevoked = data[o++] === 1;
  const n = new DataView(data.buffer, data.byteOffset).getUint32(o, true);
  o += 4;
  const shareholders: SharingConfig["shareholders"] = [];
  for (let i = 0; i < n; i++) {
    const address = toAddress(data.slice(o, o + 32));
    o += 32;
    const shareBps = new DataView(data.buffer, data.byteOffset).getUint16(o, true);
    o += 2;
    shareholders.push({ address, shareBps });
  }
  return { version, status, mint, admin, adminRevoked, shareholders };
}

/**
 * pump `distribute_creator_fees_v2`: pay the bonding curve's creator vault
 * out to the sharing config's shareholders. Permissionless; `payer` covers
 * any shareholder ATA it creates. Remaining accounts for a non-SOL quote:
 * the shareholders, then their ATAs, in the config's order.
 */
export function distributeCreatorFeesV2(o: {
  payer: string;
  mint: string;
  quoteMint: string;
  quoteTokenProgram: string;
  shareholders: string[];
  initializeAta?: boolean;
}): Instruction {
  const sharingConfig = pumpPda.sharingConfig(o.mint);
  const creatorVault = pumpPda.creatorVault(sharingConfig);
  return {
    programId: PUMP_PROGRAM,
    keys: [
      signer(o.payer),
      readonly(o.mint),
      readonly(pumpPda.bondingCurve(o.mint)),
      readonly(sharingConfig),
      writable(creatorVault),
      readonly(SYSTEM_PROGRAM),
      readonly(pumpPda.eventAuthority()),
      readonly(PUMP_PROGRAM),
      writable(associatedTokenAddress(creatorVault, o.quoteMint, o.quoteTokenProgram)),
      readonly(o.quoteMint),
      readonly(o.quoteTokenProgram),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      ...o.shareholders.map(readonly),
      ...o.shareholders.map((s) => writable(associatedTokenAddress(s, o.quoteMint, o.quoteTokenProgram))),
    ],
    data: concat(anchorDiscriminator("distribute_creator_fees_v2"), Uint8Array.of(o.initializeAta === false ? 0 : 1)),
  };
}

/** Pump AMM `transfer_creator_fees_to_pump_v2`: after graduation, sweep the AMM-side creator fees into the pump creator vault. */
export function transferCreatorFeesToPumpV2(o: { payer: string; coinCreator: string; quoteMint: string; quoteTokenProgram: string }): Instruction {
  const authority = pumpPda.ammCreatorVaultAuthority(o.coinCreator);
  const pumpVault = pumpPda.creatorVault(o.coinCreator);
  return {
    programId: PUMP_AMM_PROGRAM,
    keys: [
      signer(o.payer),
      readonly(o.quoteMint),
      readonly(o.quoteTokenProgram),
      readonly(SYSTEM_PROGRAM),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      readonly(o.coinCreator),
      writable(authority),
      writable(associatedTokenAddress(authority, o.quoteMint, o.quoteTokenProgram)),
      writable(pumpVault),
      writable(associatedTokenAddress(pumpVault, o.quoteMint, o.quoteTokenProgram)),
      readonly(pumpPda.ammEventAuthority()),
      readonly(PUMP_AMM_PROGRAM),
    ],
    data: anchorDiscriminator("transfer_creator_fees_to_pump_v2"),
  };
}

// Keys and signing ---------------------------------------------------------------

export class Keypair {
  readonly seed: Bytes;
  readonly publicKey: string;
  private constructor(seed: Bytes) {
    this.seed = seed;
    this.publicKey = toAddress(ed25519.getPublicKey(seed));
  }

  /**
   * From a 64-byte secret key (Phantom / solana-keygen export: seed ‖ pubkey)
   * or a 32-byte seed, as base58 or a JSON byte array.
   */
  static fromSecret(secret: string): Keypair {
    const t = secret.trim();
    let bytes: Bytes;
    if (t.startsWith("[")) bytes = Uint8Array.from(JSON.parse(t) as number[]);
    else bytes = bs58.decode(t);
    if (bytes.length === 64) {
      const kp = new Keypair(bytes.slice(0, 32));
      if (toAddress(bytes.slice(32)) !== kp.publicKey) throw new Error("secret key's public half does not match its seed");
      return kp;
    }
    if (bytes.length === 32) return new Keypair(bytes);
    throw new Error(`secret key must be 32 or 64 bytes, got ${bytes.length}`);
  }

  sign(message: Bytes): Bytes {
    return ed25519.sign(message, this.seed);
  }
}

export function compactU16(n: number): Bytes {
  const out: number[] = [];
  let rem = n;
  for (;;) {
    let b = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(b);
      break;
    }
    b |= 0x80;
    out.push(b);
  }
  return Uint8Array.from(out);
}

export interface CompiledMessage {
  bytes: Bytes;
  accountKeys: string[];
  numRequiredSignatures: number;
}

/**
 * Compile a legacy message the way web3.js does: instruction keys then
 * program ids, flags merged, sorted signers first, writable first, then by
 * key; the fee payer moved to the front.
 */
export function compileMessage(o: { feePayer: string; recentBlockhash: string; instructions: Instruction[] }): CompiledMessage {
  const metas: AccountMeta[] = [];
  const programIds: string[] = [];
  for (const ix of o.instructions) {
    for (const k of ix.keys) metas.push({ ...k });
    if (!programIds.includes(ix.programId)) programIds.push(ix.programId);
  }
  for (const p of programIds) metas.push(readonly(p));
  const unique: AccountMeta[] = [];
  for (const m of metas) {
    const seen = unique.find((u) => u.pubkey === m.pubkey);
    if (seen) {
      seen.isSigner ||= m.isSigner;
      seen.isWritable ||= m.isWritable;
    } else unique.push(m);
  }
  // web3.js orders each class by localeCompare of the base58 keys; the
  // network accepts any order, but the parity test wants the same bytes.
  unique.sort(
    (x, y) =>
      (x.isSigner === y.isSigner ? 0 : x.isSigner ? -1 : 1) || (x.isWritable === y.isWritable ? 0 : x.isWritable ? -1 : 1) || x.pubkey.localeCompare(y.pubkey),
  );
  const payerIdx = unique.findIndex((m) => m.pubkey === o.feePayer);
  if (payerIdx >= 0) {
    const [p] = unique.splice(payerIdx, 1);
    (p as AccountMeta).isSigner = true;
    (p as AccountMeta).isWritable = true;
    unique.unshift(p as AccountMeta);
  } else unique.unshift(signer(o.feePayer));

  let numRequiredSignatures = 0, numReadonlySigned = 0, numReadonlyUnsigned = 0;
  for (const m of unique) {
    if (m.isSigner) {
      numRequiredSignatures++;
      if (!m.isWritable) numReadonlySigned++;
    } else if (!m.isWritable) numReadonlyUnsigned++;
  }
  const accountKeys = unique.map((m) => m.pubkey);
  const index = (k: string) => {
    const i = accountKeys.indexOf(k);
    if (i < 0) throw new Error(`key not in message: ${k}`);
    return i;
  };
  const ixBytes = o.instructions.map((ix) =>
    concat(
      Uint8Array.of(index(ix.programId)),
      compactU16(ix.keys.length),
      Uint8Array.from(ix.keys.map((k) => index(k.pubkey))),
      compactU16(ix.data.length),
      ix.data,
    ),
  );
  const bytes = concat(
    Uint8Array.of(numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned),
    compactU16(accountKeys.length),
    ...accountKeys.map(toBytes),
    toBytes(o.recentBlockhash),
    compactU16(ixBytes.length),
    ...ixBytes,
  );
  return { bytes, accountKeys, numRequiredSignatures };
}

export interface SignedTransaction {
  /** The first signature, base58: the transaction id. */
  signature: string;
  /** Wire bytes (signatures ‖ message). */
  bytes: Bytes;
  base64: string;
  recentBlockhash: string;
}

/** Sign a compiled message with every required signer (fee payer first, in key order). */
export function signTransaction(msg: CompiledMessage, signers: Keypair[], recentBlockhash: string): SignedTransaction {
  const sigs: Bytes[] = [];
  for (let i = 0; i < msg.numRequiredSignatures; i++) {
    const key = msg.accountKeys[i] as string;
    const kp = signers.find((s) => s.publicKey === key);
    if (!kp) throw new Error(`missing signer for ${key}`);
    sigs.push(kp.sign(msg.bytes));
  }
  const bytes = concat(compactU16(sigs.length), ...sigs, msg.bytes);
  return { signature: bs58.encode(sigs[0] as Bytes), bytes, base64: Buffer.from(bytes).toString("base64"), recentBlockhash };
}

/** Build and sign in one go. */
export function buildTransaction(o: { feePayer: Keypair; signers?: Keypair[]; recentBlockhash: string; instructions: Instruction[] }): SignedTransaction {
  const msg = compileMessage({ feePayer: o.feePayer.publicKey, recentBlockhash: o.recentBlockhash, instructions: o.instructions });
  return signTransaction(msg, [o.feePayer, ...(o.signers ?? [])], o.recentBlockhash);
}
