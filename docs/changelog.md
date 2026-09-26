# Changelog

## Launch kit: videos (branch `launch-videos`)

- **`tools/video`**: a Playwright capture rig (`video:capture`) that renders choreographed fights one tick per frame at 3840×2160 on the Mac's GPU, with per-tick event and sound logs; site stills and live captures; alpha title cards; the game's 30 procedural sounds exported as WAVs (`video:capture sounds`); the online match shot on the local open-mode stack (`video:online`); and an ffmpeg edit builder (`video:build promo|explainer`) with punch-ins, slow motion, overlays, the game's sounds at their ticks, VO, ducked music, captions and −14 LUFS output.
- **Deliverables** in `Claude outputs/video/` (final, signed off 2026-09-26): `promo.mp4` (30.4 s, 1080p60, cut to Sammy's Suno spot) and `explainer.mp4` (1:40, 1080p30, burned captions + `.srt`, Suno bed ducked under the VO). Plan and beat sheets: `docs/plan-videos.md`.

## Phase 3: money

- **`packages/economy`**: the pool maths as pure functions (per-win formula with tier weights, quality multiplier, daily top-10 split, seed draw, USD caps, the send decision) and a `Treasury` engine running every worker job against `Ledger` / `Chain` interfaces. A synthetic-month test drives it through a launch spike, dead days, a gold whale, a bot burst, an eight-hour claim outage, a price crash and pump, and a crash between signing and sending, and asserts the plan's invariants on the ledger it leaves.
- **Database**: the PUMP ledger (`payouts` in raw units with `win:<id>` / `daily:<day>:<rank>` keys, `fee_claims` with the gross / player / project split, `seed`, `seed_draws`, `sweeps`, `daily_pools`, `pool_state`, `settings`); `record_match` books the win payout in the result's transaction under the per-wallet caps and the flag; `treasury_window`, `daily_ranking`, `book_daily`, `book_seed_draw`, `seed_topup`, `claim_username`; public views `pool_v`, `payouts_v`, `daily_rewards_v`, earnings in `leaderboard_v`.
- **Worker**: creator-fee distribution every 10 minutes (`CLAIM_EVERY_MIN`) from pump.fun's sharing config into the hot wallet, the pool recomputed every minute, payouts every 5 s (allowance, caps, wallet cover; signed before sent; expiry detection and retries), the daily top 10 and the seed draw at midnight UTC, sweeps to the cold wallet, Telegram alerts, reconcile at boot; health / observer / live modes.
- **`packages/solana`**: legacy transactions built and signed by hand (PDAs, ATAs, SPL transfers, compute budget, memo, the pump.fun instructions, account decoders) with a byte-for-byte parity test against web3.js, and a JSON-RPC client.
- **Game server**: ranked pairing by tier (own tier first, anyone after 60 s, paid at the lower tier), no shared IP /24 or fingerprint, the rematch cooldown, `QUEUE_MIN_PLAYERS`; the paid tier, quality and identity hashes go to `record_match`, and the room follows the payout to its transaction; input-timing bot check (held payouts); usernames by signed message; bans at the gate; `/admin`.
- **Web**: the live pool on the front page, the payout (or why there is none) on the result screen with the Solscan link, `/p/<address>` profiles with the username claim, `/how-it-works`, the leaderboard's pool and yesterday's paid top 10.

## Phase 2: online

- **Online matches**: queue from `/play` → ONLINE, get paired, fight a real player. The server runs the authoritative sim at 60 Hz; each browser predicts both fighters and rolls back when the server's inputs arrive (2-tick input delay, clock kept in step by input margin, corrections blended so nothing teleports). Reconnects resume from a full sync; a player who stays gone past the 10 s grace forfeits (20 s of pauses per player per match); leaving forfeits at once; both gone calls the match off.
- **Open playtest mode** (`GATE_MODE=open`): queue with a name, no wallet, nothing written to the database; playtest results and ratings are kept in memory.
- **Wallet gate** (`GATE_MODE=required`, on the game server): paste a wallet, pass Turnstile, the server sums its $COCK over RPC and prices it (Jupiter v3, or a fixed price on devnet), then issues a 5-minute queue token. Under $30 shows how far off you are with a buy link. Tier from the USD held. Balances are re-checked right before each match.
- **Matchmaking**: one queue, pairing by RTT (120 ms → 200 ms after 20 s → anyone after 60 s), one ticket per player, clients must run the server's sim rules.
- **Results**: `record_match()` stores the match (input log, result hash, net quality) and both ELO updates in one transaction; `record_gate()` audits every gate check. ELO K = 32.
- **Replay page** `/m/<id>`: plays any match back from its input log and marks it ✓ verified when a headless re-run reaches the stored final state and result hash.
- **Leaderboard** `/leaderboard`: today (UTC), 7 days, all time; ELO, wins, win rate.
- **Landing page**: the wallet box opens the online lobby; leaderboard link.
- **`packages/net`**: protocol, `ServerMatch`, `ClientPredictor`, results / ELO, and a simulated-network harness (whole matches between CPU bots at 40–300 ms RTT, jitter, stalls and clock drift).
- **Tests**: net harness (0 desyncs, 0 snaps at 80 ms, input quality > 0.97 up to 300 ms), game server end to end over real sockets (open and ranked with faked chain / Turnstile / Supabase), SQL functions on PGlite, and a Playwright spec where two browsers meet, one vanishes and forfeits after the grace, and the replay reproduces the match's final hash.
- **Review fixes**: an adversarial review (3 reviewers: netcode, security, web client) found 30+ issues; all high and medium ones were fixed before the PR (the notable ones are in `docs/decisions.md`: forfeits after a deciding KO, both players dropping, pause budget, stale inputs, lost hit effects after rollbacks, Turnstile in production, tokenless queue seats, body size limit, lobby cancel races, lost connections).

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
