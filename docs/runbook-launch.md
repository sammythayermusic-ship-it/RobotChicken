# Launch runbook

Everything between "the stack works on the test coin" and "the real coin is live".
Each step says who does it. Scripts live in `tools/launch/`; run them from `~/cockfight`
in Terminal. The preflight is read-only and safe to run any time:

```bash
pnpm --filter @cockfight/tools launch:preflight              # checks whatever coin the game server is on
pnpm --filter @cockfight/tools launch:preflight -- <mint> --launch   # launch-day rules too
```

It checks the game server (health, gate mode, coin, $ gate, secrets), the worker
(machine, secrets), the chain (bonding curve paired to PUMP, creator rewards 70% hot /
30% launch, both price sources, SOL for fees) and the site (up, link card, indexable).

## 0. Before anything (Sammy)

- [ ] **The worker is down and the hot wallet is out of SOL** (found 2026-10-01: `cockfight-worker`
      has no machine; the hot wallet holds 0.0009 SOL, down from ~0.3 on 9/25, and its last
      transaction was 05:30 UTC). Claims every 10 min plus payouts at a 100k µlamports/CU
      priority fee spent it. Decide the SOL float (and whether to lower `PRIORITY_FEE_MICROLAMPORTS`),
      top up the hot wallet, then redeploy the worker
      (`fly deploy . --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile --ha=false --depot`).
- [ ] Move the game server to a dedicated CPU (see the load test at the end).

- [ ] Merge PRs in order: #5 (go-live) → #6 (claim alerts) → #7 (launch videos) → the Phase 4 PR.
- [ ] Get a Jupiter API key (portal.jup.ag) and set it on both apps yourself:
      `fly secrets set -a cockfight-game JUPITER_API_KEY=…` and the same for `cockfight-worker`.
      Keyless Jupiter is rate-limited; the gate and the worker both price through it.
- [ ] Legal: done (Sammy, 2026-10-01). No geo-block.

## 1. Live payout test (Sammy plays, Claude checks)

1. From the launch wallet, send ~500k test coin to a second wallet (the seed wallet works).
2. On the Mac: open https://cockfightsol.fun/play → Online, paste the launch wallet.
3. On a phone **on cellular** (the queue never pairs the same IP /24 or browser): same, with the second wallet.
4. Play one ranked match to the end. The winner should be paid ~181 PUMP (about $0.75, the Rust floor).
5. Claude checks the `payouts` row, the transaction, and that `fee_claims` rows are landing.
6. Re-shoot the promo's payout card from that real result (`pnpm --filter @cockfight/tools video:online`, then swap the staged shot).

## 2. Funding day (Sammy decides the numbers)

1. Put ~0.05 SOL in the seed wallet `BGZx5Lti1gWY7yD55pMBePiCAUPN4sEJYrmGUuLDjWwX` for fees.
2. Run `tools/launch/fund.sh`. It asks for the per-win budget, the daily top-10 pool, the cold
   wallet, then the seed wallet's private key (hidden; piped straight to Fly).
3. After the real coin exists and its fees are flowing in PUMP, send the seed PUMP to the seed wallet.
4. `/admin` → Seed → enter the raw amount → Record top-up (only once the tokens have landed).
   The worker may draw at most 1/14 of the seed a day.

Funding can happen before or after the launch switch; until the seed is recorded the
guarantees just stay off and the site shows the real pool.

## 3. Launch day

**Sammy, on pump.fun:**
1. Create $COCK from the launch wallet `Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF`, paired to PUMP.
2. Turn on **Share creator rewards**: 70% hot `HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1`, 30% launch.
3. Copy the mint address.

**Then (Sammy runs it; Claude can drive it):**
```bash
pnpm --filter @cockfight/tools launch:preflight -- <mint>      # the chain checks should pass now
tools/launch/switch-mint.sh <mint>                             # type LAUNCH to confirm
```
`switch-mint.sh` sets `NEXT_PUBLIC_COCK_MINT` + `GATE_USD_MIN=30` on the game server,
`COCK_MINT` on the worker, rebuilds the site with the mint (search engines allowed) and
deploys it to cockfightsol.fun, then runs the launch preflight. Fly restarts both apps
(a live match finishes first; there are none yet on launch day).

**Watch for the first hour:**
- Telegram: the first fee claim within 10 minutes of the first trades (it alerts only on 3 failures in a row).
- `/admin`: the pool, payouts, held payouts, flags.
- `https://cockfight-game.fly.dev/health`: `load.loopP99Ms` under ~10 ms is healthy (see the load test below).
- Play one ranked match yourself (two devices, two networks) and check the payout lands.

## Rollback and stops

| Problem | Do this |
|---|---|
| Payouts look wrong | `/admin` → Pause payouts (the worker keeps claiming and booking; nothing is sent). Or `fly secrets set -a cockfight-worker PAYOUTS_ENABLED=false`. |
| A cap tripped | Payouts pause themselves; check `/admin`, resume by hand. |
| Bad game server deploy | `fly releases -a cockfight-game`, then `fly deploy --image <previous image>` with the same flags. Web and game server share `rulesHash`, so roll the site back too if `step()` changed. |
| Bad site deploy | Netlify → Deploys → publish the previous deploy. |
| Server overloaded | See the load test: one machine holds 200 matches. Past that, Phase 5 adds Redis and a second machine. |

## Load test (2026-10-01)

`tools/loadtest`: bots that queue, take their seats, run the browser's ClientPredictor at
60 Hz and peck until KO. Run it against a **throwaway copy** of the game server in open mode,
never the live one:

```bash
fly apps create cockfight-loadtest
fly deploy . --config tools/loadtest/fly.loadtest.toml --dockerfile apps/game/Dockerfile --ha=false --depot
LT_URL=https://cockfight-loadtest.fly.dev LT_MATCHES=200 LT_SECONDS=600 pnpm --filter @cockfight/tools loadtest
fly apps destroy cockfight-loadtest --yes
```

The generator must run in the cloud too: from a home connection the bots' sockets dropped
(1006) while the server sat idle. `tools/loadtest/Dockerfile` runs them on a Fly machine:

```bash
fly apps create cockfight-loadgen
fly machine run . --dockerfile tools/loadtest/Dockerfile -a cockfight-loadgen --vm-size performance-4x \
  --region iad --restart no --env LT_URL=https://cockfight-loadtest.fly.dev --env LT_MATCHES=100 \
  --env LT_SECONDS=30 --env LT_PECK_EVERY=0     # 0 = never attack: steady load, no churn
fly apps destroy cockfight-loadgen --yes
```

Results (event-loop delay = how late the 60 Hz tick runs; a tick is 16.7 ms):

| Server size | Load | Loop delay p50 / p99 | Verdict |
|---|---|---|---|
| shared-cpu-1x (production today) | 50 matches, after a burst | ~300 / ~470 ms | Fly throttles shared CPUs once the burst budget is spent. Not fit for launch. |
| performance-1x (1 dedicated CPU) | 100 matches steady | 2 / 15–33 ms | Fine. |
| performance-1x | 200 matches steady | 60–70 / 100–130 ms | Saturated: the sim runs several frames behind. |
| performance-1x | 200 matches, heavy churn (~3.5 new matches/s) | 15–50 / 50–110 ms | 1,692 matches in 7 min; 0 snaps, 0 desyncs; 5% of seats lost to "seat reservation expired". |

So: **one dedicated CPU holds ~100 concurrent matches (200 players) comfortably.** Before
launch, move the game server to `performance-1x` (`[[vm]]` in `apps/game/fly.toml`). Past
~100 matches it needs a second machine (Redis + per-machine routing, Phase 5) or a
cheaper per-tick server loop.
