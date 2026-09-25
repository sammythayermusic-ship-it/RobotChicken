**COCKFIGHT spec: contradictions, ambiguities, and the defaults Code should adopt (checked 2026-09-23)**

**Versions checked today (npm, web, and a headless Blender probe)**
- **Web stack:** the spec's "Next.js 15" is out of date. Current versions are next 16.3.6 (soltendogs uses 16.3.4), react/react-dom 19.3.0, three 0.186.0, @react-three/fiber 9.8.0, zustand 5.0.15, tailwindcss 4.3.3, zod 4.6.5 and @gltf-transform/* 4.5.0.
- **vitest:** 5.0.1 is a new major (Node ^22.12 is fine). If its config breaks, fall back to 4.1.x.
- **Colyseus:** the spec's "0.16" is two majors behind.
  - Current packages: colyseus 0.18.8, @colyseus/core 0.18.16, @colyseus/schema 5.0.34, @colyseus/sdk 0.18.4, @colyseus/redis-driver 0.18.3, @colyseus/redis-presence 0.18.5, @colyseus/testing 0.18.6.
  - colyseus.js stopped at 0.16.22. colyseus 0.18 needs Node ≥22.
  - 0.18 has built-in `defineInput()`, `setFixedTimestep()`, client `Predict.get(room)` / `predict.reconciler()`, and schema 5's decorator-free `schema({x: t.number()})`. A Schema can hold at most 63 fields.
- **pnpm 11:**
  - `onlyBuiltDependencies` was removed. Use `allowBuilds: { esbuild: true, sharp: true }` in `pnpm-workspace.yaml`.
  - `minimumReleaseAge` now defaults to 1 day. next 16.3.6 and colyseus 0.18.8 are under 24 h old and won't resolve, so pin 16.3.5 and 0.18.7, or set the option explicitly.
  - Pin `"packageManager": "pnpm@11.0.9"`. turbo isn't needed; `pnpm -r --parallel` is enough.
- **Jupiter:**
  - Price v2 was deprecated on 2025-08-01, and `lite-api.jup.ag` on 2026-01-31.
  - Use `GET https://api.jup.ag/price/v3?ids=<≤50 mints>` with an `x-api-key` header. It returns `{[mint]:{usdPrice, liquidity, decimals, priceChange24h, createdAt, blockId}}`.
  - Tokens without a reliable price are left out of the response, not returned as null.
  - Swap is `https://api.jup.ag/swap/v1/quote` and `/swap/v1/swap`, with the same key.
- **Meteora:** @meteora-ag/dynamic-bonding-curve-sdk 1.5.12 and @meteora-ag/cp-amm-sdk 1.4.10 both depend on @solana/web3.js v1 (1.99.0) and anchor 0.31. The worker should use web3.js v1, not @solana/kit 8.3.
- **Blender 5.2.1 glTF exporter (probed headless):**
  - `export_animation_mode` defaults to `'ACTIONS'` (also `NLA_TRACKS`, `SCENE`, …).
  - `export_merge_animation` defaults to `'ACTION'`.
  - `export_extras` defaults to False.
  - `export_draco_texcoord_quantization` defaults to 12.
  - `export_image_format` offers AUTO, JPEG, WEBP or NONE. There is no KTX2 option.

---

## A. Blocks Phase 0/1. Code adopts these now and records them in README "Decisions"

1. **Super input conflict.** "Space with full Heat" takes over peck, dive and slam, and there is no separate button. The mobile context button has an unused slot: grounded and not holding ↓.
   - **Default:** add bit 5 `S` (special) to the input bitmask (uint8 has room).
   - The mobile context button becomes SLAM (holding ↓), DIVE (in the air), or SUPER (grounded, neutral, Heat full). Neutral Space always pecks.
   - Keep the literal reading as a moves.json flag, `superOnSpaceWhenFull`.
   - **Sammy:** yes, at the Phase 1 review (it's a feel question).
2. **Heat can never stay full.** With 1/s decay, 100 turns into 99.98 on the next tick.
   - **Default:** Heat stops decaying at 100 until the super is used or the round ends.
   - Store Heat in sixtieths (0..6000): +480 on hit, +180 on block, −1 per tick. That is exact integer decay.
   - "+3 per hit blocked" doesn't say who gains it. Default: the attacker gains +8 on hit and +3 when blocked. A super hit grants no Heat.
   - **Sammy:** no; it's tunable in moves.json.
3. **Input priority is undefined.** The spec doesn't say how ↓ block interacts with ↓+Space, →+Space with walking, or air inputs.
   - **Default,** on the tick Space is pressed: airborne → `dive_kick`; S with full Heat → `super`; ↓ → `slam`; toward → `shove`; otherwise → `peck`.
   - Holding → walks, and pressing Space while holding → is a shove, so there is no walking peck.
   - Attacks and jumps trigger on the press (rising edge), not on hold. A press during recovery or hit-stop is buffered for 5 ticks.
   - Jump fires on the ↑ press. Its horizontal velocity comes from the L/R held at takeoff.
   - Opposite directions held together (SOCD): L+R = neutral, U+D = D.
4. **Dash double-tap has to be detected in the sim, not with DOM timers.**
   - 200 ms = 12 ticks. Detect press → release → press of the same direction within 12 ticks, using input history stored in the state (`lastDirPressTick`, `prevButtons`).
   - Holding → and pressing again only counts after a release.
   - ←← relative to facing is a backdash: 12 ticks, invulnerable on ticks 3–6 (1-indexed, inclusive).
   - Distances aren't specified. Default: 2.4 units forward, 1.8 back.
5. **What block stops.** "Blocks all grounded attacks" would make the dive kick an unblockable 6-frame attack from the air.
   - **Default:** block stops everything except slam (unblockable low) and super.
   - Super: unblockable, but avoidable with dash invulnerability or by being airborne on its active tick. Flags: `blockable`, `hitsAirborne`.
   - Chip = floor(10% of the move's damage), minimum 1. Chip damage can't KO (flag).
   - **Sammy:** yes, at the Phase 1 review.
6. **Missing tuning data.**
   - Dive, shove and super only list startup frames.
   - Damage is only given for the super ("30%", which I read as a flat 30 HP).
   - Hitstun, blockstun, knockback, walk speed, jump height and knockdown rules are all missing.
   - **Default:** Code picks starting values in moves.json, validated with zod:
   ```json
   "peck":{"startup":4,"active":2,"recovery":8,"dmg":5,"hitstun":14,"blockstun":8,"push":300,"hitbox":"hit_beak","hitstop":3},
   "dive_kick":{"startup":6,"active":"untilLand","landRecovery":10,"dmg":9,"hitbox":"hit_foot"},
   "shove":{"startup":8,"active":3,"recovery":16,"dmg":3,"push":2000,"hitbox":"hit_wing"},
   "slam":{"startup":14,"active":4,"recovery":22,"dmg":14,"unblockable":true,"knockback":3000,"knockdown":true,"hitstop":8},
   "super":{"startup":10,"active":1,"recovery":40,"dmg":30,"screenWide":true,"blockable":false,"knockdown":true,"hitstop":8}
   ```
   - Knockdown (slam, super) is 40 ticks down plus 20 ticks getup, invulnerable the whole time.
   - No juggles: the hurtbox is off while a fighter is airborne from knockback.
   - Walk speed 60 milli-units per tick forward, 45 back. The jump arc is an integer table of 36 entries.
7. **"Code reads hitbox helpers per clip" conflicts with a deterministic sim.**
   - Reading animated empties at runtime gives floats that depend on the three.js mixer, and the server has no glb.
   - **Default:** add an offline bake, `pnpm assets:bake`.
     - It samples each helper every 1/60 s over each attack clip in Node (gltf-transform with a simple bone evaluator).
     - It projects onto the x/y plane and quantizes to integers (units × 1000) relative to the fighter's origin and facing.
     - It writes `packages/sim/src/data/hitboxes.json` (committed, tagged with the model hash). The sim and server read only this file.
   - **Retiming conflict:** moves.json retimes moves, but glTF drops timeline markers.
     - Each move in moves.json gets `clipMarks:[a,b]` (normalized clip time where the active window starts and ends).
     - The renderer time-warps the clip piecewise so startup/active/recovery map to [0,a], [a,b] and [b,1]. The bake samples inside [a,b].
8. **One `hit_beak` helper can't cover every attack.** Dive uses feet, shove uses wings, slam uses the body.
   - **Default:** `hurt_body` and `hit_beak` are required. `hit_foot`, `hit_wing` and `hit_body` are optional, and moves.json `hitbox` names which one a move uses, falling back to beak plus an offset.
   - Helpers must be parented to bones (`parent_type='BONE'`) or they won't follow the animation.
   - Empty display size isn't exported, so radius goes in custom properties (`{"shape":"sphere","r":0.25}`, `{"shape":"capsule","r":0.35,"h":1.1}`) with `export_extras=True`.
   - **Sammy:** yes, before he exports the hero model (the checklist changes).
9. **The export checklist contradicts itself.**
   - "format glb" plus "textures as separate files": a glb always embeds its images.
   - "Group by NLA track" names clips after NLA tracks, but the spec says action names are the contract.
   - Draco texcoord at 8 bits will make UVs swim on 2k maps (Blender's default is 12).
   - Draco doesn't compress animation, which will dominate file size.
   - **Default:** Sammy exports a raw glb with `export_animation_mode='ACTIONS'`, `export_force_sampling=True`, `export_optimize_animation_size=True`, `export_extras=True`, `use_selection=True`, `export_image_format='NONE'`, and no Draco.
   - `pnpm assets:import` then runs gltf-transform (`dedup`, `prune`, `resample`, `quantize`, `meshopt` or `draco`) to produce the shipped glb.
   - Tier textures are separate files loaded at runtime, which also makes lazy-loading the non-Rust tiers work.
   - **Sammy:** yes, before he exports the hero model.
10. **toktx isn't installed, and no global installs are allowed.**
    - `tools/textures.sh` documents `brew install ktx-software`.
    - The placeholder chicken and arena use flat or vertex-colour materials, so Phase 1 has no textures.
    - Evaluate `ktx2-encoder@0.6.0` (wasm) later.
    - Copy the Draco and Basis decoders from `three/examples/jsm/libs/{draco/gltf,basis}` into `apps/web/public/` with a prebuild script, not from the gstatic CDN.
11. **Ring-out at ±10.**
    - **Default:** walking, dashing, jumping and diving stop at ±(10 − half the body width). Only knockback or push can carry the centre past |x| > 10000 (milli-units).
    - A ring-out counts as a KO for the fighter who pushed, and plays the `fall` clip.
    - Fighters start at ±3. Pushboxes are solid on the ground, but fighters can cross over in the air (so a cornered player can escape). Overlap on landing is resolved by pushing them apart.
12. **KO freeze vs roundEnd, the timer, and draws.**
    - **Default:** the 2 s KO freeze and roundEnd are the same 120 ticks.
    - Hit-stop and roundEnd pause the round timer. The 180-tick countdown doesn't count toward the 60 s. HP resets every round.
    - A double KO, or a timeout with equal HP, goes to sudden death: first damage (chip included) or a ring-out wins, capped at 30 s. If still tied, the round is replayed. After 5 rounds the match is a draw.
    - **Sammy:** yes, by Phase 3 (does a draw pay out?).
13. **Determinism rules the spec doesn't state.**
    - `packages/sim` may only use `Math.abs/min/max/trunc/sign/imul`, enforced by eslint `no-restricted-properties`. Division goes through an integer-division helper.
    - The 45° dive uses vx = vy, so no trigonometry is needed.
    - Particles and camera shake use a separate visual RNG. Touching the sim RNG from rendering would desync prediction.
    - The sim RNG (xorshift, seeded with FNV-1a(matchId)) is currently only used by the CPU.
    - State hash: FNV-1a or `@noble/hashes` sha256 over a fixed-order Int32Array.
    - Replays carry `SIM_VERSION` and the moves.json hash, because tuning breaks old replays.
    - Keep `FighterState` flat, about 30 integers or fewer. The spec's snapshot field list leaves out hit-stop, stun, input history, dash detection and RNG. Phase 2 must send the full state (a raw Int32Array message is safer than schema, given the 63-field cap).
14. **The `step()` signature.** Keep the spec's pure `step(s,i1,i2)→s`, implemented with a manual flat clone. Budget under 20 µs per step, since reconciliation re-runs about 30 ticks per snapshot.
    - The countdown → fighting → roundEnd → matchEnd state machine lives in the sim, so replays reproduce it.
    - `waiting` and the disconnect pause stay in the Colyseus room.
15. **Two players on one keyboard vs the arrows+Space table.**
    - **Default:** a `keymap.ts` keyed by `KeyboardEvent.code`:
      - Solo/CPU: arrows or WASD to move, Space = peck, X = special.
      - 2P: P1 uses WASD + F (peck) + G (special); P2 uses arrows + K (peck) + L (special).
    - **Pitfalls:**
      - Call `preventDefault` on Space and the arrows, and ignore `e.repeat`.
      - macOS drops keyup while Cmd is held, so clear held keys on `blur`, `visibilitychange` and any event with `metaKey`.
      - Cheap external keyboards ghost with 3 or more keys held.
    - **Sammy:** confirm at review.
16. **Phase 1 asks for 60 fps on Android, but mobile controls are Phase 2.**
    - **Default:** Phase 1 ships a CPU-vs-CPU attract mode at `?demo=cpu`, which the landing hero also reuses.
    - `?perf=1` shows p50/p95 frame time and `renderer.info` counts. A low-quality toggle turns off particles and post-processing and uses pixel ratio 0.5.
17. **Tiers in Phase 1 have no source.** The spec wants material swaps by tier, but tiers come from the gate in Phase 2.
    - **Default:** set tier with `?tier=` or a debug menu.
18. **Colyseus version at scaffold time.** "`pnpm dev` runs web + game" means Phase 0 needs a Colyseus server now.
    - **Default:** scaffold on 0.18 with a minimal `FightRoom` that imports sim. Use @colyseus/sdk on the client.
19. **Supabase migrations and deploy configs can't be checked locally** (no supabase CLI, docker, fly or vercel).
    - **Default:** hand-write `supabase/migrations/<ts>_init.sql`. CI applies it to `@electric-sql/pglite@0.5.8`, with a shim that creates the `anon`, `authenticated` and `service_role` roles.
    - `fly.toml` and the Dockerfile are marked "unverified" in the README. The Vercel root directory (`apps/web`) is set in the dashboard.

## B. Blocks Phase 2/3. Code can't settle these now

1. **pump.fun vs Meteora DBC.** The locked choice is a DBC launchpad with GME as the quote token. The gate price fallback (pump.fun `/coins/<mint>`, "until PumpSwap"), the buy button and "the pump.fun link drops" are left over from another plan. pump.fun pairs against SOL and can't be quoted in GME.
   - **Default:** the fallback price comes from the DBC pool quote before graduation and the DAMM v2 pool after, in GME × Jupiter's GME/USD price. The buy link comes from a new `NEXT_PUBLIC_BUY_URL`.
   - **Sammy:** name the exact launchpad by Phase 2.
2. **Which GME?**
   - The meme coin GME is `8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB` (SPL, a few $M of liquidity).
   - The xStocks GMEx is `Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc`, a tokenized security restricted by jurisdiction. I believe it's Token-2022 but didn't confirm.
   - DBC needs a token badge (`deriveTokenBadgeAddress(quoteMint)`) for quote mints that aren't supported without permission, and a badge forbids transfer fees.
   - **Sammy:** yes, by Phase 3 (this sets `QUOTE_MINT`).
3. **DBC fee mechanics.** `creatorTradingFeePercentage` is the creator's share of the trading fee. The rest goes to the partner (the launchpad).
   - "The full 3% to CREATOR_WALLET" only works if Sammy owns the config. Then there are two claims:
     - `client.partner.claimPartnerTradingFee`
     - `client.creator.claimCreatorTradingFee({creator, payer, pool, maxBaseAmount, maxQuoteAmount, receiver?, tempWSolAcc?})`, or `claimCreatorTradingFee2` for transfer-hook pools.
   - New configs must migrate to DAMM v2 (v1 is deprecated).
   - A 3% fee after graduation needs `migrationFeeOption: 6` (Customizable, `poolFeeBps` 10–1000). The fixed options are 25, 30, 100, 200, 400 or 600 bps.
   - After graduation, fees are claimed with cp-amm-sdk `claimPositionFee` / `claimPositionFee2`. This only works if `creatorPermanentLockedLiquidityPercentage > 0`.
   - **Sammy:** by Phase 3.
4. **Jupiter is on v2 in the spec.** Move to v3 and add a `JUPITER_API_KEY` env var. A mint missing from the response means use the curve fallback.
5. **Helius balance lookup.**
   - Use `getTokenAccountsByOwner(owner, {mint}, {encoding:'jsonParsed', commitment:'confirmed'})`. Helius's docs don't state it, but I believe the node works out the token program from the mint, so Token-2022 should work. Confirm with a Token-2022 test mint on devnet in Phase 2.
   - Sum `tokenAmount.amount` as a BigInt, not `uiAmount`.
   - Skip DAS `getAssetsByOwner`: it needs `showFungible`, pagination, and lags behind indexing.
6. **The tick-ahead anti-cheat rule breaks prediction.** "Reject inputs with tick > serverTick+3", but a predicting client runs about 10 or more ticks ahead at 80 ms RTT.
   - Phase 2 either aligns client ticks to the server or allows a lead of up to about 20 ticks.
   - Also decide between Colyseus 0.18's built-in prediction and the hand-rolled protocol.
7. **Upstash with the Colyseus Redis driver.** The driver needs a TCP `rediss://` URL; the env only lists the REST URL and token. One global Redis shared by iad and fra puts transatlantic latency on matchmaking. With one machine per region at launch, separate clusters per region are simpler.
8. **Who writes to the database.** "Web reads public views only" and "service role only in game/worker", but `/api/gate` writes `balance_checks` and `/admin` voids payouts.
   - Either give the web a narrowly scoped key or proxy through the worker.
   - Supabase views run with the owner's rights and bypass RLS, so views must never expose `ip_hash`, `fingerprint`, `flags` or `input_log`.
   - Refreshing the materialized view every minute needs pg_cron or the worker.
9. **"Switch to GME payouts is one flag" is false.** Paying GME needs an SPL transfer plus creating the recipient's token account (about 0.002 SOL rent each).
10. **Payout formula gaps.** The `q` multiplier leaves out the ">30% dropped inputs voids the payout" tier. The P_min floor contradicts "never promises more than fees deliver".
11. **Screen captures "in the PR".** gh can't upload attachments. Commit small webm/gif files from Playwright `video:'on'` to `docs/captures/phase-N/` and link them from the PR.

## C. Cosmetic
- **Clip list:** 21 is correct: idle, walk_fwd, walk_back, dash, jump, fall, land, block, block_hit, peck, dive_kick, slam, shove, super, hit_light, hit_heavy, knockdown, getup, ko, win, entrance.
  - No clip exists for backdash (play `dash` reversed), ring-out (reuse `fall`) or losing a round (reuse `idle`).
  - The validator requires these exact names and warns on extra clips.
- **Entrance:** `entrance` is a base clip but is also listed as a Diamond perk. Every tier plays it; Diamond adds visual effects.
- **Crowd:** "Crowd cheers your name" would need text-to-speech. Show the name on a banner and play a generic chant.
- **Arena edge:** "Pit ringed by car bodies" vs falling off the edge. The edge has to read as a drop (hazard stripes, oil pit).
- **Lightmap:** glTF has no lightmap slot. The arena needs a second UV map (TEXCOORD_1) and a separate lightmap file, set in three.js with `texture.channel=1`.

## D. Acceptance criteria that can't be checked here, and how to approximate them
- **"Two people on one keyboard call it fun":** Sammy plus one other person at review. Code provides a scripted two-player Playwright smoke test and a debug overlay (hitboxes, frame advantage).
- **"Every move works with the listed frame data":** a vitest test per move checks the first active tick = startup + 1, the active length, the total = startup + active + recovery, and dash invulnerability on ticks 3–6.
- **"Hero chicken imports with all 21 clips":** the hero model doesn't exist yet.
  - Build the placeholder with `art/blender/build_placeholder_chicken.py`, run headless (`Blender -b -P`), and export it with the same settings Sammy will use.
  - Then `pnpm assets:validate` checks: exactly the 21 clip names, `Rig` and `root` present, 40 bones or fewer, 15k triangles or fewer, one skinned mesh, helpers with their extras, and no root-bone translation.
  - A Playwright test asserts zero console errors. Mark the hero check as "pending asset".
- **"60 fps on an M1 Air and a 3-year-old Android":** Sammy's Apple Silicon Mac, plus Playwright with CDP `Emulation.setCPUThrottlingRate(4)` and a p95 frame-time budget of 16.7 ms as a proxy. Sammy checks a real Android phone through the LAN URL (`next dev -H 0.0.0.0`) and the result goes in the PR.
- **Phase 0 "identical state hash on two machines":** commit a golden input log and its expected hash. The test runs on macOS arm64 locally, on GitHub Actions ubuntu x64, and in Chromium through Playwright.

## E. Branches and PRs
The spec says one branch and one PR per phase, with a stop after each. Sammy has approved Phase 0 and Phase 1 in this session.
- Branch `phase-0-scaffold` → PR #1 into main.
- Branch `phase-1-fighter`, cut from phase-0 → PR #2 based on `phase-0-scaffold`. It's stacked, and GitHub retargets it to main once #1 merges and its branch is deleted.
- Stop after PR #2. Every default above goes in the README "Decisions" section.

## F. Before mainnet
- **Legal:** regulatory risk that the game reads as a prize contest or gambling. Get the lawyer read and settle the geo-block list before Phase 4. It gets worse if the GMEx security is the quote token.

Sources: [Jupiter Price v3](https://developers.jup.ag/docs/api-reference/price/v3/price), [Jupiter Price v2 deprecated](https://hub.jup.ag/docs/price-api/v2), [Jupiter Swap v1](https://developers.jup.ag/docs/api-reference/swap/v1/swap), [Meteora DBC SDK docs](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/docs.md), [Colyseus 0.18](https://colyseus.io/blog/colyseus-018-is-here/), [Colyseus 0.17 migration](https://docs.colyseus.io/migrating/0.17), [pnpm 11](https://pnpm.io/blog/releases/11.0), [Helius getTokenAccountsByOwner](https://www.helius.dev/docs/rpc/guides/gettokenaccountsbyowner), [GME on DexScreener](https://dexscreener.com/solana/8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB), [GMEx on Solana Compass](https://solanacompass.com/news/gamestop-tokenized-as-gmex-on-solana-now-trading-247-across-dexs-via-xstocks).

Probe files are in the scratchpad at `/private/tmp/claude-501/-Users-samthayer-Library-Application-Support-Claude-scratch-workspaces-91621548-4b89-4455-b3f7-36c68eaadb27-a5528d0a-317c-4efc-9ddf-27b3781fafdc-scratch-2026-09-23-c83513/d6dfe493-e1d7-4cf7-bd2b-2427ead14763/scratchpad/`: `dbc_docs.md` and `probe_gltf.py`.
