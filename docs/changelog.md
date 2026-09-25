# Changelog

## Phase 0: scaffold

- **Monorepo** (pnpm 11): `apps/{web,game,worker}`, `packages/{sim,shared,solana}`, `tools`, `supabase`, `art/blender`. Versions pinned in the workspace catalog.
- **`packages/sim`**: integer fixed-point match state, FNV-1a-64 state hash, compiled rules with `rulesHash`, SOCD input with dash taps and a press buffer, walking, pushbox, walls, the full round machine (countdown, timeout, sudden death, draws, 5-round cap), replays and golden fixtures. `moves.json` holds the whole Phase 1 move set's data.
- **Placeholder chicken**: built by a headless Blender 5.2 script from `chicken.contract.json` (16 bones, 1.6k tris, all 21 clips, hurt/hit helpers), exported with the scripted `export_chicken()`, byte-identical on rebuild. `assets:validate` checks it against the contract and budgets; `assets:bake` turns the helpers into integer hitbox tables for the sim (matches three.js to 0 mu over 700 samples).
- **Supabase**: 8 tables, RLS on everywhere with no anon access, explicit `service_role` grants, `leaderboard_v` (materialized, refreshed by pg_cron) and `pool_v` for the front page. 43 tests on PGlite in both legacy and strict grant modes.
- **Game server**: Colyseus 0.18 `makeServer()` factory, `/health`, origin allowlist (CORS + WebSocket upgrade), a fight room stepping the sim at 60 Hz, esbuild single-file bundle + production smoke test, Dockerfile, fly.toml.
- **Worker**: health-only stub, Dockerfile, fly.toml (no public service, one machine).
- **Web**: Next 16 landing page with two idle placeholder chickens in a live three.js showcase, self-hosted Draco/Basis decoders, report-only CSP (also tested enforcing), `/play` stub, dev-only `/dev/net` that joins a live fight room. Playwright smoke suite.
- **CI**: lint, typecheck, tests, asset validation, bake check, builds, game smoke; golden replay hashes compared across Linux x64 and macOS arm64; Docker images built and `/health` checked.
