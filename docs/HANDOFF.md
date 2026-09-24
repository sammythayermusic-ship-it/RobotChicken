# Handoff: start here

This file is the entry point for picking up COCKFIGHT in a new session or project. Read it first,
then `CLAUDE.md`.

## Where things stand (2026-09-24)

| | |
|---|---|
| Phase 0: scaffold | Done. [PR #1](https://github.com/sammythayermusic-ship-it/cockfight/pull/1), branch `phase-0-scaffold`, CI green |
| Phase 1: the local fighter (+ phone controls) | Done. [PR #2](https://github.com/sammythayermusic-ship-it/cockfight/pull/2), branch `phase-1-fighter` (stacked on PR #1), CI green |
| Phase 2: online | Built, waiting for review. Branch `phase-2-online` (stacked on PR #2), PR #3. Plan: `docs/plan-phase2.md` |
| Playtest | https://cockfight-playtest.netlify.app (static build on Sammy's Netlify account; keyboard and phones; online needs a deployed game server, see below) |

- **Merging:** only Sammy merges. Merge PR #1 first with a merge commit (not a squash), then PR #2 the same way, then PR #3: each is stacked on the one before.
- **New work:** Phase 3 branches off `phase-2-online`, or off `main` once the PRs are merged.

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
- **`docs/changelog.md`:** what each phase shipped. **`docs/plan.md`:** the Phase 0–1 build plan. **`docs/plan-phase2.md`:** Phase 2.
- **`docs/research/spec-extracted.txt`:** the spec itself (text of Sammy's PDF).
- **Checks:** `pnpm verify` must pass before every commit, and `pnpm test:e2e` before every PR.
- **Netcode changes:** run them through `packages/net/test/harness.ts` (simulated network with RTT, jitter, stalls, drift).
- **Process:** one branch and one PR per phase, stopping for review. Commits end with the `Co-Authored-By` line in `CLAUDE.md`.

## Open decisions for Sammy (★ in `docs/decisions.md`)

- [ ] **Phase 2, online:**
  - both fighters predicted and rolled back (instead of the spec's opponent shown 100 ms late);
  - corrections up to 3 units blended instead of snapping above 0.5 (no teleports on missed dashes);
  - the wallet gate running on the game server rather than a Vercel API route;
  - 10 s reconnect grace, with 20 s of pauses per player per match;
  - pairing: 120 ms, 200 ms after 20 s, anyone after 60 s;
  - the match-start balance re-check lets a match go ahead when the chain can't be read;
  - a pasted address moves that address's ELO even if the paster doesn't own it (until usernames / signing in Phase 3).
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

**Phase 3: money.** Fee claims, Jupiter swaps (the v3 API needs a key), SOL payouts from `apps/worker`, anti-abuse and `/admin`, share cards (and the replay page's OG image), usernames by message signing and player profiles. Open questions:
- the launchpad (Meteora DBC or pump.fun), which also decides the gate's bonding-curve price source (the gate takes the lower of that and Jupiter);
- which GME mint;
- whether drawn matches pay;
- the q-multiplier's missing "void over 30%" rule;
- SPL transfers and rent if payouts switch to GME;
- anti-abuse pairing rules plug into `QueueRoom.canPair()` (≥ 4 in queue, IP / fingerprint, rematch cooldown); far-ahead and late inputs are already counted per player.

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
| Solana wallet | Payouts | Phase 3 | Keep `PAYOUTS_ENABLED=false` until Phase 3 is reviewed |

All environment variables are listed in `.env.example`. Everything boots with none of them set.

## Still to check on real devices

- **Online (spec acceptance):** two players in different cities finish a match with no visible warping at ~80 ms. The simulated network says yes (0 snaps at 80 ms, fine up to 300 ms); a real cross-city match on the deployed playtest is the real test.
- `/play?bench=1` on a mid-range Android phone and an M1 MacBook Air: paste the numbers into PR #2. The target is 60 fps.
- On phones: does the dash double-tap (within 200 ms) feel right with thumbs, and do the buttons clear the iPhone home bar and Safari's toolbar?
- "Two people on one keyboard call it fun": play it with a friend.
