#!/bin/sh
# Convert chicken tier textures to KTX2 (Basis) with KTX-Software 4.4's `ktx create`.
# Input:  art/textures/<tier>/{basecolor,orm,normal,emissive}.png  (2048x2048, power of two)
# Output: apps/web/public/textures/chicken/<tier>/<map>.ktx2        (checked by assets:validate)
# Install KTX-Software from https://github.com/KhronosGroup/KTX-Software/releases (macOS .pkg);
# `toktx` is deprecated and gltf-transform's KTX commands need the same tools.
set -eu
if ! command -v ktx >/dev/null 2>&1; then
  echo "textures: 'ktx' (KTX-Software 4.4+) is not installed." >&2
  echo "  Install the macOS .pkg from https://github.com/KhronosGroup/KTX-Software/releases, then re-run pnpm textures." >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/art/textures"
out="$root/apps/web/public/textures/chicken"
[ -d "$src" ] || { echo "textures: no $src yet (the placeholder uses flat materials; nothing to convert)"; exit 0; }
for dir in "$src"/*/; do
  tier=$(basename "$dir")
  mkdir -p "$out/$tier"
  for map in basecolor orm normal emissive; do
    in="$dir$map.png"
    [ -f "$in" ] || continue
    # Colour maps are sRGB (ETC1S is fine for them); data maps stay linear (UASTC keeps them clean).
    case "$map" in
      basecolor|emissive) opts="--format R8G8B8A8_SRGB --encode basis-lz --clevel 2 --qlevel 128" ;;
      normal) opts="--format R8G8B8A8_UNORM --encode uastc --uastc-quality 2 --normal-mode" ;;
      *) opts="--format R8G8B8A8_UNORM --encode uastc --uastc-quality 2" ;;
    esac
    # shellcheck disable=SC2086
    ktx create --generate-mipmap $opts "$in" "$out/$tier/$map.ktx2"
    echo "textures: $tier/$map.ktx2"
  done
done
