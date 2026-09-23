# COCKFIGHT

A browser 1v1 2.5D fighting game where robotic chickens brawl in a junkyard pit. Entry
requires holding $30 of $COCK; every win pays instant SOL out of the coin's trading fees,
and the daily top 10 split a leaderboard pool. Nothing is wagered: the loser keeps every
token. **Hold to play, win to earn.**

The spec is Sammy's build plan (text in `docs/research/spec-extracted.txt`). The build
runs in phases, each one branch and one PR, stopping for review:

| Phase | Scope | Status |
|---|---|---|
| 0 · Scaffold | Monorepo, deterministic sim skeleton, Supabase migrations, Fly/Vercel configs, CI, placeholder chicken | this PR |
| 1 · The fighter | Full move set, rounds, Heat/super, ring-outs, arena, HUD, juice, sound, local 2P + CPU, Blender import pipeline | next PR |
| 2 · Online | Colyseus matchmaking, prediction/reconciliation, wallet gate, replays, leaderboard | — |
| 3 · Money | Fee claims, payouts, anti-abuse, /admin | — |
| 4 · Launch | Mainnet, load test, runbook | — |

`docs/plan.md` is the build plan for Phases 0–1, `docs/decisions.md` records every
non-obvious choice (★ marks the ones for Sammy to confirm), `docs/changelog.md` tracks
progress.

## Local setup

Requirements: Node 22 and pnpm 11 (the pinned `packageManager` version downloads itself).
Blender 5.2 only if you rebuild art.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the web app on http://localhost:3000 and the game server on
ws://localhost:2567 (`/health`). If port 3000 is taken, move the web app (the game server
follows it for its allowed origin):

```bash
WEB_PORT=3001 pnpm dev
```

`/dev/net` (dev builds only) joins a live fight room and shows the tick climbing, proving
web ↔ game end to end. Nothing needs env vars locally; see `.env.example` for the full list.

## Commands

| Command | What it does |
|---|---|
| `pnpm verify` | lint + typecheck + unit tests + asset validation + hitbox bake check + builds |
| `pnpm test` | every unit test (vitest projects: sim, shared, solana, web, game, worker, tools) |
| `pnpm test:e2e` | Playwright against a production build (port 3130, `E2E_PORT` to change) |
| `pnpm replay:golden` | replays the golden input logs and prints their final state hashes |
| `pnpm replay:golden --bless` | re-records them after an intentional rules change (say why in the commit) |
| `pnpm assets:placeholder` | rebuilds the placeholder chicken with headless Blender, validates, re-bakes hitboxes |
| `pnpm assets:validate [glb]` | checks a chicken against the contract and budgets |
| `pnpm assets:bake [--check]` | bakes rig helpers into `packages/sim/data/hitboxes.json` |
| `pnpm assets:inspect <glb>` | prints what a glb contains |

## Layout

```
apps/web        Next.js 16 site + plain three.js game engine (src/game)
apps/game       Colyseus 0.18 authoritative game server (Fly.io)
apps/worker     fee claims + payouts (Phase 3; a health stub now)
packages/sim    deterministic fighter simulation shared by server and client
packages/shared constants, tiers, zod env schemas
packages/solana chain interfaces (Phase 2/3)
supabase        SQL migrations (tested on PGlite)
tools           asset validation / hitbox bake, Blender runner, DB test harness
art/blender     scripted Blender pipeline (placeholder chicken, export settings)
docs            plan, decisions, changelog, research, captures
```

### Determinism

`packages/sim` is integer-only fixed-point and lint-enforced (see `CLAUDE.md`). The same
code runs authoritatively on the server and for prediction in the browser, and every match
can be replayed from its input log. CI replays the golden logs on Linux x64 and macOS arm64
and fails if the final state hashes differ.

## Deploying

None of these have been run yet: there is no Fly or Vercel CLI or linked account on the
build machine, so every command below is **unverified**. CI builds both Docker images and
checks `/health`.

**Game server (Fly.io, iad; add fra in Phase 2):**

```bash
fly deploy . --config apps/game/fly.toml --dockerfile apps/game/Dockerfile
fly secrets set ALLOWED_ORIGINS=https://cockfight.fun --config apps/game/fly.toml
```

**Worker (Fly.io, exactly one machine):**

```bash
fly deploy . --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile --ha=false
```

Wallet keypairs are Fly secrets on the worker only, never in Vercel or the game server.

**Web (Vercel):** create a project with Root Directory `apps/web`, framework Next.js,
Node 22, and set `ENABLE_EXPERIMENTAL_COREPACK=1` (Vercel doesn't support pnpm 11 without
it). `apps/web/vercel.json` holds the filtered install and the ignore command.

**Database (Supabase):** see `supabase/README.md` (`supabase link`, `supabase db push`).

## Runbook

Phase 3 fills this in (stuck payout, hot wallet empty, region down, rollback). Until then
the worker holds no keys and `PAYOUTS_ENABLED` is ignored.
