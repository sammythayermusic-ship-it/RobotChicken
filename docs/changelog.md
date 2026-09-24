# Changelog

## Phase 1: the local fighter

- **Phones** (on-screen buttons): a d-pad, PECK and a JUMP / SLAM / DIVE context button feeding the same input bits as the keyboard. Upright, a Game Boy style panel under the fight; sideways, see-through buttons in the corners with the camera keeping the fighters' feet above them. Turning the phone keeps the fight going. The timer pauses (plus PAUSE / SOUND pills upright); a compact HUD for phones held sideways; tighter framing upright; no scroll, zoom or long-press menu while fighting; sound despite the iPhone silent switch. Tested with real multi-finger touches (Chromium, Pixel 7) and on an emulated iPhone in WebKit.
- **CI**: e2e tests fit software GL's ~1 fps (fewer rendered frames, longer timeouts).

- **The full move set in the sim**: peck, shove, slam, dive kick, Rooster Rocket super, dash (with invulnerable frames), jump, block with chip, knockdown and get-up, Heat (latching at full), ring-outs, KOs, double-KO draws, sudden death, the 5-round cap. Hitboxes come from the Blender rig's helpers. Every move is covered by table-driven frame-data tests; fast-check proves integer-only state, purity, rewind-and-replay, mirror symmetry and termination.
- **CPU opponent** (easy / normal / hard), deterministic and outside `step()`.
- **Client**: fixed 60 Hz loop with interpolation, keyboard input (vs CPU and 2 players on one keyboard, key tester), the chicken posed from sim state, fight camera with dolly / pull-back / seeded trauma shake, GPU particles (sparks, screws, feathers, dust, flash, chrome dash trail), hit-stop freeze + flash, KO chromatic-aberration pulse.
- **Procedural junkyard arena**: concrete pit with a hazard lip at the ring edge, stacked crushed cars, oil-drum fires lighting the fighters, 240 red-eyed robot chickens in the bleachers reacting to hype, floodlights, skyline.
- **Procedural audio**: 30 sounds (layered metal hits, robot-chicken screams per damage tier, crowd that swells with hype, KO horn, bell, riser, UI), loudness-levelled; Sammy's sound pack drops in via a manifest.
- **HUD**: HP bars with damage trail, Heat meters with SUPER READY, timer, round pips, countdown / FIGHT / K.O. / RING OUT / TIME banners, pause menu (quality, shake, sound), match end with rematch.
- **Tiers** (cosmetic only): Rust, Chrome (dash trail), Gold (extra sparks), Diamond (iridescent); mirror matches tint P2.
- **Hero import**: `pnpm assets:import --blend <file>` exports with the scripted exporter, fixes or explains UI-authored mistakes, validates (v2: active-frame reach, textures, arena, first-load budget) and bakes hitboxes. A Blender export preset ships in `art/blender/presets/`.
- **Perf**: `/play?bench=1` (copyable percentiles for a real phone), `pnpm test:perf` (desktop + Pixel 7 proxy); budgets on draw calls, triangles and shader compiles.
- **Determinism across engines**: golden replays hash identically in Node (x64 + arm64), Chromium, Firefox and WebKit; CI runs all of them.
- **Review fixes** (50 confirmed findings):
  - Sim and balance: shove ring-outs are exact, dash taps and buffered moves read what was pressed, and cancels happen on hit only. Wake-up is invulnerable for 2 ticks and the dive kick is reactable. At full Heat, away+Space pecks.
  - CPU: rebuilt with ordered levels, and walk-and-peck no longer beats it.
  - Client: rematches no longer leak engines, the HUD resets between fights, the shake setting and reduced motion hold, the menus work from the keyboard, and P2 doesn't spin at the start.
  - Camera: both fighters and a full jump stay in frame at every aspect, including portrait.
  - Arena: the crowd doesn't strobe, low quality trims the arena, the lip is flush, and there is one env map with no leaks.
  - Audio: sound starts on autostart links.
  - Tools: textures convert correctly, imports are atomic, the arena anchors are validated, and the UI preset is complete.

## Phase 0: scaffold

- **Monorepo** (pnpm 11): `apps/{web,game,worker}`, `packages/{sim,shared,solana}`, `tools`, `supabase`, `art/blender`. Versions pinned in the workspace catalog.
- **`packages/sim`**: integer fixed-point match state, FNV-1a-64 state hash, compiled rules with `rulesHash`, SOCD input with dash taps and a press buffer, walking, pushbox, walls, the full round machine (countdown, timeout, sudden death, draws, 5-round cap), replays and golden fixtures. `moves.json` holds the whole Phase 1 move set's data.
- **Placeholder chicken**: built by a headless Blender 5.2 script from `chicken.contract.json` (16 bones, 1.6k tris, all 21 clips, hurt/hit helpers), exported with the scripted `export_chicken()`, byte-identical on rebuild. `assets:validate` checks it against the contract and budgets; `assets:bake` turns the helpers into integer hitbox tables for the sim (matches three.js to 0 mu over 700 samples).
- **Supabase**: 8 tables, RLS on everywhere with no anon access, explicit `service_role` grants, `leaderboard_v` (materialized, refreshed by pg_cron) and `pool_v` for the front page. 43 tests on PGlite in both legacy and strict grant modes.
- **Game server**: Colyseus 0.18 `makeServer()` factory, `/health`, origin allowlist (CORS + WebSocket upgrade), a fight room stepping the sim at 60 Hz, esbuild single-file bundle + production smoke test, Dockerfile, fly.toml.
- **Worker**: health-only stub, Dockerfile, fly.toml (no public service, one machine).
- **Web**: Next 16 landing page with two idle placeholder chickens in a live three.js showcase, self-hosted Draco/Basis decoders, report-only CSP (also tested enforcing), `/play` stub, dev-only `/dev/net` that joins a live fight room. Playwright smoke suite.
- **CI**: lint, typecheck, tests, asset validation, bake check, builds, game smoke; golden replay hashes compared across Linux x64 and macOS arm64; Docker images built and `/health` checked.
