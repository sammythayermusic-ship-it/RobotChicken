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

- [ ] **Fund the hot wallet, then start the worker.** On 2026-10-01 the worker app was scaled to
      zero (~05:30 UTC) and the hot wallet held 0.0009 SOL. The game didn't spend it: 191 fee
      claims over six days cost 0.004 SOL in total. The SOL left in hand-signed transfers to
      `5EmJ88B74PQvWKFezpwLt4wFv5ZW84m5wRbWo2fXpbSk` (nine, the last 0.397 SOL at 05:25 UTC) and a swap.
      **Keep the hot wallet for the worker only**: anything else signing with it moves the float
      the payouts rely on. Float: claims cost ~0.0007 SOL a day; each first-time winner's PUMP
      account costs ~0.002 SOL of rent, so 0.5 SOL covers ~200 new winners. The worker alerts on
      Telegram when it runs low. Then: `tools/launch/start-worker.sh`.
- [x] Game server on a dedicated CPU with a live-match cap (done 2026-10-01, see the load test at the end).

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

## 2. Fill the prize pot (Sammy)

Wins pay from a pot: Rust 5%, Chrome 8%, Gold 12% of what is in it, each win taken off at
once. Fees are claimed into it every minute. Once it has been worth $500, $100 always stays in.

1. Send the starting PUMP (e.g. $30 worth) to the **hot wallet** `HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1`.
2. `/admin` → Prize pot → type the number of PUMP → Add. Only after it has landed.
   Within a minute the site shows the pot and the next win: a $30 pot pays a Rust win $1.50,
   Chrome $2.40, Gold $3.60.

Top it up the same way any time. (The seed wallet and its 1/14-a-day drip are retired.)

## 3. Launch day

**Live the second the coin drops.** If the mint address is known before the coin is created
(a pre-generated mint keypair), switch everything to it beforehand:
```bash
tools/launch/switch-mint.sh <mint>     # type LAUNCH; the preflight's chain checks fail until the coin exists, that's expected
```
Until the coin exists the site is up on the real address, the gate tells players there's no
price yet, and the worker quietly finds nothing to claim. The moment the coin is created:

**Sammy, on pump.fun:**
1. Create $COCK from the **new** launch wallet (its address goes in `LAUNCH_WALLET` in `apps/worker/fly.toml` first; Claude does that when you send it), paired to PUMP, with that mint.
2. Turn on **Share creator rewards**: 70% hot `HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1`, 30% the launch wallet.
3. Run `pnpm --filter @cockfight/tools launch:preflight -- <mint> --launch`: everything green.

(If the mint isn't known in advance: create the coin, then run `switch-mint.sh <mint>`.)

`switch-mint.sh` sets `NEXT_PUBLIC_COCK_MINT` + `GATE_USD_MIN=30` + `GATE_MODE=required` on the game server
(the last one closes free play: since 2026-10-01 the test-coin server runs `GATE_MODE=open` so anyone can
play online with just a name and nothing pays),
`COCK_MINT` on the worker, rebuilds the site with the mint (search engines allowed) and
deploys it to cockfightsol.fun, then runs the launch preflight. Fly restarts both apps
(a live match finishes first; there are none yet on launch day).

**Watch for the first hour:**
- Telegram: fees are claimed every minute (it alerts only on 3 failed claims in a row). `/admin` shows the pot filling.
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

Then the server got cheaper per match: frames go out every 2 ticks and the room state's
clock is mirrored twice a second instead of every tick (socket writes were the biggest cost
in a CPU profile). Same 100 steady matches on the Mac: 32.7% → 25.0% of a core. On Fly
performance-1x after the change: 100 matches p50 3–5 / p99 15–33 ms; 130 matches p50 6–9 /
p99 26–46 ms.

So: **one dedicated CPU runs 100 concurrent matches (200 players) well.** Production is now
`performance-1x` with `MAX_LIVE_MATCHES=100`: past that, players wait in the queue ("every pit
is busy") and keep their place, so nobody's match lags. More than ~100 at once needs a second
machine (Redis + per-machine routing).
