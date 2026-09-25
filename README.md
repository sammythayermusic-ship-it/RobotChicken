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
| 2 · Online | Colyseus matchmaking, prediction/reconciliation, wallet gate, replays, leaderboard | PR #3 |
| 3 · Money | Fee claims, payouts, anti-abuse, /admin | — |
| 4 · Launch | Mainnet, load test, runbook | — |

`docs/HANDOFF.md` is the place to start, `docs/plan.md` is the build plan for Phases 0–1 (`docs/plan-phase2.md` for Phase 2), `docs/decisions.md` records every
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

Online play works locally too: the dev game server runs in open (playtest) mode, so open
`/play` in two browser windows, pick **ONLINE** in both, type two names and you'll be
matched against yourself.

## Play it

Open `/play`, pick **VS CPU** (easy / normal / hard) or **2 PLAYERS · 1 KEYBOARD**, press FIGHT.
Controls and frame data are in `docs/controls.md` (the Controls panel has a key tester for
keyboard ghosting). Esc or P pauses (quality, screen shake, sound), and so does clicking the timer.

**On a phone** (VS CPU): on-screen buttons appear by themselves. Hold it upright for a
controller panel under the fight, or sideways for see-through buttons in the corners; turning
it mid-fight is fine. D-pad = arrows (hold ▼ to block, double-tap to dash), PECK = Space, and
the context button reads JUMP, SLAM (with ▼ held) or DIVE (in the air). Tap the timer to
pause. `?touch=1` shows the buttons on a desktop too.

**Online:** pick **ONLINE**. On a playtest server (`GATE_MODE=open`) you type a name; on the
real site you paste the wallet holding your $COCK (≥ $30, checked on the game server, never
charged), pass the bot check, and queue. Both fighters are predicted and corrected as the
server's inputs arrive; a player who drops pauses the match and has 10 s to come back before
forfeiting. The result card links to the match's replay (`/m/<match id>`, re-simulated from its
input log and marked ✓ verified when it reproduces the server's final state) and
`/leaderboard` has today / 7 days / all time.

Useful links: `/play?mode=cpu&difficulty=hard` skips the picker; `/play?mode=online` opens the online lobby; `/play?bench=1` runs a
fixed-seed CPU match and prints copyable frame-time numbers (open it on a phone over your LAN
with `WEB_PORT=3001 pnpm dev` and the machine's IP, or on a Vercel preview); `&fps=1` shows an
FPS meter; `&tier=gold` previews a tier.

## Playtest build (static)

Local play needs no server, so a static export can go on any static host for friends to try:

```bash
pnpm --filter @cockfight/web export        # builds apps/web/out (with Netlify _headers + _redirects, noindex)
npx netlify-cli deploy --dir apps/web/out --prod --no-build --site cockfight-playtest
```

Live at https://cockfight-playtest.netlify.app (Sammy's Netlify account). This is a playtest
mirror only; production stays on Vercel per the spec.

**Online playtest:** the static site talks to a game server. Deploy one on Fly in open mode
(no wallet, no database; see Deploying), then build the export pointing at it:

```bash
NEXT_PUBLIC_GAME_WS_URL=wss://cockfight-game.fly.dev pnpm --filter @cockfight/web export
```

and add the Netlify origin to the game server's `ALLOWED_ORIGINS`.

## Commands

| Command | What it does |
|---|---|
| `pnpm verify` | lint + typecheck + unit tests + asset validation + hitbox bake check + builds |
| `pnpm test` | every unit test (vitest projects: sim, net, shared, solana, web, game, worker, tools). `net` includes a simulated-network harness: whole matches between CPU bots at 40–300 ms RTT with jitter and stalls, checking convergence, desyncs and correction sizes |
| `pnpm test:e2e` | Playwright against a production build (port 3130, `E2E_PORT` to change) and the production game server bundle in open mode (port 2667, `E2E_GAME_PORT`): the functional suite in Chromium (including two browsers playing online, a forfeit after the 10 s grace, and the replay reproducing the match), the touch controls on a Pixel 7 (`chromium-touch`, real multi-finger touches), golden replays in Chromium, Firefox and WebKit. An iPhone smoke test runs locally with `--project=webkit-touch`. CI runs `test:e2e:desktop` and `test:e2e:touch` as two parallel jobs |
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
packages/net    online protocol, the server's authoritative match, the client's prediction/rollback, results + ELO
packages/shared constants, tiers, zod env schemas
packages/solana the wallet gate (balance + price) and chain interfaces (Phase 3)
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

**Game server (Fly.io, iad; one machine):**

```bash
fly deploy . --config apps/game/fly.toml --dockerfile apps/game/Dockerfile --ha=false
fly secrets set ALLOWED_ORIGINS=https://cockfight.fun --config apps/game/fly.toml
```

It runs the queue, the matches and the wallet gate (`POST /gate`). Two setups:

- **Open playtest** (before $COCK exists): `fly secrets set GATE_MODE=open` (plus
  `ALLOWED_ORIGINS` with the playtest site's origin). Anyone queues with a name; nothing
  touches the database.
- **Ranked:** leave `GATE_MODE` unset (production defaults to `required`) and set
  `NEXT_PUBLIC_COCK_MINT`, `HELIUS_API_KEY`, `TURNSTILE_SECRET_KEY`, `QUEUE_JWT_SECRET`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (and `JUPITER_API_KEY` on mainnet). On
  devnet with a test token, `GATE_FIXED_PRICE_USD` prices it. Until the mint and RPC are
  set, `/gate` answers 503. The server logs a warning at boot for anything missing.

The web app's `NEXT_PUBLIC_GAME_WS_URL` points at it (`wss://<app>.fly.dev`). More regions
or machines need Redis and per-machine routing first (`docs/decisions.md`).

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
