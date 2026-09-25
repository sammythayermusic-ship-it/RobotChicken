# COCKFIGHT: build plan for Phase 3 (money)

The spec's Economics, Payouts, Anti-abuse and Review-tooling sections are the base.
This plan records what Sammy changed on 2026-09-24, works out the mechanics so the
pool can never be overdrawn, and sets the order of work. Nothing here moves real
money until Phase 4 (mainnet); everything is built and tested against devnet first.

## Agreed with Sammy (2026-09-24)

| Choice | Decision |
|---|---|
| Launchpad | **pump.fun**, Custom Pair with **PUMP** as the quote token, creator rewards to **Creator** (never Holders: that switch is one-way and sends fees to holders), Mayhem mode off. |
| Fee | **3% creator fee**, set in the Advanced → "Creator fee (%)" field at launch, on top of pump.fun's own trading fee. |
| Split | 70% of claimed fees to players, 30% to the project (servers, art, marketing, reserve). |
| Payout currency | **PUMP**. Custom Pairs pay creator fees in the quote token, so fees arrive as PUMP and winners are paid in PUMP: no swap anywhere between a trade and a payout. |
| Entry | Hold ≥ $30 of $COCK at queue time and at match start. Nothing is wagered. |
| Tiers | **Rust $30 · Chrome $250 · Gold $1,000**, prize weight **1× · 2.5× · 6×**. The spec's four cosmetic tiers become three; Diamond's cosmetics fold into Gold. Tiers still never touch fighter stats. |
| Matchmaking | Same tier first; after 60 s in queue, any tier. A cross-tier match pays **the lower tier's rate** to whoever wins. |
| Daily top 10 | One global board ranked by wins (ties by ELO), 20% of the day's fees, split 25/18/13/10/8/7/6/5/4/4%, paid at 00:00 UTC. Tier shows as a badge. |
| Launch seed | Sammy funds a seed pool. It may drain at **most 1/14 per day**, so it lasts at least two weeks whatever happens. |
| Site | The front page shows the live pool: next win per tier, today's leaderboard pool and countdown, fees claimed, paid out, and the seed remaining. |
| Automation | Fee claims, per-win payouts, daily payouts and the seed draw all run in `apps/worker` with no human step. Sammy only tops up the seed and moves the project share. |

## Money flow

```
trader swaps $COCK ⇄ PUMP on pump.fun (bonding curve, then PumpSwap); the 3% creator fee accrues
        │  hourly claim (worker)
        ▼
LAUNCH_WALLET  (PUMP, Sammy's)  ──── 30%: the project share, via pump.fun's "Share creator rewards"
        │  70% shared to HOT_WALLET the same way (★ verify on the throwaway token; else the worker
        │  claims everything with a claim-only key and forwards 30% to Sammy hourly)
        ▼
HOT_WALLET  (PUMP + a little SOL for fees)  ── claims its share hourly; pays wins within seconds, top 10 at 00:00 UTC.
                                              Holds ≤ 36 h of payouts: anything above that is swept to a COLD_WALLET (Sammy's)
        │
SEED_WALLET (PUMP, Sammy's launch seed) ── worker may draw ≤ 1/14 of the original seed per day,
                                          only to lift quiet days to the guaranteed minimums
```

Only the worker holds private keys (HOT_WALLET and SEED_WALLET). LAUNCH_WALLET's
key is Sammy's. If pump.fun's reward sharing can't route 70% to HOT_WALLET directly,
the fallback is a claim-only key that can collect creator fees and nothing else
(★ settled on the throwaway token; see Fee claiming).

## Per-win payout

One shared player pool, weighted by tier. This is the spec's formula with tier
weights, and it is what keeps the pool solvent: the more matches happen, in any
tier, the smaller each prize gets, so the total paid in a day can never exceed the
budget.

```
B24   = PUMP claimed in the trailing 24 h (gross)
D     = 0.5 × B24 + seedTopUp            daily per-win budget
W     = Σ over matches in the trailing 24 h of weight(tier of that match)
base  = D / max(W, W_floor)              W_floor = 200 (weighted matches)
p(t)  = clamp(base × w_t, P_min × w_t, P_max × w_t) × q
```

- `w_t` = 1 / 2.5 / 6 for Rust / Chrome / Gold. A cross-tier match uses the lower tier.
- `P_min`, `P_max` are set in USD and converted to PUMP at the hourly claim price:
  **$0.75 and $75 for Rust** (so Gold's cap is $450). Both tunable in `/admin`.
- `q` = net-quality multiplier from the spec: 1 normally, 0.5 if the winner dropped
  > 15% of inputs, 0 if > 30% or for a forfeit under 30 s.
- Recomputed every minute by the worker and written to a `pool_state` row; the game
  server reads it at match end and enqueues the payout in the same transaction as
  the result.

**Worked example**: $500k daily volume → $15k in creator fees. Per-win budget
$7,500. 1,500 matches: 1,000 Rust, 400 Chrome, 100 Gold → W = 1,000 + 1,000 + 600 =
2,600 → base $2.90. A Rust win pays $2.90, Chrome $7.20, Gold $17.30 (all in PUMP at
that hour's price). Daily pool $3,000: first place $750. At $50k volume the numbers
are a tenth of that, and Rust wins fall to the $0.75 floor, which the seed covers.

## The seed and the guaranteed minimums

Sammy sets two numbers in `/admin`: a **guaranteed daily per-win budget** `G_win`
and a **guaranteed daily leaderboard pool** `G_daily`, both in USD. Each day:

```
shortfall = max(0, G_win − 0.5 × B24) + max(0, G_daily − 0.2 × B_day)
seedDraw  = min(shortfall, seedOriginal / 14, seedRemaining)
```

The draw is booked at 00:00 UTC for the day ahead and spread across the day's
matches through `seedTopUp`; nothing is drawn on a day that fees already cover.
When the seed is empty the guarantees switch off and the site shows the real
numbers, so the seed is a runway, never a promise the game can't keep. Sammy can
top it up at any time; a top-up raises `seedOriginal` for the 1/14 rule.

## Invariants the worker enforces (tests for each)

1. Nothing is paid that fees or the seed did not bring in, by the ledger's own count:
   the **allowance** (player share claimed + seed draws − payouts sent − sweeps to cold)
   never goes below zero. A payout that would take it there is deferred, not dropped.
   (Built as an allowance rather than the trailing-24 h window first written here: the
   window stalls every payout during a claim outage, see `docs/decisions.md`.)
2. `seedDraw` ≤ `seedOriginal / 14` per UTC day.
3. HOT_WALLET is topped up only to `p × max(W, W_floor) × 1.5 + today's daily pool`;
   a compromise costs at most ~36 h of payouts plus one day's pool.
4. Per-transaction, per-hour and per-day caps in the worker (`MAX_PAYOUT_USD` per win,
   `MAX_DAILY_REWARD_USD` per daily reward, `MAX_HOURLY_USD` on wins, `MAX_DAILY_USD` on
   everything; converted to PUMP hourly). Any cap hit pauses payouts and pings Telegram;
   queued payouts wait as `deferred` and resume when Sammy clears the flag.
5. Every payout is idempotent: key `win:<matchId>` or `daily:<day>:<rank>`. A retry
   never pays twice; a crash mid-send is reconciled from the chain on restart.
6. Payouts are computed from the ledger, never from a live wallet balance; before
   each send the worker checks the wallet can cover it, and otherwise defers. The
   ledger allowance is what the wallet should hold; a sweep takes only what is above it.
7. If fee claiming fails for 6 h, payouts continue from what is already budgeted;
   when HOT_WALLET runs dry the site shows "pool paused" instead of a stale number.

## Per-wallet caps and anti-abuse (from the spec, unchanged)

- 40 paid wins per wallet per day, tied to fingerprint and IP as well; 10 paid
  matches per day against the same opponent; both shown on the profile.
- Queue pairs only at ≥ 4 players; never two tickets sharing an IP /24, fingerprint
  or session cookie; 2-minute rematch cooldown. These plug into `QueueRoom.canPair()`.
- Turnstile on queue entry (built in Phase 2); input-timing analysis flags bots;
  flagged wallets pay 0 pending review; replays already exist for that review.
- Username claims need a signed message (`cockfight:claim:<nonce>`), which also
  ends Phase 2's "a pasted address moves that address's ELO".
- `/admin` (basic auth, allowlisted IPs): flagged matches with the replay viewer,
  wallet, fingerprint, IP; one-click void / ban 24 h / clear; pool knobs; the
  pause switch; the seed and cap settings.

## Fee claiming (pump.fun)

Sammy chose pump.fun (2026-09-24) over the spec's Meteora DBC: a Custom Pair with
PUMP as quote and the creator fee set to 3% at launch. Pump.fun has no devnet, so
the claim path is proven on a **throwaway token** on mainnet (about 0.05 SOL plus a
few dollars of PUMP in tiny trades, made by Sammy in the browser) launched with
exactly the real settings. That run settles:

- that the 3% applies on the bonding curve **and** after graduation on PumpSwap
  (or what changes at graduation), and that it arrives in PUMP;
- how "Share creator rewards" (set from the coin page after creation) splits fees,
  and whether HOT_WALLET can be a direct 70% recipient;
- the exact claim instruction and accounts for the worker (pump program before
  graduation, PumpSwap after), and how often claiming is worth the transaction fee;
- pump.fun's own trading fee on top of the 3%, so the site can state the total.

Every claim and top-up is a `fee_claims` row, so the front page can show gross
fees, the player share and the project share to the lamport.

## Paying in PUMP: the details

- The PUMP mint is `PAYOUT_MINT` in env; decimals are read from chain at boot, so
  switching the payout token later is one variable.
- A winner may have no PUMP token account. The worker creates it (about 0.002 SOL of
  rent, paid by HOT_WALLET's SOL) in the same transaction as the first payout.
  SOL for fees and rent is a separate small balance with its own low-balance alert.
- Gate pricing stays in USD via Jupiter ($COCK in USD, PUMP in USD). `P_min`, `P_max`,
  `G_win`, `G_daily` are USD too, converted at each hourly claim, so a PUMP price move
  changes the PUMP amounts, not the dollar value.

## Data

New tables: `fee_claims` (stage, pump, sig, price), `pool_state` (one row,
recomputed each minute), `payouts` (kind win/daily/seed-topup, idempotency key,
gme, sig, status pending/sent/paid/deferred/failed/voided), `daily_pools` (day,
gross, pool, seed part, paid), `seed` (original, remaining, draws), `flags`,
`usernames`. Public views for the site: `pool_v`, `leaderboard_v` (already exists,
gains the pool figures), `payouts_v` (Solscan links per match).

## Web

- Front page: "next win pays" per tier, today's pool with countdown and what each
  rank earns right now, all-time fees / paid / seed remaining, last 10 payouts with
  Solscan links.
- Result screen: the PUMP amount and a Solscan link within ~10 s of the KO.
- Profile: tier, caps used today, today's earnings, rank.
- `/how-it-works`: the whole economy in plain words (also the explainer video's script).
- Share card and the replay page's OG image.

## Order of work (branch `phase-3-money`, one PR, stop for review)

Status (2026-09-25): 1, 2, 4, 5 (no share card yet), 6 and 7 are built; 3 (the claim on the
throwaway coin from the deployed worker) is the first go-live step in `docs/HANDOFF.md`.

1. **Ledger and formula**: `packages/economy` with the pool maths above as pure
   functions and a simulator that runs a synthetic month (volume curves, whale
   farming, bot bursts, quiet days) and asserts every invariant. This is where
   "can't run out" is proven before a wallet exists.
2. **Worker**: claim loop, pool recompute, payout queue with the caps and
   idempotency, daily job, seed draw, Telegram alerts, chain reconciliation.
   Devnet end to end with a test mint standing in for PUMP and plain SPL transfers.
3. **Throwaway token on pump.fun**: Sammy launches it with the real settings and
   makes a few tiny trades; the worker claims from it end to end. Settles the ★
   fee-claim questions above.
4. **Game server**: tiers in the queue and `canPair()`, cross-tier rate, payout
   enqueue at match end, per-wallet caps, q-multiplier, usernames by signing.
5. **Web**: pool on the front page, result screen payout, profile, `/how-it-works`,
   share card.
6. **`/admin`**.
7. Docs, decisions, changelog, HANDOFF; review; PR.

## Launch kit (alongside, not blocking the code)

- **Domain**: **cockfightsol.fun**, registered on Cloudflare Registrar 2026-09-24 (DNS on
  Cloudflare, so Turnstile, the site and the game server share one dashboard).
- **X account**: **@CockFightSol** (x.com/CockFightSol), created 2026-09-24. Bio, banner and
  pinned post come from the launch kit.
- **Hype video (60–90 s)**: real gameplay captured at 60 fps on Sammy's Mac (OBS or
  QuickTime from the local build with `?quality=high`), cut to the beat, with
  cinematic inserts of the chickens rendered from the Blender files. Sammy mixes
  the sound himself. No ElevenLabs anywhere in the pipeline.
- **Explainer video (2–3 min)**: motion-graphics over the `/how-it-works` script:
  hold $30, fight, win, PUMP lands in your wallet, top 10 daily, where the money
  comes from. Voice-over recorded by Sammy (he has the studio); on-screen numbers
  pulled from the real pool so nothing in the video can go stale on day one.
- **Launch sequence**: teaser clips from the playtest → explainer → domain live with
  the live pool showing the seed → token launch and site the same day (spec).

## Open ★ for Sammy (asked as each comes up)

- The fee-claim details above, settled on the throwaway token.
- `G_win`, `G_daily` and the seed size: set them the day the wallet is funded.
- Whether drawn matches pay (spec's open question): proposed **no**, both players
  re-queue at once.
- The q-multiplier's "> 30% voids" rule (spec left it open): proposed as written.
- A lawyer's read and a geo-block list before mainnet (Phase 4, from the HANDOFF).
