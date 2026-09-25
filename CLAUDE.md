# COCKFIGHT — working notes

Browser 1v1 2.5D robot-chicken fighter. Hold $COCK to play, win to earn SOL. The spec is
`docs/research/spec-extracted.txt` (text of Sammy's PDF); the build plans are `docs/plan.md` (Phases 0–1), `docs/plan-phase2.md` and `docs/plan-phase3.md`;
every non-obvious choice is in `docs/decisions.md`. Phases stop for review; one branch + PR each.

## Run
- `pnpm install` (pnpm 11 via `packageManager`; Node 22).
- `pnpm dev` → web on http://localhost:3000, game server on ws://localhost:2567 (`/health`).
- `pnpm verify` = lint + typecheck + test + assets:validate + assets:bake --check + build.
- `pnpm replay:golden [--bless]` — golden replay hashes (CI diffs them across x64 Linux and arm64 macOS).
- `pnpm assets:placeholder` rebuilds the placeholder chicken with headless Blender, then validates and bakes hitboxes.
- `pnpm test:e2e` — Playwright against a production build on :3130 plus the game server bundle in open mode on :2667 (`E2E_PORT` / `E2E_GAME_PORT` to change; `PLAYWRIGHT_BASE_URL` targets an already-running server and skips the build). Projects: `chromium` (desktop), `chromium-touch` (Pixel 7, touches via CDP), `firefox` / `webkit` (golden replays); `webkit-touch` (iPhone smoke) is local only. A server already on :3130 is reused, so stop it after rebuilding or the tests run the old build.

## Layout
- `packages/sim` — THE game. Pure deterministic integer simulation shared by server (authoritative) and client (prediction). `step(prev, b1, b2, R)` is pure. Data in `data/{moves,hitboxes,chicken.contract}.json`.
- `packages/net` — online play: binary protocol, `ServerMatch` (authoritative, buffered inputs), `ClientPredictor` (confirmed state + rollback prediction, clock control, correction blending), results/ELO. `test/harness.ts` simulates a network; use it for any netcode change.
- `packages/shared` — constants, tiers, zod env schemas (everything boots with zero env vars).
- `packages/solana` — the wallet gate (`BalanceGate`: RPC balance, Jupiter / fixed price, cache), hand-built transactions (PDAs, ATAs, SPL, pump.fun; parity-tested against web3.js) and a JSON-RPC client.
- `packages/economy` — the pool maths and the `Treasury` engine every worker job runs through; `test/month.test.ts` is the synthetic month that proves the pool can't run dry. Run it for any money change.
- `apps/web` — Next 16 site + plain three.js engine in `src/game/` (no React there; React wrappers in `src/game/react/`).
- `apps/game` — Colyseus 0.18 server (`makeServer()` factory): `QueueRoom` (one per process, created in `listen()`), `FightRoom` (lifecycle, pause/forfeit, results), `POST /gate`, `GET /config`, `/api/matches/:id`, `/api/leaderboard`. `GATE_MODE` open (playtest) or required (wallet gate). `apps/worker` — the treasury on Solana + Supabase: fee claims every `CLAIM_EVERY_MIN` (10), the pool every minute, payouts every 5 s, the daily top 10 at 00:00 UTC; health / observer / live by env.
- `tools` — asset validate/bake, Blender runner, PGlite DB harness. `supabase/migrations` — SQL.
- `art/blender` — scripted Blender pipeline (`cf_common.py` owns the export settings).

## Determinism rules (packages/sim) — lint-enforced
- Integers only: positions in mu (1/1000 unit), HP ×100, Heat ×60, time in ticks. Divide only with `idiv`/`mulDiv` (truncate toward zero); raw `/` and fractional literals are lint errors. No `Math.*` beyond abs/min/max/trunc/imul/sign/clz32 (aliasing Math is banned too), no `**`, no clocks/`globalThis`/`crypto`/`Intl`/locale calls, no `for…in`/`Object.keys` (except `rules.ts`).
- Tests and the golden runner run with `setFixedChecks(true)`: division by zero and any non-integer state field throw.
- `SIM_VERSION` (rules.ts) is part of `rulesHash`: bump it when `step()` behaviour changes.
- Every state field is listed in `serialize.ts` (`MATCH_FIELDS` / `FIGHTER_FIELDS`); a test fails if one is missing. Append new fields at the end.
- Resolve both hit directions before applying either. Never iterate P1-first where order matters.
- Any change to rules data changes `rulesHash`: re-bless goldens in the same commit and say why.

## Conventions
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Update `docs/decisions.md` for any non-obvious choice and `docs/changelog.md` at each phase step.
- Versions live in the `catalog:` of `pnpm-workspace.yaml`. Never set `minimumReleaseAge`.
- Three.js: clone skinned models with `SkeletonUtils.clone`; drive the mixer from sim state (`action.time` + `mixer.update(0)`), never from wall-clock in gameplay.
- Tests that drive keyboard input step ticks inside the page (`?manual=1`), never by wall-clock timing.
- Touch input makes the keyboard's 5-bit mask (`game/match/input/touch.ts`); never add a separate sim path for it. The fight screen's layout is CSS only (`app/play/play.css`): keep one JSX tree, or rotating a phone remounts the canvas and restarts the fight.
- CI renders e2e in software (~1 fps): step ticks inside one `page.evaluate` and render/screenshot sparingly.
- Online: the server is the only truth; clients send buttons only. Never make the client trust its own prediction for results. Any change to `step()` changes `rulesHash`, which the queue checks, so web and game server must deploy together.
- Queue joins pass `rules: RULES.hash`; tests use `sdk.join("queue", …)` (the queue room exists from `listen()`; clients can't create one).
