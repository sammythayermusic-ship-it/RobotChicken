# COCKFIGHT: build plan for Phase 3 (money)

The spec's Economics, Payouts, Anti-abuse and Review-tooling sections are the base.
This plan records what Sammy changed on 2026-09-24, works out the mechanics so the
pool can never be overdrawn, and sets the order of work. Nothing here moves real
money until Phase 4 (mainnet); everything is built and tested against devnet first.

## Agreed with Sammy (2026-09-24)

| Choice | Decision |
|---|---|
| Fee | 3% on every $COCK trade; $COCK is paired to GME (GME is the quote token). |
| Split | 70% of claimed fees to players, 30% to the project (servers, art, marketing, reserve). |
| Payout currency | **GME**, not SOL (the spec's "one flag"). Fees already arrive as GME, so no swap sits between a win and the payout. |
| Entry | Hold ≥ $30 of $COCK at queue time and at match start. Nothing is wagered. |
| Tiers | **Rust $30 · Chrome $250 · Gold $1,000**, prize weight **1× · 2.5× · 6×**. The spec's four cosmetic tiers become three; Diamond's cosmetics fold into Gold. Tiers still never touch fighter stats. |
| Matchmaking | Same tier first; after 60 s in queue, any tier. A cross-tier match pays **the lower tier's rate** to whoever wins. |
| Daily top 10 | One global board ranked by wins (ties by ELO), 20% of the day's fees, split 25/18/13/10/8/7/6/5/4/4%, paid at 00:00 UTC. Tier shows as a badge. |
| Launch seed | Sammy funds a seed pool. It may drain at **most 1/14 per day**, so it lasts at least two weeks whatever happens. |
| Site | The front page shows the live pool: next win per tier, today's leaderboard pool and countdown, fees claimed, paid out, and the seed remaining. |
| Automation | Fee claims, per-win payouts, daily payouts and the seed draw all run in `apps/worker` with no human step. Sammy only tops up the seed and moves the project share. |

## Money flow

```
trader swaps $COCK ⇄ GME on the Meteora pool (3% fee stays in the pool)
        │  hourly claim (worker)
        ▼
CREATOR_WALLET  (GME)  ──── 30% stays here: the project share, Sammy moves it by hand
        │  70% is booked to the player ledger (Postgres), not moved yet
        │  hourly top-up: only what HOT_WALLET needs for the next 36 h + today's daily pool
        ▼
HOT_WALLET  (GME + a little SOL for fees)  ── pays wins within seconds, top 10 at 00:00 UTC
        │
SEED_WALLET (GME, Sammy's launch seed) ── worker may draw ≤ 1/14 of the original seed per day,
                                          only to lift quiet days to the guaranteed minimums
```

Only the worker holds private keys (HOT_WALLET and SEED_WALLET). CREATOR_WALLET's
key is Sammy's; the worker needs it only if fee claiming must be signed by the
creator, in which case the claim signer is a separate key with no other rights
(★ confirm with the launchpad's config; see Fee claiming).

## Per-win payout

One shared player pool, weighted by tier. This is the spec's formula with tier
weights, and it is what keeps the pool solvent: the more matches happen, in any
tier, the smaller each prize gets, so the total paid in a day can never exceed the
budget.

```
B24   = GME claimed in the trailing 24 h (gross)
D     = 0.5 × B24 + seedTopUp            daily per-win budget
W     = Σ over matches in the trailing 24 h of weight(tier of that match)
base  = D / max(W, W_floor)              W_floor = 200 (weighted matches)
p(t)  = clamp(base × w_t, P_min × w_t, P_max × w_t) × q
```

- `w_t` = 1 / 2.5 / 6 for Rust / Chrome / Gold. A cross-tier match uses the lower tier.
- `P_min`, `P_max` are set in USD and converted to GME at the hourly claim price:
  **$0.75 and $75 for Rust** (so Gold's cap is $450). Both tunable in `/admin`.
- `q` = net-quality multiplier from the spec: 1 normally, 0.5 if the winner dropped
  > 15% of inputs, 0 if > 30% or for a forfeit under 30 s.
- Recomputed every minute by the worker and written to a `pool_state` row; the game
  server reads it at match end and enqueues the payout in the same transaction as
  the result.

**Worked example** (GME at $25): $500k daily volume → $15k fees → 600 GME. Per-win
budget 300 GME. 1,500 matches: 1,000 Rust, 400 Chrome, 100 Gold → W = 1,000 + 1,000 +
600 = 2,600 → base 0.115 GME (~$2.90). Rust win pays $2.90, Chrome $7.20, Gold $17.30.
Daily pool 120 GME ($3,000): first place $750. At $50k volume the numbers are a
tenth of that, and Rust wins fall to the $0.75 floor, which the seed covers.

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

1. Player payouts booked in any 24 h ≤ 70% of fees claimed in that window + that
   day's `seedDraw`. A payout that would break this is deferred, not dropped.
2. `seedDraw` ≤ `seedOriginal / 14` per UTC day.
3. HOT_WALLET is topped up only to `p × max(W, W_floor) × 1.5 + today's daily pool`;
   a compromise costs at most ~36 h of payouts plus one day's pool.
4. Per-transaction, per-hour and per-day GME caps in the worker (`MAX_PAYOUT_GME`,
   `MAX_HOURLY_GME`, `MAX_DAILY_GME`). Any cap hit pauses payouts and pings Telegram;
   queued payouts wait as `deferred` and resume when Sammy clears the flag.
5. Every payout is idempotent: key `win:<matchId>` or `daily:<day>:<rank>`. A retry
   never pays twice; a crash mid-send is reconciled from the chain on restart.
6. Payouts are computed from the ledger, never from a live wallet balance; before
   each send the worker checks the wallet can cover it, and otherwise defers.
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

## Fee claiming (Meteora)

The spec locks a Meteora DBC-style launch with GME as quote and a 3% total fee.
Meteora's docs list DAMM v2 fee tiers (25/30/100/200/400/600 bps) plus a
"customizable" config, and migration keepers for a fixed set of quote tokens plus
"Jupiter Verified" tokens above a score threshold. To verify on devnet in week 1
(★ the launchpad choice is still Sammy's):

- a DBC config with GME quote and a 3% fee (custom config key);
- who claims (creator vs partner) and in which token; the worker's claim signer;
- whether the keeper migrates a GME-quoted pool to DAMM v2 or the worker must call
  `migrate` itself;
- after migration, the locked LP position earns fees in **both** tokens: the
  worker claims both and swaps any $COCK to GME through Jupiter in chunks ≤ $2k.

Every claim, swap and top-up is a `fee_claims` row, so the front page can show
gross fees, the player share and the project share to the lamport.

## Paying in GME: the details

- GME mint (Solana) is set as `GME_MINT` in env; decimals read from chain at boot.
- A winner may have no GME token account. The worker creates it (about 0.002 SOL of
  rent, paid by HOT_WALLET's SOL) in the same transaction as the first payout.
  SOL for fees and rent is a separate small balance with its own low-balance alert.
- Gate pricing stays in USD via Jupiter ($COCK in USD, GME in USD). `P_min`, `P_max`,
  `G_win`, `G_daily` are USD too, converted at each hourly claim, so a GME price move
  changes the GME amounts, not the dollar value.

## Data

New tables: `fee_claims` (stage, gme, cock, sig, price), `pool_state` (one row,
recomputed each minute), `payouts` (kind win/daily/seed-topup, idempotency key,
gme, sig, status pending/sent/paid/deferred/failed/voided), `daily_pools` (day,
gross, pool, seed part, paid), `seed` (original, remaining, draws), `flags`,
`usernames`. Public views for the site: `pool_v`, `leaderboard_v` (already exists,
gains the pool figures), `payouts_v` (Solscan links per match).

## Web

- Front page: "next win pays" per tier, today's pool with countdown and what each
  rank earns right now, all-time fees / paid / seed remaining, last 10 payouts with
  Solscan links.
- Result screen: the GME amount and a Solscan link within ~10 s of the KO.
- Profile: tier, caps used today, today's earnings, rank.
- `/how-it-works`: the whole economy in plain words (also the explainer video's script).
- Share card and the replay page's OG image.

## Order of work (branch `phase-3-money`, one PR, stop for review)

1. **Ledger and formula**: `packages/economy` with the pool maths above as pure
   functions and a simulator that runs a synthetic month (volume curves, whale
   farming, bot bursts, quiet days) and asserts every invariant. This is where
   "can't run out" is proven before a wallet exists.
2. **Worker**: claim loop, pool recompute, payout queue with the caps and
   idempotency, daily job, seed draw, Telegram alerts, chain reconciliation.
   Devnet end to end with a test GME mint and plain SPL transfers.
3. **Meteora on devnet**: create the GME-quoted DBC pool, trade against it, claim,
   migrate, claim from DAMM v2. Settles the ★ launchpad questions.
4. **Game server**: tiers in the queue and `canPair()`, cross-tier rate, payout
   enqueue at match end, per-wallet caps, q-multiplier, usernames by signing.
5. **Web**: pool on the front page, result screen payout, profile, `/how-it-works`,
   share card.
6. **`/admin`**.
7. Docs, decisions, changelog, HANDOFF; review; PR.

## Launch kit (alongside, not blocking the code)

- **Domain**: the spec names `cockfight.fun`. Sammy registers it (Namecheap or
  Cloudflare Registrar); DNS on Cloudflare so Turnstile, the site and the game
  server share one dashboard. Alternates if taken: `cockfight.gg`, `cockfight.lol`.
- **X account**: Sammy creates `@cockfightfun` (or the domain's handle) and keeps
  the credentials. Bio, banner and pinned post come from the launch kit.
- **Hype video (60–90 s)**: real gameplay captured at 60 fps on Sammy's Mac (OBS or
  QuickTime from the local build with `?quality=high`), cut to the beat, with
  cinematic inserts of the chickens rendered from the Blender files. Sammy mixes
  the sound himself. No ElevenLabs anywhere in the pipeline.
- **Explainer video (2–3 min)**: motion-graphics over the `/how-it-works` script:
  hold $30, fight, win, GME lands in your wallet, top 10 daily, where the money
  comes from. Voice-over recorded by Sammy (he has the studio); on-screen numbers
  pulled from the real pool so nothing in the video can go stale on day one.
- **Launch sequence**: teaser clips from the playtest → explainer → domain live with
  the live pool showing the seed → token launch and site the same day (spec).

## Open ★ for Sammy (asked as each comes up)

- Launchpad: Meteora DBC confirmed once the devnet run settles the fee/claim details.
- `G_win`, `G_daily` and the seed size: set them the day the wallet is funded.
- Whether drawn matches pay (spec's open question): proposed **no**, both players
  re-queue at once.
- The q-multiplier's "> 30% voids" rule (spec left it open): proposed as written.
- A lawyer's read and a geo-block list before mainnet (Phase 4, from the HANDOFF).
