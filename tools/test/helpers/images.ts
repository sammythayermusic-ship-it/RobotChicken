/**
 * Minimal image files for texture-rule tests: a KTX2 header + index + basic
 * DFD (no pixel data), and a PNG signature + IHDR. Enough for imageInfo(),
 * not for a decoder.
 */
import { KHR_DF_MODEL_ETC1S, KHR_DF_MODEL_UASTC, KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB, KTX2_ID, PNG_ID, type ColorModel, type Transfer } from "../../src/assets/images";

export function fakeKtx2(opts: { width: number; height?: number; transfer?: Transfer; model?: ColorModel }): Uint8Array {
  const dfd = 80;
  const out = new Uint8Array(dfd + 44);
  out.set(KTX2_ID, 0);
  const v = new DataView(out.buffer);
  v.setUint32(20, opts.width, true);
  v.setUint32(24, opts.height ?? opts.width, true);
  v.setUint32(36, 1, true); // faceCount
  v.setUint32(40, 1, true); // levelCount
  v.setUint32(48, dfd, true);
  v.setUint32(52, 44, true);
  v.setUint32(dfd, 44, true); // dfdTotalSize
  v.setUint16(dfd + 10, 40, true); // descriptorBlockSize
  const model = opts.model ?? "etc1s";
  v.setUint8(dfd + 12, model === "etc1s" ? KHR_DF_MODEL_ETC1S : model === "uastc" ? KHR_DF_MODEL_UASTC : 1);
  v.setUint8(dfd + 13, 1); // BT.709 primaries
  const transfer = opts.transfer ?? "srgb";
  v.setUint8(dfd + 14, transfer === "srgb" ? KHR_DF_TRANSFER_SRGB : transfer === "linear" ? KHR_DF_TRANSFER_LINEAR : 0);
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
