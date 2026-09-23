# COCKFIGHT: build plan for Phase 0 (scaffold) and Phase 1 (local fighter)

## Context

Sammy's spec (`~/Downloads/COCKFIGHT — Build Plan.pdf`, 23 pages) describes a browser game: a 1v1 2.5D fighter with robot chickens.
- **Stack:** Three.js, a Colyseus authoritative server, Next.js on Vercel, Supabase.
- **Money:** winners are paid in SOL out of the $COCK coin's trading fees.
- **Process:** the spec is the contract, and it asks for a stop after each phase for review.

**Agreed with Sammy:**
- The repo lives at **`~/cockfight`**.
- It is a **private GitHub repo** created with `gh` (account `sammythayermusic-ship-it`, which has repo and workflow scopes). Each phase gets its own branch and PR.
- This session builds **Phase 0 plus all of Phase 1**, then stops for review.
- Phase 2 onward (online play, wallet gate, money) is out of scope, apart from the scaffolding the spec lists under Phase 0.

**This machine:** Node 22.22.2, pnpm 11.0.9, gh, Blender 5.2.1 (runs headless), and ffmpeg. Docker and the fly, supabase, vercel and toktx CLIs are not installed.

**Research:** a 9-agent read-only workflow (7 researchers, 1 synthesizer, 1 adversarial critic) checked every version with `npm view`. It also did a real headless Blender 5.2.1 probe: layered actions on NLA tracks export as named clips, empties parented to bones follow the bones, and gltf-validator reported 0 errors. This plan is the synthesized plan with the critic's fixes applied. The full reports are copied into the repo as `docs/research/*.md` at the start of execution. They are the reference for exact code: the exporter settings, the channelbag API, the Colyseus 0.18 API, the Dockerfile, fly.toml, the SQL, and the sim types.

## How the work is run

1. **Move the session.** Create `~/cockfight`, run `git init -b main`, and move the session there with `change_directory`. The first commit on `main` holds only the README stub and `.gitignore`. Then create the repo with `gh repo create sammythayermusic-ship-it/cockfight --private --source . --push`.
2. **Phase 0.**
   - The root setup and the `packages/sim` skeleton are done inline first; everything else builds on them.
   - Four independent workstreams then run as one workflow, each agent in its own git worktree:
     - Blender placeholder plus the asset tools
     - Supabase with PGlite
     - game server plus worker
     - web shell
   - They are merged and integrated inline, then CI is added.
   - A review workflow checks correctness, determinism and spec conformance, and adversarially verifies each finding. Fixes land, then PR #1 is opened.
3. **Phase 1.** The spec's fun-first steps depend on each other, so they are built mostly inline and in order.
   - Independent pieces fan out: the audio recipes, the particles, the arena and the HUD.
   - Each step ends with `pnpm verify` plus Playwright captures.
   - The phase ends with a review workflow, then PR #2, stacked on `phase-0-scaffold`.
4. **Commits and PRs.**
   - Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   - Every PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
   - Nothing gets merged. PR #1's body says to use a merge commit, not squash, because the stacked PR #2 depends on it.

## Key decisions

### Versions
Shared versions live in the `catalog:` section of `pnpm-workspace.yaml`, and lower bounds are kept at least a day old.

| Area | Pin |
|---|---|
| Package manager | `packageManager: pnpm@11.27.1`. Don't set `minimumReleaseAge`. `allowBuilds: {esbuild: true, unrs-resolver: true, msgpackr-extract: false}`. `.npmrc` holds registry settings only. `ENV CI=true` in Dockerfiles. |
| Web | next and eslint-config-next 16.3.6, react and react-dom **19.2.8** (R3F isn't used, but 19.3 is too new), tailwind 4.3, zustand 5 (UI state only) |
| 3D | three and @types/three **0.186.0 exactly**, with the decoders copied into `/decoders/r186/`. No R3F, drei or `postprocessing`. |
| TypeScript and lint | typescript `~6.0.3` (TS 7 has no JavaScript API that typescript-eslint and Next can use), eslint ^9.39, typescript-eslint ^8.70 |
| Tests | vitest ^4.1.11, fast-check ^4, @playwright/test **1.62.1 exactly** (its browsers are already cached, including Firefox and WebKit) |
| Server | @colyseus/core ^0.18.15, schema ^5.0.33, ws-transport ^0.18.2, sdk ^0.18.3, testing ^0.18.5, tools ^0.18.3 (dev only), express 5, zod ^4.6 |
| Assets and data | @gltf-transform/* ^4.5, draco3dgltf, gltf-validator, @electric-sql/pglite ^0.5, smol-toml, bs58 |
| Build | tsx, esbuild ^0.28 (the server becomes one bundled file). No turbo, no tsup. |

### Deviations from the spec
Each one goes in `docs/decisions.md`. A ★ means Sammy should confirm it at the Phase 1 review.

1. **Next 16.3, not 15.** 15 only receives backports, and soltendogs already runs 16.
2. **Colyseus 0.18, not 0.16.** 0.16 is legacy.
   - The browser client package is now `@colyseus/sdk`.
   - Room state uses the decorator-free `schema({...})` builder.
   - `setFixedTimestep`, `defineInput` and `QueueRoom` fit the Phase 2 netcode.
3. **The Blender export checklist is rewritten.**
   - "Group by NLA track" has done nothing since Blender 3.6. The replacement settings are Mode = Actions, Export all Armature Actions, Always Sample, Merge Animation = NLA Track Names, Optimize, Start at 0, and Custom Properties.
   - Draco quantization becomes **14/10/12** for position, normal and texcoord (8-bit UVs are about 8 texels off on a 2k map) ★.
   - Also set `export_def_bones=True`, so control bones don't count toward the 40-joint budget.
   - Export goes through one scripted `export_chicken()`, and the UI checklist becomes the fallback.
4. **Hitbox helpers are baked offline into integer JSON.** A tool writes `packages/sim/data/hitboxes.json`, so the sim never reads a glb. Helper sizes come from custom properties (`cf_radius`, `cf_half_height`), because glTF doesn't export an empty's display size.
5. **Tiers are material swaps done at runtime,** not `KHR_materials_variants`.
6. **Textures use `ktx create` (KTX-Software 4.4),** not `toktx`, which is deprecated. Phase 1 uses flat materials, so `tools/textures.sh` only prints install instructions.
7. **Supabase grants go to `service_role` explicitly.** New projects require it.
8. **New env vars, documented only:** `JUPITER_API_KEY` (Price v2 is deprecated; v3 needs a key), `REDIS_URL` (the Colyseus driver needs TCP `rediss://`), `ALLOWED_ORIGINS`, `PAYOUTS_ENABLED=false`.

### Gameplay defaults where the spec is ambiguous (in `moves.json` and `docs/decisions.md`)
- **Units and time.**
  - Position is stored in mu = 1/1000 unit. HP is ×100 (max 10000). Heat is ×60 (max 6000), so it decays exactly 1 per tick.
  - Time runs at 60 ticks per second.
  - The only division is `idiv=(a,b)=>(a/b)|0`, which asserts `b≠0` in test builds.
- **Input.**
  - The input is a 5-bit mask (L, R, U, D, Space). Holding opposite directions together cancels them out.
  - Attacks fire on the press, with a 5-tick buffer that survives hit-stop.
  - A dash is two taps of the same direction within 12 ticks; a third tap doesn't dash again.
- **Space priority.**
  - Grounded: full Heat, not holding ↓ and not holding toward the opponent → **super** ★. Otherwise ↓ → slam, toward → shove, anything else → peck.
  - In the air (after 4 airborne ticks, height ≥ 900, once per jump) → dive kick.
  - A connecting peck can cancel into shove or super.
- **Blocking.** Holding ↓ while grounded blocks peck, shove and super, with 10% chip damage; chip can KO. Slam and **dive kick are unblockable** ★.
- **Ring-out.** Walking, dashing and jumping stop at |x| = 9500. **Only a hit from shove, slam or super can carry a fighter past 10000** ★. A ring-out counts as a KO.
- **Rounds.**
  - A 180-tick countdown comes before the round's 3600 ticks; the KO freeze and roundEnd are the same 120 ticks.
  - Timeout with equal HP → sudden death: 1800 ticks, where the first clean hit wins ★.
  - A double KO is a draw, with at most 5 rounds, so a match can end in a draw (`matchWinner=2`) ★.
- **Heat.** +480 for landing a hit, +180 for a hit that was blocked, −1 per tick. It **latches at full** instead of decaying ★ (otherwise full Heat lasts under a second). It resets every round.
- **Frame data.** peck 4/2/8, shove 8/3/16 (pushes exactly 2000 mu), slam 14/4/22 (launch, knockdown for 40 ticks, get-up for 20 while invulnerable), dive kick (6-tick hover, 45° with |vx|=|vy|, 14 ticks of landing recovery), super 10/6/30 (invulnerable on frames 1–16, 30% damage, costs a full bar).
- **Movement.** Jump: vy 270 with gravity 15, which gives exactly 36 airborne ticks. Dash: 12 ticks, invulnerable on ticks 3–6. Hit-stop: 3 ticks, or 8 for slam and super. The full table is in `docs/research/simDesign.md` and the synthesized plan.
- **Keyboard ★.**
  - vs CPU: arrows + Space (the spec), with WASD + J as aliases.
  - 2P: P1 = WASD + Space/F; P2 = arrows + `/` (also `.`, Enter, Numpad0).
  - Ctrl, Meta, Alt and Shift are never bound.

### Architecture choices
- **Monorepo.** Plain pnpm workspaces (`apps/*`, `packages/*`, `tools`). Internal packages export TypeScript source with no build step, and `transpilePackages` handles them in Next.
- **Dependency direction.** `sim` depends on nothing. `shared` depends on `sim`. The apps depend on `sim` and `shared`.
- **Sim API.** `step(prev, b1, b2, R)` is pure: it clones internally and never mutates `prev`. Visual events come from a separate pure function, `deriveEvents(prev, next)`; they are not part of the state and are not hashed.
- **Rules and hash.** `compileRules()` turns `moves.json` and `hitboxes.json` into Int32 tables indexed by move and clip id. `rulesHash` is the FNV hash of those tables. The sim never iterates over plain objects.
- **State hash.** FNV-1a-64 over two 32-bit lanes, walking a fixed `FIELDS` order. It uses `>>> 0`, never `Math.floor`.
- **Web game.** Plain three.js, imperative. The code lives in `apps/web/src/game/` with no React. React handles only the page shell and the HUD. The frame order is: step the sim, update presentation, render.
- **Chicken animation.** The mixer is driven from sim state: set `action.time`, set weights, then `mixer.update(0)`. It never runs on its own clock, so hit-stop and replays are exact.
- **Audio.** Procedural WebAudio, rendered once with `OfflineAudioContext` into buffers. Files named `public/audio/<name>.m4a` override the procedural sound later, when Sammy's sound pack lands.

## Repo layout after Phase 1 (abridged)
```
cockfight/  package.json pnpm-workspace.yaml .nvmrc .gitattributes tsconfig.base.json eslint.config.mjs vitest.config.ts .env.example README.md CLAUDE.md
├─ docs/ decisions.md changelog.md plan.md art-pipeline.md controls.md research/ captures/{phase-0,phase-1}/
├─ .github/workflows/ci.yml
├─ art/blender/ cf_common.py build_placeholder_chicken.py export_chicken.py make_messy_fixture.py presets/
├─ apps/web/    src/app/{page,play,dev/net} src/game/{engine,match,view,fx,audio,showcase,react} src/components/{hud,site} e2e/ scripts/copy-decoders.mjs public/models/
├─ apps/game/   src/{index,server,state}.ts src/rooms/{LobbyRoom,FightRoom}.ts build.mjs Dockerfile fly.toml test/
├─ apps/worker/ src/index.ts build.mjs Dockerfile fly.toml
├─ packages/sim/     data/{moves,hitboxes,chicken.contract}.json src/{fixed,types,input,rules,state,physics,collide,combat,round,step,events,anim,rng,hash,serialize,replay,cpu}.ts test/ test/golden/ scripts/replay-golden.ts
├─ packages/shared/  src/{constants,env}.ts        packages/solana/ src/index.ts (interfaces + tierForUsd + isValidAddress)
├─ supabase/ config.toml migrations/{…_init.sql,…_cron.sql}
└─ tools/ src/assets/{validate,sample,bake,inspect}.ts src/blender/run.ts src/db/harness.ts test/{validate,bake,bakeParity,migrations,infra}.test.ts textures.sh
```
**Root scripts:**
- `dev`: web + game in parallel
- `build`, `lint`, `typecheck`, `test`
- `test:e2e`, `test:perf`
- `replay:golden [--bless]`
- `assets:placeholder`, `assets:validate`, `assets:bake [--check]`, `assets:import --blend <file>`
- `verify`: lint + typecheck + test + validate + bake --check + build

## Phase 0: scaffold (branch `phase-0-scaffold`, PR #1)

**P0.1 Root setup.**
- **Workspace files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (ES2023, Bundler resolution, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `.nvmrc`.
- **Git hygiene:**
  - `.gitattributes`: `eol=lf`; `*.glb` and `*.blend` binary; replay JSON marked as generated.
  - `.gitignore` covers `**/.next`, `dist`, `coverage`, `test-results`, decoders, `art/blender/out` and `.env*`, but keeps `.env.example`.
- **ESLint:** a flat config with monorepo-wide ignores (`**/.next/**` and so on). Next's rules are scoped to `apps/web`.
- **`packages/sim/src/**` restrictions:**
  - `Math` is allowed only for `abs`, `min`, `max`, `trunc`, `imul`, `sign` and `clz32`.
  - `**`, `for…in` and `Object.keys/values/entries` are banned (the last is allowed in `rules.ts`).
  - `Date`, `performance`, `window` and `process` are banned, as are imports of three, colyseus and zod.
- **`apps/web/src/game/**`:** React imports are banned, except in `react/`.
- **Docs:** `CLAUDE.md` (commands and pitfalls, like soltendogs), `docs/{decisions,changelog,plan}.md`, `docs/research/`.

**P0.2 `packages/sim` skeleton.**
- **Files:**
  - `fixed`, `types` (the full `FighterState` and `MatchState` field lists now, so the hash layout stays stable), `rng` (xorshift32), `hash`, `serialize` (Int32Array), `state` (`createMatch`, `resetRound`, `clone`)
  - `input` (edge detection and cancelling opposite directions), `round` (the full phase machine), `physics` (walk, facing, walls, symmetric pushbox)
  - `step`, `replay` (`runReplay` throws if `rulesHash` doesn't match), `rules`/`compileRules`
  - data: `moves.json` (all the data), `chicken.contract.json` (21 clips with frame counts and phases, helper shapes, material slots, budgets)
- **Pushbox:** each fighter moves by `(o+1)>>1`, so neither player gets the extra 1 mu.
- **Golden replays:**
  - `walk-timeout` (a scripted DSL run) and `random-3rounds`. The random one is stored as `{gen, seed, ticks}` and holds each input 1–30 ticks, so the fixture stays small.
  - `packages/sim/scripts/replay-golden.ts` prints `<name> <ticks> <hash>`, exits 1 on a mismatch, and `--bless` rewrites the stored values.
- **Tests:**
  - fixed: truncation is symmetric; no −0.
  - hash: matches a BigInt reference on 2,000 inputs. `FIELDS` equals `Object.keys` for both fighter and match. `serialize` length is as expected.
  - purity: `step` on a deep-frozen state doesn't throw.
  - round: tick counts are exact.
  - rules, golden.

**P0.3 `packages/shared` and `packages/solana` (kept small).**
- **shared:** `constants.ts` (tick rate, snapshot rate, grace period, tier thresholds). `env.ts`: a zod schema that boots everything with **zero env vars**; empty strings fall back to defaults.
- **solana:** interfaces, `tierForUsd` and `isValidAddress`, with boundary tests.
- **Left for Phase 2/3:** the `Snapshot`/`MatchResult` wire schemas, the `db.ts` row types, and the worker's money env.

**P0.4 Workstream A: Blender placeholder and asset tools.**
- **Scripts:** `art/blender/cf_common.py` (`EXPORT_KWARGS` as verified by the probe, and `export_chicken()`) and `build_placeholder_chicken.py`.
- **`export_chicken()` checks:**
  - fps is 60;
  - the armature actions are exactly the 21 contract clips (a stray action is fatal);
  - both helpers exist and have their custom properties;
  - export goes to a temp file and then `os.replace`;
  - it prints a `CF_REPORT` summary.
- **The chicken:** boxy, rigidly skinned, 16 bones.
  - `hurt_body` is a capsule (r .40, half-height .42) on `body`; `hit_beak` is a sphere (r .14) on `head`.
  - The 21 clips are keyed through the channelbag API on name-matched NLA tracks. Their frame counts equal `moves.json` exactly (for example, shove is 27 frames, and land is 4). Sim frame f equals clip sample f.
  - Materials `cf_shell`, `cf_trim`, `cf_eye`, `cf_beak`, `cf_comb`.
- **Runner:** `tools/src/blender/run.ts` runs `-b --factory-startup --python-exit-code 1`.
- **`tools` code:**
  - `validate.ts` (v1): the file parses with Draco, gltf-validator reports 0 errors, one skinned mesh, ≤ 40 joints, ≤ 15k tris, exactly the 21 clips with near-miss hints, helpers have their extras, `root` is a joint, no root motion, and the `source.sha256` check.
  - `sample.ts` (STEP, LINEAR, CUBICSPLINE samplers) and `bake.ts`: write integer `hitboxes.json` (sim x = glTF +Z, sim y = +Y). `bake --check` re-bakes and diffs exactly.
- **Tests:**
  - `validate.test`: the committed glb passes, and a mutated copy fails.
  - `bake.test`.
  - `bakeParity.test`: three.js `AnimationMixer` as an oracle, agreeing within ±1 mu.
- **Verify:** `pnpm assets:placeholder` twice gives byte-identical output, and validate and `bake --check` are green.

**P0.5 Workstream B: Supabase.**
- **Order:** write the PGlite harness and `migrations.test` **first**, to prove PGlite can run `refresh … concurrently`, `set role` with RLS, and default privileges.
- **Migrations:**
  - **Tables:** the 8 tables from the spec. `matches.reason` includes `'draw'` with `winner` null, and rounds go up to 5. `payouts.idem_key` is unique, and payouts also get `next_attempt_at` and `last_error`.
  - **Indexes:** the ones the spec lists.
  - **Security:** RLS on everywhere with no policies; revoke from `anon`/`authenticated`; explicit `service_role` grants.
  - **Views:** `leaderboard_v` is materialized with a unique index; `pool_v` is a plain view. Both are granted to `anon`.
  - **`pg_cron`:** a separate migration, guarded so it only runs where the extension is available.
- **Tests:** run under both the strict and legacy grant modes. Anon can't read the base tables but can read the views; `idem_key` blocks duplicates; draws can be stored.
- **Avoid:** anything only Postgres 18 has.

**P0.6 Workstream C: game server and worker.**
- **Server shape:** `apps/game` exports a `makeServer(opts)` factory, not a singleton created at import time. It uses an explicit `WebSocketTransport` with an `http.Server`, `/health`, and listens on `0.0.0.0`.
- **Rooms:** a stub `LobbyRoom`, and a `FightRoom` that only advances `tick`/`phase` through `setFixedTimestep(…,60)` with `patchRate` 50 ms. The real protocol is Phase 2.
- **Build:** esbuild into one `dist/server.mjs` (with a `createRequire` banner), plus a smoke script that runs the built bundle and checks `/health` and a lobby join.
- **Deploy files:** the Dockerfile (`CI=true`; the runtime stage copies only `dist`), and `fly.toml` for iad + fra (`auto_stop_machines="off"`, `/health` check, `shared-cpu-1x` 1gb).
- **Test:** `@colyseus/testing`: `boot(makeServer({gracefullyShutdown:false}))`, then `waitForNextTimestep()`.
- **Worker:** `apps/worker` is a `/health` stub with its own build, Dockerfile, and a fly.toml with no `http_service`.

**P0.7 Workstream D: web shell.**
- **Next 16 app:** Tailwind 4 (from soltendogs). `next.config.ts` has `transpilePackages` and soltendogs' CSP (`'unsafe-inline' blob:`, plus `'unsafe-eval'` in dev, plus `'wasm-unsafe-eval'`), in report-only mode.
- **Decoders:** `copy-decoders.mjs` copies them into `/decoders/r186/`, and runs inline in the `dev` and `build` scripts.
- **Typecheck:** `next typegen && tsc --noEmit`.
- **Vitest scope:** limited to `src/**/*.test.ts`, so the Playwright specs are never picked up.
- **Pages:**
  - `/`: a placeholder hero whose `ShowcaseCanvas` loads `chicken_placeholder.glb` and plays `idle`.
  - `/play`: a stub.
  - `/dev/net`: joins `fight` through `@colyseus/sdk` and shows the tick. It returns `notFound()` in production.
- **Bundler check, first thing:** run a real `next build` as soon as the three.js loaders are imported. If Turbopack fails on three's `new URL(import.meta.url)` defaults, patch them with `pnpm patch`. Also check that JSON imports from a workspace package work.
- **Deploy config:** `vercel.json` with a filtered install and Root Directory `apps/web` (documented).

**P0.8 Integrate, then CI.**
- Merge the workstreams. Add `.env.example`, a README (setup, env table, deploy commands, anything unverified marked as such), and `tools/test/infra.test.ts` (parses both fly.toml files).
- **`ci.yml` jobs:**
  - **`check`** (ubuntu): lint, typecheck, test, validate, `bake --check`, web build, game build and smoke.
  - **`replay`** (matrix ubuntu x64 + macos arm64): installs only the sim filter, then runs `replay:golden`. It runs only when `packages/sim/**` or the lockfile change.
  - **`replay-compare`**: requires exactly 2 artifacts and diffs them.
  - **`docker`**: build both images and curl `/health`.

**P0.9 Review, verify, PR #1.**
- Run the review workflow and apply its fixes.
- Run `pnpm verify` locally.
- Run `pnpm dev`, then curl `:3000` and `:2567/health`; `/dev/net` shows the tick climbing.
- A Playwright smoke test checks for zero console errors and zero CSP violations, and saves `docs/captures/phase-0/landing.png`.
- Save a Blender contact sheet of the placeholder.
- Push, open PR #1 with absolute `blob/<sha>/…?raw=true` image links, and wait until CI is green.

## Phase 1: the local fighter (branch `phase-1-fighter` off phase-0, PR #2)

Each step ends with `pnpm verify`, e2e captures, a commit, and a changelog entry. When the rules change, re-bless the golden replays in the same commit and say why.

**1.1 Peck, walk, block, HP.**
- **sim:**
  - `input` buffer and taps; `fighter` states; `collide` (integer capsule vs circle with a bounding-box early exit)
  - `combat`: detect both directions, then apply both; add up both players' slide contributions, then assign once; `slideRem` handles distances that don't divide evenly
  - `anim.clipSample`; `events`
- **web:**
  - `engine/loop.ts`: 60 Hz accumulator, at most 5 catch-up steps, render interpolation
  - `keyboard.ts`: uses `e.code`, latches presses, and releases everything on blur
  - `LocalMatch`, `FightView` (flat floor, fixed camera), `ChickenView` (`SkeletonUtils.clone`, facing via `rotation.y`, the mixer driven by the sim)
  - `HitboxOverlay` (`?debug=1` or H) with a frame-data readout; minimal HP bars
- **Debug handles:** `window.__cockfight`, and `?manual=1` for stepping ticks.
- **Tests:**
  - Table-driven peck frames: whiff recovers on exactly tick 14; hits on 5–6 and not 4 or 7; stun and hit-stop are exact.
  - Chip is exactly 60.
  - SOCD; a buffered press survives hit-stop.
  - With the **real baked hitboxes**, a walk-in from ±2500 lands a peck, and `compileRules().fallbacks` is empty.
  - `e2e/fight-2p.spec.ts`: real key presses, interleaved with stepping ticks inside the page.

**1.2 Jump, dive kick, slam, shove, dash, and the CPU.**
- **Moves:** all of them, with the clip mapping for the 21 clips.
- **CPU:** `sim/src/cpu.ts` is deterministic, with its own seeded RNG. It reacts to a delayed view of the opponent. Difficulty sets the reaction ticks and block rate: Easy 22 ticks / 30%, Normal 14 / 60%, Hard 8 / 85%.
- **Goldens:** `every-move` and `cpu-seed1..5`.
- **Frame tests for every move:**
  - Jump: 36 airborne ticks, apex on ticks 18–19.
  - Dash: tap gaps of 12 vs 13 ticks; invulnerable on ticks 3–6.
  - Dive: |vx|=|vy|.
  - Slam: only hits grounded targets.
  - Shove: moves the defender exactly 2000, or 1000 on block, clamped at the wall.
- **fast-check properties:**
  - every state field is an integer with no NaN or −0, and values stay in bounds;
  - running twice gives the same hash every tick;
  - `prev` is never mutated;
  - rewind-and-replay reproduces the hash;
  - swapping the players mirrors the state;
  - matches always end.
  - Budget: 50 runs of up to 6k ticks by default; `SOAK=1` runs 200 × 30k in a separate CI job.
- **e2e:**
  - `cpu-match.spec.ts`
  - `replay-engines.spec.ts`: the golden replays in Chromium, Firefox and WebKit must give identical hashes.

**1.3 Juice.**
- **Effects routing:** `fx/director.ts` and `fxTable.ts` map each event to its sounds, particles, shake, camera punch and crowd hype.
- **Hit-stop visuals:** the victim vibrates and flashes white for 2 ticks.
- **Camera:** `FightCamera` frames using the horizontal FOV, with smoothed dolly and pull-back, and seeded trauma² shake. `prefers-reduced-motion` scales shake down.
- **Particles:** instanced quads in two meshes, additive for sparks and flames, cutout for screws, feathers and dust. Ring-buffer pools; the shader computes the motion; spawn seeds come from `hash(seed, tick, idx)`.
- **Audio:** `AudioEngine` with sfx, crowd and ui buses and a compressor. The procedural recipes are metal hits, a scream per damage tier, crowd swell, KO horn, bell and UI sounds, with 1 variant each plus pitch jitter. `SoundName` manifest; files override the procedural sounds.
- **Tests:** shake determinism, fxTable coverage, every sound has a recipe. In e2e, a hit shows up in `audio.recent` and `fx.live()`, with a screenshot mid-hit-stop.

**1.4 Heat and super, ring-out, rounds, timer, HUD.**
- **Sim:** Heat latching; super (neutral Space at full Heat, invulnerable frames, a screen-wide hit that misses a jumper); ring-out (`roAble` from the ring-out moves, then |x| > 10000 means falling out); KO, double-KO draw, timeout, sudden death, 5-round cap.
- **DOM HUD:**
  - HP bars with a delayed damage trail, the Heat meter with "SUPER READY", a timer (red pulse under 10 s), and round pips
  - banners: 3/2/1/FIGHT!, ROUND N, K.O.!, RING OUT!, TIME!, PERFECT
  - PauseMenu (Resume, Restart, Quit, Mute), MatchEnd (Rematch, Change mode)
  - ModePicker (CPU Easy/Normal/Hard, 2P local, Controls with a key/ghosting tester, debug tier picker)
- **Tests:** Heat and super; ring-out distances (shove from 8.5 units, slam from 6.5; a peck never rings out); every round scenario; `hud.spec.ts` screenshots.

**1.5 Hero import path, tier materials, arena, camera.**
- **Hero import:**
  - `export_chicken.py` and a UI preset.
  - `pnpm assets:import --blend <file>` runs export, then validate, then bake. `hitboxes.json.source.file` decides which glb loads.
  - A `make_messy_fixture.py` builds a .blend with UI-authored habits: actions not on NLA tracks, 24 fps, frame_start 1, a stray `Action`, a non-deform bone, empties without `cf_radius`. The export must fix each one or fail with a clear hint.
- **validate v2 adds:** every `moves.json` clip exists in the glb and in the hitboxes file; texture and arena rules (skipped when absent); a first-load table that must stay ≤ 12 MB; and each attack's hit helper must be in front of `hurt_body` during its active frames.
- **Tier materials:** the Rust, Chrome, Gold and Diamond PBR values; Diamond uses `MeshPhysicalMaterial` with iridescence; an environment map from a PMREM of the mini junkyard. Tier flags: Chrome's dash trail and Gold's extra sparks.
- **Procedural junkyard arena (0 bytes of assets):**
  - pit floor with a lip at ±10
  - stacked car walls, tire stacks
  - oil-drum fires with flicker
  - 240 instanced crowd sprites driven by hype
  - floodlight cones
  - baked vertex colors plus fog, no shadow maps, blob contact shadows
  - a swap path for Sammy's `arena.glb` through named empties
- **Camera and effects:** a KO push-in plus a chromatic-aberration pulse (a custom pass that only runs during KO); a FOV kick on the super.
- **Quality and perf:** quality tiers (high: DPR 1.5; low: half resolution, no particles), plus a manual toggle; `?fps=1` meter; `?bench=1` bench mode; shaders prewarmed with `compileAsync`.
- **Landing page:** `/` shows two idle chickens, lazily loaded.
- **Tests:** placeholder round trip through `export_chicken.py` (the clips match exactly); `assets.spec.ts` (21 clips, zero console errors, screenshots of all 4 tiers).

**1.6 Hardening and PR #2.**
- Run the review workflow and apply fixes.
- Run the full e2e suite and the local perf bench on this Mac.
- Record captures: GIFs made with ffmpeg, and linked webm files.
- Update the README, `controls.md`, `art-pipeline.md`, and a `decisions.md` entry for every ★ item.
- Open PR #2 against `phase-0-scaffold`.

**Cut, beyond what the spec asks:** adaptive quality, planar shadows, key remapping, multiple sound variants, lazy tier loading, and Diamond entrance effects.

## Verification: how each acceptance criterion is shown

| Criterion | How it is shown |
|---|---|
| P0: `pnpm test` passes | CI `check` job plus a local run |
| P0: `pnpm dev` runs web and game | Local curl of `:3000` and `:2567/health`. `/dev/net` shows ticks from the Colyseus room. |
| P0: replay hash is identical on two machines | CI matrix on ubuntu x64 and macOS arm64 with a diff job, plus this Mac, plus Chromium/Firefox/WebKit in Phase 1 |
| P0: placeholder glb, migrations, configs | The glb re-exports byte-identically and passes validate. PGlite migration tests pass. Docker builds and serves `/health` in CI. Fly and Vercel deploys are marked **unverified** (no CLIs or accounts linked). |
| P1: every move works with its listed frame data | Table-driven sim tests using the real baked hitboxes, plus captures of the debug overlay |
| P1: two people on one keyboard call it fun | 2P e2e test, a capture video, the ghosting tester. **Sammy plays it at review.** |
| P1: hero chicken imports with 21 clips and no console errors | The round trip through the hero export script, the messy-fixture test, and the e2e checks. The real hero .glb is one command away. |
| P1: 60 fps on an M1 Air and a 3-year-old Android | Local `/play?bench=1` on this Mac (p95 ≤ 16.7 ms, ≤ 40 draw calls). Android is approximated with Pixel emulation and 4× CPU throttling. **Sammy runs the bench on a real phone** at the LAN URL. |

## Deferred questions for Sammy
- **At the Phase 1 review:** every ★ above; installing KTX-Software; linking a Vercel project (for phone tests on preview URLs).
- **Phase 2:**
  - The tick-ahead limit ("+3" is too tight at 80 ms RTT).
  - Fly WebSocket routing (`fly-replay` or one app per region).
  - Snapshots must carry the full sim state.
  - Who writes `balance_checks`.
  - A Jupiter v3 key.
- **Phase 3:**
  - The launchpad: the spec names Meteora DBC but also mentions pump.fun.
  - Which GME mint.
  - Whether drawn matches pay.
  - The q-multiplier leaves out the "void over 30%" rule.
  - Switching payouts to GME needs SPL transfers and rent.
  - The write path for `/admin`.
  - A lawyer's read and the geo-block list before mainnet.
