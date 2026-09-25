/**
 * The hand-rolled transaction layer against @solana/web3.js and
 * @solana/spl-token (dev dependencies only): same PDAs, same ATAs, same
 * message bytes, same signature. If these agree, the worker's transfers are
 * what the network expects.
 */
import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair as W3Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import {
  Keypair, MEMO_PROGRAM, PUMP_PROGRAM, TOKEN_2022_PROGRAM, anchorDiscriminator, associatedTokenAddress, buildTransaction, compactU16, compileMessage,
  createAssociatedTokenAccountIdempotent, decodeBondingCurve, decodeSharingConfig, distributeCreatorFeesV2, findProgramAddress, memo, pumpPda,
  setComputeUnitLimit, setComputeUnitPrice, transferChecked, u64le, utf8,
} from "../src";

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 0xff);
const hotW3 = W3Keypair.fromSeed(seed(1));
const hot = Keypair.fromSecret(bs58.encode(hotW3.secretKey));
const winner = new PublicKey(W3Keypair.fromSeed(seed(2)).publicKey);
const mint = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const BLOCKHASH = bs58.encode(seed(9));

describe("keys", () => {
  it("derives the same public key from a 64-byte secret, a 32-byte seed or a JSON array", () => {
    expect(hot.publicKey).toBe(hotW3.publicKey.toBase58());
    expect(Keypair.fromSecret(bs58.encode(hotW3.secretKey.slice(0, 32))).publicKey).toBe(hot.publicKey);
    expect(Keypair.fromSecret(JSON.stringify([...hotW3.secretKey])).publicKey).toBe(hot.publicKey);
    expect(() => Keypair.fromSecret(bs58.encode(seed(3).slice(0, 31)))).toThrow(/32 or 64/);
    const bad = Uint8Array.from(hotW3.secretKey);
    bad[40] = (bad[40] as number) ^ 1;
    expect(() => Keypair.fromSecret(bs58.encode(bad))).toThrow(/does not match/);
  });
});

describe("addresses", () => {
  it("finds program-derived addresses like web3.js", () => {
    const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), hotW3.publicKey.toBuffer()], new PublicKey(PUMP_PROGRAM));
    expect(findProgramAddress([utf8("creator-vault"), bs58.decode(hot.publicKey)], PUMP_PROGRAM)).toEqual({ address: pda.toBase58(), bump });
    expect(pumpPda.creatorVault("Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF")).toBe("AGrw7wjy4RKuHNYMvxdnqUqLW2Kde4p5scuwg2p8xBem");
    expect(pumpPda.eventAuthority()).toBe(PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], new PublicKey(PUMP_PROGRAM))[0].toBase58());
  });

  it("derives associated token accounts like spl-token, for both token programs", () => {
    expect(associatedTokenAddress(winner.toBase58(), mint.toBase58(), TOKEN_2022_PROGRAM)).toBe(
      getAssociatedTokenAddressSync(mint, winner, false, TOKEN_2022_PROGRAM_ID).toBase58(),
    );
    expect(associatedTokenAddress(winner.toBase58(), mint.toBase58())).toBe(getAssociatedTokenAddressSync(mint, winner).toBase58());
  });

  it("encodes compact-u16 and u64 little-endian", () => {
    expect([...compactU16(0)]).toEqual([0]);
    expect([...compactU16(127)]).toEqual([127]);
    expect([...compactU16(128)]).toEqual([0x80, 1]);
    expect([...compactU16(16383)]).toEqual([0xff, 0x7f]);
    expect([...u64le(1n)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect([...u64le(0x0102030405060708n)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(() => u64le(-1n)).toThrow();
    expect([...anchorDiscriminator("distribute_creator_fees_v2")]).toEqual([255, 203, 19, 79, 244, 68, 8, 159]);
    expect([...anchorDiscriminator("collect_creator_fee_v2")]).toEqual([207, 17, 138, 242, 4, 34, 19, 56]);
  });
});

describe("a payout transaction", () => {
  const amount = 1_450_000_000n;
  const note = "win:11111111-1111-4111-8111-111111111111";

  function ours() {
    return buildTransaction({
      feePayer: hot,
      recentBlockhash: BLOCKHASH,
      instructions: [
        setComputeUnitLimit(80_000),
        setComputeUnitPrice(10_000n),
        createAssociatedTokenAccountIdempotent(hot.publicKey, winner.toBase58(), mint.toBase58(), TOKEN_2022_PROGRAM),
        transferChecked({
          source: associatedTokenAddress(hot.publicKey, mint.toBase58(), TOKEN_2022_PROGRAM),
          mint: mint.toBase58(),
          destination: associatedTokenAddress(winner.toBase58(), mint.toBase58(), TOKEN_2022_PROGRAM),
          owner: hot.publicKey,
          amount,
          decimals: 6,
          tokenProgram: TOKEN_2022_PROGRAM,
        }),
        memo(note),
      ],
    });
  }

  function theirs() {
    const tx = new Transaction({ feePayer: hotW3.publicKey, recentBlockhash: BLOCKHASH });
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      createAssociatedTokenAccountIdempotentInstruction(hotW3.publicKey, getAssociatedTokenAddressSync(mint, winner, false, TOKEN_2022_PROGRAM_ID), winner, mint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(mint, hotW3.publicKey, false, TOKEN_2022_PROGRAM_ID),
        mint,
        getAssociatedTokenAddressSync(mint, winner, false, TOKEN_2022_PROGRAM_ID),
        hotW3.publicKey,
        amount,
        6,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(note, "utf8") }),
    );
    tx.sign(hotW3);
    return tx;
  }

  it("serializes byte for byte like web3.js and carries the same signature", () => {
    const a = ours();
    const b = theirs();
    expect(Buffer.from(a.bytes).toString("hex")).toBe(b.serialize().toString("hex"));
    expect(a.signature).toBe(bs58.encode(b.signature as Buffer));
    expect(a.base64).toBe(b.serialize().toString("base64"));
  });

  it("orders accounts as web3.js does when the same key appears with different flags", () => {
    const other = Keypair.fromSecret(bs58.encode(W3Keypair.fromSeed(seed(4)).secretKey));
    const otherW3 = W3Keypair.fromSeed(seed(4));
    // The seed wallet signs as the token owner (readonly signer); the hot wallet pays and creates the ATA.
    const a = buildTransaction({
      feePayer: hot,
      signers: [other],
      recentBlockhash: BLOCKHASH,
      instructions: [
        createAssociatedTokenAccountIdempotent(hot.publicKey, hot.publicKey, mint.toBase58(), TOKEN_2022_PROGRAM),
        transferChecked({
          source: associatedTokenAddress(other.publicKey, mint.toBase58(), TOKEN_2022_PROGRAM),
          mint: mint.toBase58(),
          destination: associatedTokenAddress(hot.publicKey, mint.toBase58(), TOKEN_2022_PROGRAM),
          owner: other.publicKey,
          amount: 5n,
          decimals: 6,
          tokenProgram: TOKEN_2022_PROGRAM,
        }),
        memo("cockfight:seed"),
      ],
    });
    const tx = new Transaction({ feePayer: hotW3.publicKey, recentBlockhash: BLOCKHASH });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(hotW3.publicKey, getAssociatedTokenAddressSync(mint, hotW3.publicKey, false, TOKEN_2022_PROGRAM_ID), hotW3.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(mint, otherW3.publicKey, false, TOKEN_2022_PROGRAM_ID),
        mint,
        getAssociatedTokenAddressSync(mint, hotW3.publicKey, false, TOKEN_2022_PROGRAM_ID),
        otherW3.publicKey,
        5n,
        6,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from("cockfight:seed", "utf8") }),
    );
    tx.sign(hotW3, otherW3);
    expect(Buffer.from(a.bytes).toString("hex")).toBe(tx.serialize().toString("hex"));
  });

  it("refuses to sign without every required signer", () => {
    const msg = compileMessage({ feePayer: hot.publicKey, recentBlockhash: BLOCKHASH, instructions: [memo("x", [winner.toBase58()])] });
    expect(msg.numRequiredSignatures).toBe(2);
    expect(() => buildTransaction({ feePayer: hot, recentBlockhash: BLOCKHASH, instructions: [memo("x", [winner.toBase58()])] })).toThrow(/missing signer/);
  });
});

describe("pump.fun", () => {
  it("builds distribute_creator_fees_v2 with the IDL's account list and the shareholders' ATAs as remaining accounts", () => {
    const cock = "HFypaAkLk4XwKJvLK5hTvL65dhY2F61davhjo1x8pump";
    const launch = "Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF";
    const ix = distributeCreatorFeesV2({ payer: hot.publicKey, mint: cock, quoteMint: mint.toBase58(), quoteTokenProgram: TOKEN_2022_PROGRAM, shareholders: [hot.publicKey, launch] });
    const cfg = pumpPda.sharingConfig(cock);
    const vault = pumpPda.creatorVault(cfg);
    expect(ix.programId).toBe(PUMP_PROGRAM);
    expect(ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable])).toEqual([
      [hot.publicKey, true, true],
      [cock, false, false],
      [pumpPda.bondingCurve(cock), false, false],
      [cfg, false, false],
      [vault, false, true],
      ["11111111111111111111111111111111", false, false],
      [pumpPda.eventAuthority(), false, false],
      [PUMP_PROGRAM, false, false],
      [associatedTokenAddress(vault, mint.toBase58(), TOKEN_2022_PROGRAM), false, true],
      [mint.toBase58(), false, false],
      [TOKEN_2022_PROGRAM, false, false],
      ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", false, false],
      [hot.publicKey, false, false],
      [launch, false, false],
      [associatedTokenAddress(hot.publicKey, mint.toBase58(), TOKEN_2022_PROGRAM), false, true],
      [associatedTokenAddress(launch, mint.toBase58(), TOKEN_2022_PROGRAM), false, true],
    ]);
    expect([...ix.data]).toEqual([255, 203, 19, 79, 244, 68, 8, 159, 1]);
  });

  it("decodes BondingCurve and SharingConfig accounts", () => {
    const creator = bs58.decode(hot.publicKey);
    const quote = mint.toBuffer();
    const curve = Buffer.concat([
      Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]),
      Buffer.from(u64le(1_000_000n)), Buffer.from(u64le(30_000n)), Buffer.from(u64le(700_000n)), Buffer.from(u64le(0n)), Buffer.from(u64le(1_000_000_000n)),
      Buffer.from([1]), Buffer.from(creator), Buffer.from([0]), Buffer.from([0]), quote, Buffer.from(u64le(300n)), Buffer.from([1, 0]),
    ]);
    expect(decodeBondingCurve(curve)).toEqual({
      virtualTokenReserves: 1_000_000n, virtualQuoteReserves: 30_000n, realTokenReserves: 700_000n, realQuoteReserves: 0n, tokenTotalSupply: 1_000_000_000n,
      complete: true, creator: hot.publicKey, isMayhemMode: false, isCashbackCoin: false, quoteMint: mint.toBase58(), creatorFeeBps: 300n,
    });
    const cfg = Buffer.concat([
      Buffer.from([216, 74, 9, 0, 56, 140, 93, 75]),
      Buffer.from([254, 2, 1]), quote, Buffer.from(creator), Buffer.from([1]),
      Buffer.from([2, 0, 0, 0]), Buffer.from(creator), Buffer.from([0x58, 0x1b]), winner.toBuffer(), Buffer.from([0xb8, 0x0b]),
    ]);
    expect(decodeSharingConfig(cfg)).toEqual({
      version: 2, status: 1, mint: mint.toBase58(), admin: hot.publicKey, adminRevoked: true,
      shareholders: [{ address: hot.publicKey, shareBps: 7000 }, { address: winner.toBase58(), shareBps: 3000 }],
    });
  });
});
