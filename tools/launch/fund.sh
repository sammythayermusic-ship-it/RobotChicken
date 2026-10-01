#!/bin/zsh
# FUNDING DAY: puts the guarantee budgets, the cold wallet and the seed
# wallet's key on the worker. The key is read silently and piped straight to
# Fly; it is never shown or saved. Then send the seed PUMP and record it in
# /admin (see docs/runbook-launch.md).
set -e
cd "${0:A:h}/../.."
echo "=== COCKFIGHT funding day ==="
echo "Seed wallet: BGZx5Lti1gWY7yD55pMBePiCAUPN4sEJYrmGUuLDjWwX"
echo
read -r "win?Guaranteed per-win budget, USD a day (GUARANTEED_WIN_BUDGET_USD, 0 = none): "
read -r "daily?Guaranteed daily top-10 pool, USD (GUARANTEED_DAILY_POOL_USD, 0 = none): "
read -r "cold?Cold wallet address (the project share is swept here): "
for v in "$win" "$daily"; do [[ "$v" =~ '^[0-9]+(\.[0-9]+)?$' ]] || { echo "\"$v\" isn't a number; nothing changed."; exit 1; }; done
[[ "$cold" =~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' ]] || { echo "That cold wallet doesn't look like a Solana address; nothing changed."; exit 1; }
echo
echo "Now the SEED wallet's private key (base58 from Phantom, or the [..] byte array)."
echo "Nothing will show while you paste."
read -rs "k?Key: "
echo
[[ -n "$k" ]] || { echo "No key entered; nothing changed."; exit 1; }
printf 'GUARANTEED_WIN_BUDGET_USD=%s\nGUARANTEED_DAILY_POOL_USD=%s\nCOLD_WALLET=%s\nSEED_WALLET_KEYPAIR=%s\n' "$win" "$daily" "$cold" "$k" | fly secrets import -a cockfight-worker > .fund.log 2>&1
code=$?
unset k
echo "exit $code" >> .fund.log
if [[ $code -eq 0 ]]; then
  echo "Done. The worker is restarting with the budgets."
  echo "Next: send the seed PUMP to the seed wallet, then /admin → Seed → record the top-up."
else
  echo "Fly said no; see .fund.log"
fi
