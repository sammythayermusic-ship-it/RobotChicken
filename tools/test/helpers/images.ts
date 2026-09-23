/**
 * Minimal image files for texture-rule tests: a KTX2 header + index + basic
 * DFD (no pixel data), and a PNG signature + IHDR. Enough for imageInfo(),
 * not for a decoder.
 */
import { KHR_DF_MODEL_ETC1S, KHR_DF_MODEL_UASTC, KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB, KTX2_ID, PNG_ID, type ColorModel, type Transfer } from "../../src/assets/images";

export interface FakeKtx2 {
  width: number;
  height?: number;
  transfer?: Transfer;
  model?: ColorModel;
  /** KTX2 supercompressionScheme (default what `ktx create` writes: 1 BasisLZ for ETC1S, 2 Zstandard for UASTC). */
  supercompression?: number;
  /** DFD sample channel ids (default [0]: RGB). */
  channels?: number[];
}

export function fakeKtx2(opts: FakeKtx2): Uint8Array {
  const dfd = 80;
  const channels = opts.channels ?? [0];
  const blockSize = 24 + 16 * channels.length;
  const out = new Uint8Array(dfd + 4 + blockSize);
  out.set(KTX2_ID, 0);
  const v = new DataView(out.buffer);
  const model = opts.model ?? "etc1s";
  v.setUint32(20, opts.width, true);
  v.setUint32(24, opts.height ?? opts.width, true);
  v.setUint32(36, 1, true); // faceCount
  v.setUint32(40, 1, true); // levelCount
  v.setUint32(44, opts.supercompression ?? (model === "etc1s" ? 1 : model === "uastc" ? 2 : 0), true);
  v.setUint32(48, dfd, true);
  v.setUint32(52, 4 + blockSize, true);
  v.setUint32(dfd, 4 + blockSize, true); // dfdTotalSize
  v.setUint16(dfd + 10, blockSize, true); // descriptorBlockSize
  v.setUint8(dfd + 12, model === "etc1s" ? KHR_DF_MODEL_ETC1S : model === "uastc" ? KHR_DF_MODEL_UASTC : 1);
  v.setUint8(dfd + 13, 1); // BT.709 primaries
  const transfer = opts.transfer ?? "srgb";
  v.setUint8(dfd + 14, transfer === "srgb" ? KHR_DF_TRANSFER_SRGB : transfer === "linear" ? KHR_DF_TRANSFER_LINEAR : 0);
  channels.forEach((id, i) => v.setUint8(dfd + 4 + 24 + 16 * i + 3, id));
  return out;
}

export function fakePng(width: number, height = width): Uint8Array {
  const out = new Uint8Array(33);
  out.set(PNG_ID, 0);
  const v = new DataView(out.buffer);
  v.setUint32(8, 13);
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  v.setUint32(16, width);
  v.setUint32(20, height);
  out[24] = 8; // bit depth
  out[25] = 6; // RGBA
  return out;
}
