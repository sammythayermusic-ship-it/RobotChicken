# Handoff: start here

This file is the entry point for picking up COCKFIGHT in a new session or project. Read it first,
then `CLAUDE.md`.

## Where things stand (2026-09-23)

| | |
|---|---|
| Phase 0: scaffold | Done. [PR #1](https://github.com/sammythayermusic-ship-it/cockfight/pull/1), branch `phase-0-scaffold`, CI green |
| Phase 1: the local fighter (+ phone controls) | Done. [PR #2](https://github.com/sammythayermusic-ship-it/cockfight/pull/2), branch `phase-1-fighter` (stacked on PR #1), CI green |
| Playtest | https://cockfight-playtest.netlify.app (static build on Sammy's Netlify account; keyboard and phones) |

- **Merging:** only Sammy merges. Merge PR #1 first, with a merge commit (not a squash), because PR #2 is stacked on it. Then PR #2.
- **New work:** Phase 2 branches off `phase-1-fighter`, or off `main` once both PRs are merged.

**Redeploy the playtest** (see the README's "Playtest build" section):

```bash
pnpm --filter @cockfight/web export
npx netlify-cli deploy --dir apps/web/out --prod --no-build --site cockfight-playtest
```

If the Netlify CLI asks which monorepo project to use, deploy from a copy of `apps/web/out` placed outside the repo.

## How to work here

- **`CLAUDE.md`:** the commands, the repo layout, and the determinism rules for `packages/sim`, which are lint-enforced.
- **`docs/decisions.md`:** every non-obvious choice. ★ marks the ones Sammy still has to confirm.
- **`docs/controls.md`:** keyboard and touch controls, plus frame data.
- **`docs/changelog.md`:** what each phase shipped. **`docs/plan.md`:** the Phase 0–1 build plan.
- **`docs/research/spec-extracted.txt`:** the spec itself (text of Sammy's PDF).
- **Checks:** `pnpm verify` must pass before every commit, and `pnpm test:e2e` before every PR.
- **Process:** one branch and one PR per phase, stopping for review. Commits end with the `Co-Authored-By` line in `CLAUDE.md`.

## Open decisions for Sammy (★ in `docs/decisions.md`)

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

**Phase 2: online.** Colyseus matchmaking (`apps/game`: rooms are stubs today), client prediction and reconciliation on the shared sim, the wallet gate, replays and the leaderboard. Open questions:
- the tick-ahead limit (the spec's "+3" is too tight at 80 ms round-trip);
- Fly WebSocket routing (`fly-replay`, or one app per region);
- snapshots must carry the full sim state;
- who writes `balance_checks`.

**Phase 3: money.** Fee claims, Jupiter swaps (the v3 API needs a key), SOL payouts from `apps/worker`, anti-abuse and `/admin`. Open questions:
- the launchpad (Meteora DBC or pump.fun);
- which GME mint;
- whether drawn matches pay;
- the q-multiplier's missing "void over 30%" rule;
- SPL transfers and rent if payouts switch to GME.

**Phase 4: launch.** Mainnet, a load test and the runbook. Also a lawyer's read and a geo-block list before real money moves.

## Accounts Sammy sets up (credentials never go in the repo or the chat)

| Service | For | Notes |
|---|---|---|
| Vercel | Production web | Root directory `apps/web`; `apps/web/vercel.json` is ready |
| Fly.io | Game server + payout worker | `apps/game/fly.toml`, `apps/worker/fly.toml` (iad + fra) |
| Supabase | Database | Migrations in `supabase/migrations` |
| Redis (TCP `rediss://`) | Colyseus presence across regions | `REDIS_URL` |
| Jupiter | Price and swap API v3 | `JUPITER_API_KEY` |
| Solana wallet | Payouts | Keep `PAYOUTS_ENABLED=false` until Phase 3 is reviewed |

All environment variables are listed in `.env.example`. Everything boots with none of them set.

## Still to check on real devices

- `/play?bench=1` on a mid-range Android phone and an M1 MacBook Air: paste the numbers into PR #2. The target is 60 fps.
- On phones: does the dash double-tap (within 200 ms) feel right with thumbs, and do the buttons clear the iPhone home bar and Safari's toolbar?
- "Two people on one keyboard call it fun": play it with a friend.
