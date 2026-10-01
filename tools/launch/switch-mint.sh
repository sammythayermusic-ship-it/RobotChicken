#!/bin/zsh
# LAUNCH DAY: points the whole stack at the real coin.
#   1. game server: NEXT_PUBLIC_COCK_MINT=<mint>, GATE_USD_MIN=30
#   2. worker:      COCK_MINT=<mint>
#   3. the site:    rebuilt with the mint and deployed
# Run it only after the coin exists and "Share creator rewards" is set
# (70% hot / 30% launch). The mint is public, so it's typed in plainly.
#
#   tools/launch/switch-mint.sh <mint>
set -e
cd "${0:A:h}/../.."
mint="$1"
if [[ ! "$mint" =~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' ]]; then echo "usage: $0 <real coin mint address>"; exit 1; fi
if [[ "$mint" == "HFypaAkLk4XwKJvLK5hTvL65dhY2F61davhjo1x8pump" ]]; then echo "That's the throwaway test coin."; exit 1; fi

echo "Switching COCKFIGHT to $mint"
read -r "ok?Type LAUNCH to go on: "
[[ "$ok" == "LAUNCH" ]] || { echo "Stopped; nothing changed."; exit 1; }

echo "\n[1/3] game server (restarts; any live match finishes first)"
fly secrets set -a cockfight-game NEXT_PUBLIC_COCK_MINT="$mint" GATE_USD_MIN=30
echo "\n[2/3] worker"
fly secrets set -a cockfight-worker COCK_MINT="$mint"
echo "\n[3/3] site"
tools/launch/deploy-web.sh "$mint"

echo "\nChecking ..."
pnpm --filter @cockfight/tools launch:preflight -- "$mint" --launch || true
