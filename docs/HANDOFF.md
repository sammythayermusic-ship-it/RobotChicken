# Handoff: start here

This file is the entry point for picking up COCKFIGHT in a new session or project. Read it first,
then `CLAUDE.md`.

## Where things stand (2026-09-25)

| | |
|---|---|
| Phase 0: scaffold | Done. [PR #1](https://github.com/sammythayermusic-ship-it/cockfight/pull/1), branch `phase-0-scaffold`, CI green |
| Phase 1: the local fighter (+ phone controls) | Done. [PR #2](https://github.com/sammythayermusic-ship-it/cockfight/pull/2), branch `phase-1-fighter` (stacked on PR #1), CI green |
| Phase 2: online | Done. [PR #3](https://github.com/sammythayermusic-ship-it/cockfight/pull/3), merged 2026-09-24 |
| Phase 3: money | Built, waiting for review. Branch `phase-3-money` (off `main`), [PR #4](https://github.com/sammythayermusic-ship-it/cockfight/pull/4). Plan: `docs/plan-phase3.md`; what shipped: `docs/changelog.md`; choices: `docs/decisions.md` (★ = Sammy's) |
| Domain / X | cockfightsol.fun (Cloudflare) · @CockFightSol |
| Playtest | https://cockfight-playtest.netlify.app (static build on Sammy's Netlify account; keyboard and phones; online needs a deployed game server, see below) |

- **Merging:** only Sammy merges (PRs #1–#3 were merged at his request on 2026-09-24).
- **Next:** review PR #4, then the go-live steps below; Phase 4 (launch) after that.

**Phase 3 go-live, in order** (nothing moves real money until step 5):
1. `supabase db push` (the Phase 3 migration) with the Supabase CLI logged in to the project.
2. Deploy the game server with the new env (`.env.example`, "game"): `QUEUE_JWT_SECRET`, `ADMIN_PASSWORD` (Fly secrets), `QUEUE_MIN_PLAYERS`, and `GATE_MODE=required` with the real `NEXT_PUBLIC_COCK_MINT` once the coin exists.
3. Deploy the worker in **observer** mode: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HELIUS_API_KEY`, `PAYOUT_MINT` (PUMP), `COCK_MINT`, `PAYOUTS_ENABLED=false`. `/health` shows the pool; the site shows it too.
4. Test the claim on the throwaway coin: set `COCK_MINT` to it, `HOT_WALLET_KEYPAIR` (Fly secret, entered by Sammy), `PAYOUTS_ENABLED=true`; the hourly claim distributes the ~680 PUMP waiting in its vault and `fee_claims` gets its first row. Play a ranked match on it: the payout lands in seconds.
5. Funding day: Sammy funds the seed wallet and sets `SEED_WALLET_KEYPAIR`, `GUARANTEED_WIN_BUDGET_USD`, `GUARANTEED_DAILY_POOL_USD` (or the knobs in `/admin`), `COLD_WALLET`, and switches `COCK_MINT` to the real coin after launch + "Share creator rewards" (70 hot / 30 launch).

**Redeploy the playtest** (see the README's "Playtest build" section):

```bash
pnpm --filter @cockfight/web export
npx netlify-cli deploy --dir apps/web/out --prod --no-build --site cockfight-playtest
```

If the Netlify CLI asks which monorepo project to use, deploy from a copy of `apps/web/out` placed outside the repo.

**Online playtest** (friends playing each other before $COCK exists):
1. Deploy the game server to Fly in open mode: `fly secrets set GATE_MODE=open ALLOWED_ORIGINS=https://cockfight-playtest.netlify.app`, then the `fly deploy` in the README.
2. Rebuild the playtest pointing at it: `NEXT_PUBLIC_GAME_WS_URL=wss://cockfight-game.fly.dev pnpm --filter @cockfight/web export`, then deploy as above.
3. Everyone opens `/play` → ONLINE, types a name, and gets matched.

## How to work here

- **`CLAUDE.md`:** the commands, the repo layout, and the determinism rules for `packages/sim`, which are lint-enforced.
- **`docs/decisions.md`:** every non-obvious choice. ★ marks the ones Sammy still has to confirm.
- **`docs/controls.md`:** keyboard and touch controls, plus frame data.
- **`docs/changelog.md`:** what each phase shipped. **`docs/plan.md`:** the Phase 0–1 build plan. **`docs/plan-phase2.md`:** Phase 2. **`docs/plan-phase3.md`:** Phase 3 (the economy, the invariants, the data).
- **Money changes:** run `packages/economy`'s month test (`pnpm --filter @cockfight/economy test`); it is the proof that the pool can't run dry.
- **`docs/research/spec-extracted.txt`:** the spec itself (text of Sammy's PDF).
- **Checks:** `pnpm verify` must pass before every commit, and `pnpm test:e2e` before every PR.
- **Netcode changes:** run them through `packages/net/test/harness.ts` (simulated network with RTT, jitter, stalls, drift).
- **Process:** one branch and one PR per phase, stopping for review. Commits end with the `Co-Authored-By` line in `CLAUDE.md`.

## Open decisions for Sammy (★ in `docs/decisions.md`)

- [ ] **Phase 3, money:**
  - `MAX_PAYOUT_USD` 500 (must cover a Gold win), `MAX_DAILY_REWARD_USD` 5,000 with daily rewards exempt from the hourly cap, and whether the $20,000 daily cap is right for launch day;
  - `QUEUE_MIN_PLAYERS` 2 rather than the spec's 4;
  - drawn matches pay nothing; "void over 30%" pays 0 rather than voiding the match;
  - funding day: the seed amount, `GUARANTEED_WIN_BUDGET_USD`, `GUARANTEED_DAILY_POOL_USD`;
  - a lawyer's read and the geo-block list before mainnet (spec).
- [ ] **Phase 2, online:**
  - both fighters predicted and rolled back (instead of the spec's opponent shown 100 ms late);
  - corrections up to 3 units blended instead of snapping above 0.5 (no teleports on missed dashes);
  - the wallet gate running on the game server rather than a Vercel API route;
  - *(Confirmed at the Phase 2 review: the 10 s / 20 s disconnect rules, the pairing steps, letting a match go ahead when the chain can't be read, and pasted-address ELO until Phase 3's signing.)*
- [ ] **Gameplay:**
  - super input (Space with no direction at full Heat; away+Space stays a peck);
  - the dive kick (unblockable but reactable, or blockable);
  - Heat latching when full;
  - ring-out only from a shove, slam or super hit;
  - ties (sudden death, draws, the 5-round cap);
  - slam launch range [160, 180].
- [ ] **Controls:**
  - the keyboard layouts;
  - portrait playable with a controller panel (instead of the spec's "rotate your phone" card);
  - the JUMP / SLAM / DIVE context button;
  - sound playing through the iPhone silent switch.
- [ ] **Art pipeline:** the rewritten Blender export checklist, and Draco texture-coordinate quantization of 12 bits (the spec says 8).
- [ ] **Assets:** the hero chicken `.blend`, the sound pack, and `arena.glb`, if any. Each drops in without code changes (see `docs/art-pipeline.md`).

## Launch roadmap (from the spec, plus open questions)

**Phase 3: money.** Built (PR #4). Left for the launch kit: share cards and the replay page's OG image; the gate's second price source (pump.fun's curve quote; the gate takes the lower); the hype and explainer videos (no ElevenLabs; the `/how-it-works` page is the explainer's script); the X account and domain going live.

**Phase 4: launch.** Mainnet, a load test (200 concurrent matches; one machine today, a second one needs Redis and per-machine routing) and the runbook. Also a lawyer's read and a geo-block list before real money moves.

## Accounts Sammy sets up (credentials never go in the repo or the chat)

| Service | For | Needed from | Notes |
|---|---|---|---|
| Fly.io | Game server (queue, matches, wallet gate) + payout worker | Phase 2 (online playtest) | `apps/game/fly.toml` (iad, one machine), `apps/worker/fly.toml` |
| Supabase | Ranked results, ELO, leaderboard, replays | Phase 2 (ranked) | `supabase db push`; the game server gets `SUPABASE_URL` + the secret key, the web app the URL + publishable key |
| Helius | Wallet balance reads for the gate | Phase 2 (ranked) | `HELIUS_API_KEY` on the game server |
| Cloudflare Turnstile | Bot check before the queue | Phase 2 (ranked) | Site key on the web app, secret on the game server (the gate stays shut in production without it) |
| Vercel | Production web | Launch (Netlify serves playtests) | Root directory `apps/web`; `apps/web/vercel.json` is ready |
| Jupiter | Price (gate) and swap API v3 | Mainnet | `JUPITER_API_KEY` |
| Redis (TCP `rediss://`) | Colyseus across machines / regions | When one machine isn't enough | `REDIS_URL` |
| Solana wallets | Payouts | Phase 3 | Launch / hot / seed / cold addresses are in `.env.example`; the hot and seed **secret keys** are Fly secrets on the worker only. `PAYOUTS_ENABLED=false` keeps the worker in observer mode |
| Telegram bot | Worker alerts (pauses, low SOL, claim failures) | Phase 3 | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` on the worker |

All environment variables are listed in `.env.example`. Everything boots with none of them set.

## Still to check on real devices

- **Online (spec acceptance):** two players in different cities finish a match with no visible warping at ~80 ms. The simulated network says yes (0 snaps at 80 ms, fine up to 300 ms); a real cross-city match on the deployed playtest is the real test.
- `/play?bench=1` on a mid-range Android phone and an M1 MacBook Air: paste the numbers into PR #2. The target is 60 fps.
- On phones: does the dash double-tap (within 200 ms) feel right with thumbs, and do the buttons clear the iPhone home bar and Safari's toolbar?
- "Two people on one keyboard call it fun": play it with a friend.
