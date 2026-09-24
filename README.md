# COCKFIGHT

A browser 1v1 2.5D fighting game where robotic chickens brawl in a junkyard pit. Entry
requires holding $30 of $COCK; every win pays instant SOL out of the coin's trading fees,
and the daily top 10 split a leaderboard pool. Nothing is wagered: the loser keeps every
token. **Hold to play, win to earn.**

The spec is Sammy's build plan (text in `docs/research/spec-extracted.txt`). The build
runs in phases, each one branch and one PR, stopping for review:

| Phase | Scope | Status |
|---|---|---|
| 0 · Scaffold | Monorepo, deterministic sim skeleton, Supabase migrations, Fly/Vercel configs, CI, placeholder chicken | PR #1 |
| 1 · The fighter | Full move set, rounds, Heat/super, ring-outs, arena, HUD, juice, sound, local 2P + CPU, Blender import pipeline | PR #2 |
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

## Play it

Open `/play`, pick **VS CPU** (easy / normal / hard) or **2 PLAYERS · 1 KEYBOARD**, press FIGHT.
Controls and frame data are in `docs/controls.md` (the Controls panel has a key tester for
keyboard ghosting). Esc or P pauses (quality, screen shake, sound), and so does clicking the timer.

**On a phone** (VS CPU): on-screen buttons appear by themselves. Hold it upright for a
controller panel under the fight, or sideways for see-through buttons in the corners; turning
it mid-fight is fine. D-pad = arrows (hold ▼ to block, double-tap to dash), PECK = Space, and
the context button reads JUMP, SLAM (with ▼ held) or DIVE (in the air). Tap the timer to
pause. `?touch=1` shows the buttons on a desktop too.

Useful links: `/play?mode=cpu&difficulty=hard` skips the picker; `/play?bench=1` runs a
fixed-seed CPU match and prints copyable frame-time numbers (open it on a phone over your LAN
with `WEB_PORT=3001 pnpm dev` and the machine's IP, or on a Vercel preview); `&fps=1` shows an
FPS meter; `&tier=gold` previews a tier.

## Playtest build (static)

Local play needs no server, so a static export can go on any static host for friends to try:

```bash
pnpm --filter @cockfight/web export        # builds apps/web/out (with Netlify _headers, noindex)
npx netlify-cli deploy --dir apps/web/out --prod --no-build --site cockfight-playtest
```

Live at https://cockfight-playtest.netlify.app (Sammy's Netlify account). This is a playtest
mirror only; production stays on Vercel per the spec.

## Commands

| Command | What it does |
|---|---|
| `pnpm verify` | lint + typecheck + unit tests + asset validation + hitbox bake check + builds |
| `pnpm test` | every unit test (vitest projects: sim, shared, solana, web, game, worker, tools) |
| `pnpm test:e2e` | Playwright against a production build (port 3130, `E2E_PORT` to change): the functional suite in Chromium, the touch controls on a Pixel 7 (`chromium-touch`, real multi-finger touches), golden replays in Chromium, Firefox and WebKit. An iPhone smoke test runs locally with `--project=webkit-touch`. CI runs `test:e2e:desktop` and `test:e2e:touch` as two parallel jobs |
| `pnpm test:perf` | local frame-timing check (desktop + Pixel 7 proxy), writes `docs/captures/phase-1/perf.json` |
| `pnpm assets:import --blend <file>` | exports a hero chicken from Blender, validates it and bakes its hitboxes (`docs/art-pipeline.md`) |
| `pnpm textures` | converts tier textures to KTX2 (needs KTX-Software 4.4) |
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
fly deploy . --config apps/game/fly.toml --dockerfile apps/game/Dockerfile --ha=false
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
