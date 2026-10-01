# Handoff: start here

This file is the entry point for picking up COCKFIGHT in a new session or project. Read it first,
then `CLAUDE.md`.

## Where things stand (2026-10-01)

| | |
|---|---|
| Phase 0: scaffold | Done. [PR #1](https://github.com/sammythayermusic-ship-it/cockfight/pull/1), branch `phase-0-scaffold`, CI green |
| Phase 1: the local fighter (+ phone controls) | Done. [PR #2](https://github.com/sammythayermusic-ship-it/cockfight/pull/2), branch `phase-1-fighter` (stacked on PR #1), CI green |
| Phase 2: online | Done. [PR #3](https://github.com/sammythayermusic-ship-it/cockfight/pull/3), merged 2026-09-24 |
| Phase 3: money | Done, [PR #4](https://github.com/sammythayermusic-ship-it/cockfight/pull/4) merged 2026-09-25. Plan: `docs/plan-phase3.md`; what shipped: `docs/changelog.md`; choices: `docs/decisions.md` |
| Go-live (test coin) | **Live since 2026-09-25**, see below. Open: [PR #5](https://github.com/sammythayermusic-ship-it/cockfight/pull/5) (mainnet fly.toml env) and [PR #6](https://github.com/sammythayermusic-ship-it/cockfight/pull/6) (claim rebroadcast + quieter alerts, built on #5, already deployed) |
| Domain / X | https://cockfightsol.fun (live, Netlify, DNS on Cloudflare) · @CockFightSol |
| Launch videos | **Done** (cut 3 signed off): `Claude outputs/video/promo.mp4` + `explainer.mp4`; rig in `tools/video` on [PR #7](https://github.com/sammythayermusic-ship-it/cockfight/pull/7); plan `docs/plan-videos.md`. Re-shoot the payout card after the live payout test |
| Phase 4: launch prep | Built on branch `phase-4-launch` (PR on base `launch-videos`): curve price source, link card + Share on X, `/health` load stats, load test, launch scripts (`tools/launch`), **`docs/runbook-launch.md` (start there for launch)** |
| Playtest | https://cockfight-playtest.netlify.app (static build on Sammy's Netlify account; keyboard and phones; online needs a deployed game server, see below) |

- **Merging:** only Sammy merges (PRs #1–#3 were merged at his request on 2026-09-24).
- **Next:** fund the hot wallet and start the worker (runbook step 0); merge #5 → #6 → #7 → Phase 4; then follow `docs/runbook-launch.md` (payout test, funding day, launch day). Legal done 2026-10-01; no geo-block. Idea queued by Sammy: a spectator `/watch` page streamed to the pump.fun coin page (plan first).

**What's live (on the THROWAWAY test coin `HFypaAkLk4XwKJvLK5hTvL65dhY2F61davhjo1x8pump`)**
- Site https://cockfightsol.fun: Netlify site `cockfightsol` (also cockfightsol.netlify.app). Cloudflare DNS: `@` and `www` CNAME → `cockfightsol.netlify.app`, DNS only.
- Game server: Fly `cockfight-game`, performance-1x (dedicated CPU, since 2026-10-01), `MAX_LIVE_MATCHES=100`, `GATE_MODE=required`, `GATE_USD_MIN=1` (test value; **30 at launch**).
- Worker: Fly `cockfight-worker`, **scaled to zero since 2026-10-01 05:30 UTC** (start with `tools/launch/start-worker.sh` once the hot wallet has SOL; hot key set by Sammy): fee claims every 10 min (first one 2026-09-25 16:40 UTC split the vault 70/30), pool every minute, payouts every 5 s. Telegram alerts go to Sammy.
- Supabase: both migrations pushed.
- Wallets (public): launch `Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF` (key never on a server), hot `HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1`, seed `BGZx5Lti1gWY7yD55pMBePiCAUPN4sEJYrmGUuLDjWwX` (no key set yet).
- Secrets: Fly secrets on each app; local copies in `.env.local` (git-ignored; `/admin` uses `ADMIN_PASSWORD` from it). Sammy enters private keys through a hidden Terminal prompt piped to `fly secrets import`, never chat.
- Deploy: `fly deploy . --config apps/<game|worker>/fly.toml --dockerfile apps/<game|worker>/Dockerfile --ha=false --depot`. Web: `NEXT_PUBLIC_GAME_WS_URL=wss://cockfight-game.fly.dev` + the mint + keys from `.env.local`, export, deploy to site `cockfightsol`.

**Still to do before the real coin**
1. Live payout test: a second wallet with ≥$1 of the test coin, played from a different network (the queue never pairs the same IP /24 or browser; a phone on cellular works). Winner should get ~181 PUMP.
2. Funding day: seed amount, `GUARANTEED_WIN_BUDGET_USD`, `GUARANTEED_DAILY_POOL_USD`, `COLD_WALLET`, `SEED_WALLET_KEYPAIR`.
3. Launch day: switch `COCK_MINT` / `NEXT_PUBLIC_COCK_MINT` to the real mint (rebuild the web), `GATE_USD_MIN=30`, and "Share creator rewards" 70 hot / 30 launch on the real coin.
4. ~~Lawyer's read + geo-block list.~~ Done (Sammy, 2026-10-01): no geo-block.

**Found 2026-10-01:** the worker app is scaled to zero (since ~05:30 UTC) and the hot wallet holds 0.0009 SOL (moved out by hand, not spent by the game). Fund it, then `tools/launch/start-worker.sh` (runbook step 0).

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
  - funding day: the seed amount, `GUARANTEED_WIN_BUDGET_USD`, `GUARANTEED_DAILY_POOL_USD`;
  - a lawyer's read and the geo-block list before mainnet (spec);
  - *(Confirmed at the Phase 3 review: the caps ($500 / win, $5,000 / daily reward, $3,000 / hour, $20,000 / day, resume by hand), `QUEUE_MIN_PLAYERS` 2, draws pay nothing, "void over 30%" pays 0 but the match counts.)*
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
