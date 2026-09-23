/**
 * Just enough image-header parsing for the texture rules: size, and for KTX2
 * the Basis color model and transfer function (sRGB vs linear). Hand-rolled
 * rather than a dependency: the fields sit at fixed offsets (KTX 2.0 spec,
 * sections 3 and 4; Khronos Data Format spec for the DFD).
 */

export type ImageFormat = "ktx2" | "png" | "jpeg" | "unknown";
export type Transfer = "srgb" | "linear" | "other";
export type ColorModel = "etc1s" | "uastc" | "other";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  /** KTX2 only. */
  transfer?: Transfer;
  /** KTX2 only. */
  model?: ColorModel;
  /** KTX2 only. */
  levels?: number;
}

export const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
export const PNG_ID = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Khronos Data Format constants (khr_df.h). */
export const KHR_DF_MODEL_ETC1S = 163;
export const KHR_DF_MODEL_UASTC = 166;
export const KHR_DF_TRANSFER_LINEAR = 1;
export const KHR_DF_TRANSFER_SRGB = 2;

const startsWith = (b: Uint8Array, id: number[]) => b.length >= id.length && id.every((v, i) => b[i] === v);

function ktx2(b: Uint8Array): ImageInfo {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const info: ImageInfo = { format: "ktx2", width: v.getUint32(20, true), height: v.getUint32(24, true), levels: v.getUint32(40, true) };
  const dfd = v.getUint32(48, true);
  // Basic descriptor block: 4-byte total size, 8 bytes of block header, then
  // colorModel, colorPrimaries, transferFunction, flags (one byte each).
  if (dfd > 0 && dfd + 16 <= b.length) {
    const model = v.getUint8(dfd + 12);
    const transfer = v.getUint8(dfd + 14);
    info.model = model === KHR_DF_MODEL_ETC1S ? "etc1s" : model === KHR_DF_MODEL_UASTC ? "uastc" : "other";
    info.transfer = transfer === KHR_DF_TRANSFER_SRGB ? "srgb" : transfer === KHR_DF_TRANSFER_LINEAR ? "linear" : "other";
  }
  return info;
}

function jpeg(b: Uint8Array): ImageInfo {
  // Walk the marker segments to the first start-of-frame (SOF0..SOF15 except DHT/JPG/DAC).
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: "jpeg", height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + len;
  }
  return { format: "jpeg", width: 0, height: 0 };
}

/** Parse an image's header; `format: "unknown"` (0 x 0) when it is none of KTX2, PNG or JPEG. */
export function imageInfo(bytes: Uint8Array): ImageInfo {
  if (startsWith(bytes, KTX2_ID) && bytes.length >= 80) return ktx2(bytes);
  if (startsWith(bytes, PNG_ID) && bytes.length >= 24) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { format: "png", width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  return { format: "unknown", width: 0, height: 0 };
}

export const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
