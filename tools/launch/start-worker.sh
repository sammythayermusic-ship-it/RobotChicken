#!/bin/zsh
# Starts (or restarts) the payout worker on Fly with the current code, once the
# hot wallet has SOL for fees. Run from anywhere; nothing secret is printed.
#
#   tools/launch/start-worker.sh
set -e
cd "${0:A:h}/../.."
HOT=HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1
key=$(grep -E '^HELIUS_API_KEY=' .env.local | head -1 | cut -d= -f2- | tr -d '"'\''')
[[ -n "$key" ]] || { echo "HELIUS_API_KEY missing from .env.local"; exit 1; }
lamports=$(curl -s "https://mainnet.helius-rpc.com/?api-key=$key" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$HOT\"]}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["value"])')
sol=$(python3 -c "print($lamports/1e9)")
echo "Hot wallet: $sol SOL"
if (( lamports < 50000000 )); then
  echo "Under 0.05 SOL: the worker couldn't pay its fees. Send SOL to $HOT first."
  exit 1
fi
fly deploy . --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile --ha=false --depot
fly machines list -a cockfight-worker
echo "Worker started. Telegram alerts go to you; the first fee claim runs within 10 minutes."
