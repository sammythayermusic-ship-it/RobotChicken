/**
 * Where the self-hosted Draco and Basis decoders live. scripts/copy-decoders.mjs
 * copies them into public/decoders/r<REVISION>/ from the installed three, so
 * the loaders always fetch decoders built for the exact three they ship with,
 * and the versioned path can be cached as immutable.
 */
import { REVISION } from "three";

export function decoderPaths(revision: string = REVISION): { draco: string; basis: string } {
  const base = `/decoders/r${revision}`;
  return { draco: `${base}/draco/`, basis: `${base}/basis/` };
}
