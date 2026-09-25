#!/bin/sh
# Convert the chicken tier textures to KTX2 (Basis Universal) with KTX-Software 4.4's `ktx create`.
#
#   pnpm textures [--dry-run] [--src <dir>] [--out <dir>]
#
# Input:  art/textures/<tier>/{basecolor,orm,normal,emissive}.png  (8-bit, power-of-two sides <= 2048)
# Output: apps/web/public/textures/chicken/<tier>/<map>.ktx2        (checked by pnpm assets:validate)
# --dry-run prints each ktx command instead of running it (KTX-Software not needed);
# tools/test/texturesScript.test.ts checks those commands against the rules below.
#
# Flags, checked against the KTX-Software v4.4.0 sources (tools/ktx/command_create.cpp):
# - Color maps (basecolor, emissive): --format R8G8B8_SRGB --assign-tf srgb --assign-primaries bt709,
#   ETC1S (--encode basis-lz --clevel 4 --qlevel 200). ETC1S is already supercompressed (BasisLZ), so no --zstd.
# - Data maps (orm, normal): --format R8G8B8_UNORM --assign-tf linear --assign-primaries none. The PNG holds
#   numbers, not colours: without --assign-tf, ktx treats an untagged (or sRGB-tagged) 8-bit PNG as sRGB and
#   converts it to linear, so a stored 128 comes out as 55.
#   UASTC with rate-distortion optimisation (--uastc-rdo, lambda 1.0 for orm and 0.5 for normals, the range
#   the ktx docs give for normal maps; --uastc-rdo-m keeps the output deterministic) and --zstd 18: raw UASTC
#   is 8 bits per texel, 5.6 MB per 2048 map with mips, which alone would break the 12 MB first-load budget.
# - Normal maps stay three-channel RGB = XYZ, which is what three.js normalMap reads. No --normal-mode: it
#   stores a two-channel X+Y map as RGB = X, A = Y and needs a custom shader (assets:validate rejects it).
# - Every call: --generate-mipmap, and --fail-on-color-conversions, so a colour conversion is an error
#   rather than a silent change to the pixels.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/art/textures"
out="$root/apps/web/public/textures/chicken"
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --src) [ $# -ge 2 ] || { echo "textures: --src needs a directory" >&2; exit 2; }; src=$2; shift ;;
    --out) [ $# -ge 2 ] || { echo "textures: --out needs a directory" >&2; exit 2; }; out=$2; shift ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "textures: unknown option $1 (usage: pnpm textures [--dry-run] [--src <dir>] [--out <dir>])" >&2; exit 2 ;;
  esac
  shift
done

if [ "$dry_run" = 0 ] && ! command -v ktx >/dev/null 2>&1; then
  echo "textures: 'ktx' (KTX-Software 4.4+) is not installed." >&2
  echo "  Install the macOS .pkg from https://github.com/KhronosGroup/KTX-Software/releases, then re-run pnpm textures." >&2
  exit 2
fi
[ -d "$src" ] || { echo "textures: no $src yet (the placeholder uses flat materials; nothing to convert)"; exit 0; }

common="--generate-mipmap --fail-on-color-conversions"
color="--format R8G8B8_SRGB --assign-tf srgb --assign-primaries bt709 --encode basis-lz --clevel 4 --qlevel 200"
data="--format R8G8B8_UNORM --assign-tf linear --assign-primaries none --encode uastc --uastc-quality 2 --uastc-rdo --uastc-rdo-m --zstd 18"

for dir in "$src"/*/; do
  [ -d "$dir" ] || continue
  tier=$(basename "$dir")
  for map in basecolor orm normal emissive; do
    in="$dir$map.png"
    [ -f "$in" ] || continue
    case "$map" in
      basecolor|emissive) opts="$color" ;;
      orm) opts="$data --uastc-rdo-l 1.0" ;;
      normal) opts="$data --uastc-rdo-l 0.5" ;;
    esac
    dest="$out/$tier/$map.ktx2"
    if [ "$dry_run" = 1 ]; then
      echo "ktx create $common $opts $in $dest"
      continue
    fi
    mkdir -p "$out/$tier"
    # shellcheck disable=SC2086
    ktx create $common $opts "$in" "$dest"
    echo "textures: $tier/$map.ktx2"
  done
done
