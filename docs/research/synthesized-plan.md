# COCKFIGHT build plan: Phase 0 (scaffold) and Phase 1 (the local fighter)

All versions below were checked on 2026-09-23 with `npm view`, the GitHub API, the jsDelivr copies of Colyseus 0.18.15 and `create-colyseus-app@0.18.1`, and the local soltendogs install.

## 1. Key decisions

### 1.1 Pinned versions

All versions live in the `catalog:` section of `pnpm-workspace.yaml`. Packages reference them as `catalog:`, and internal packages as `workspace:*`.

| Area | Pin | Why |
|---|---|---|
| Package manager | `"packageManager": "pnpm@11.27.1"` | Your local pnpm 11.0.9 fetches and runs the pinned version automatically. pnpm 12 is too new for Vercel and `pnpm/action-setup`. |
| Node | `.nvmrc` = `22.22.2`; `engines.node` = `"22.x"` | Colyseus 0.18 needs Node 22 or newer. An exact Node version keeps the float math in the bake step reproducible. |
| Web | `next` 16.3.6, `eslint-config-next` 16.3.6, `react`/`react-dom` **19.2.8**, `@types/react*` ^19.2.0 | Same major as soltendogs. React 19.2.8 is its known-good version. Upgrade to 19.3 later in its own PR. |
| 3D | `three` **0.186.0 exactly**, `@types/three` 0.186.0 exactly | The Draco and Basis decoders are copied out of this exact version, and three.js breaks APIs every release. |
| TypeScript | **`~6.0.3`** | typescript-eslint 8.70.1 needs `>=4.8.4 <6.1.0`. TypeScript 7 has no JavaScript API. Fall back to `~5.9.3` if Next's type check objects. |
| Lint | `eslint` ^9.39.5, `typescript-eslint` ^8.70.1 | The react, import and jsx-a11y plugins bundled with eslint-config-next only support ESLint 9. |
| Test | `vitest` and `@vitest/coverage-v8` ^4.1.11; `fast-check` ^4.10.2; **`@playwright/test` 1.62.1 exactly** | Playwright 1.62.1 matches the `chromium-1234` browser already cached in `~/Library/Caches/ms-playwright`, so nothing needs downloading. Vitest 5 is three weeks old. |
| UI | `zustand` ^5.0.15 (UI state only), `tailwindcss` and `@tailwindcss/postcss` ^4.3.3 | |
| Validation | `zod` ^4.6.5 | Peer dependency of `@colyseus/core` 0.18. |
| Server | `@colyseus/core` ^0.18.15, `@colyseus/schema` ^5.0.33, `@colyseus/ws-transport` ^0.18.2, `express` ^5.2.1, `@types/express` ^5.0.6. Dev only: `@colyseus/testing` ^0.18.6, `@colyseus/sdk` ^0.18.3 (also used by web), `@colyseus/tools` ^0.18.4 (a peer of testing only) | See 1.3. |
| Assets | `@gltf-transform/{core,extensions,functions}` ^4.5.0, `draco3dgltf` ^1.5.7, `gltf-validator` 2.0.0-dev.3.10 | |
| Data and infra | `@electric-sql/pglite` ^0.5.8, `smol-toml` ^1.9.0, `bs58` ^6.0.0 | |
| Build | `tsx` ^4.23.15, `esbuild` ^0.28.2, `@types/node` ^22.20.4 | |
| GitHub Actions | `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`, `actions/upload-artifact@v7`, `actions/download-artifact@v8` | All checked against their latest release tags. |

**Not used:** turbo, R3F, drei, the `postprocessing` library, Howler, the umbrella `colyseus` package, `@colyseus/tools` at runtime, and Git LFS.

**pnpm 11 rules to follow:**
- **Never set `minimumReleaseAge`.** The default already holds back anything published in the last 24 hours, and setting it explicitly makes installs fail whenever no version in range is old enough. Keep every lower bound at a version that is at least a day old.
- **Build scripts need approval.** Use `allowBuilds: { esbuild: true, unrs-resolver: true, msgpackr-extract: false }`. The pure-JS msgpackr fallback is fine for us. If the first install names other packages, copy the exact names from its error.
- **`.npmrc` holds only registry settings.** Everything else goes in `pnpm-workspace.yaml`.

### 1.2 Stack choices
- **Plain pnpm workspaces with no turbo.** Workspace globs are `apps/*`, `packages/*` and `tools`. Internal packages ship TypeScript source (`"exports": {".": "./src/index.ts"}`) with no build step.
- **Dependency direction.** `sim` depends on nothing. `shared` depends on `sim`. `solana` depends only on `bs58`. The apps depend on `sim` and `shared`. `tools` depends on `sim`.
- **The web game uses plain three.js, not React Three Fiber.** The game code lives under `apps/web/src/game/` with no framework dependency, and ESLint bans React imports there. React handles only the page shell and the HUD.
  - The per-frame order has to be strict: step the sim, then presentation, then render. R3F makes that order hard to control.
  - soltendogs hit several R3F bugs on this same stack.
- **Rendering uses `WebGLRenderer` (WebGL2) with a custom KO pass.** The pass copies the framebuffer into a texture, costs GPU time only during the 0.6 s KO pulse, and needs no composer.
- **Audio is procedural WebAudio.** Sounds are rendered once with `OfflineAudioContext` into `AudioBuffer`s, and Sammy's files drop into the same buffer map later.
- **The sim is integer fixed-point.** `step(prev, b1, b2, R=RULES)` is pure (it clones internally), matching the spec's signature.
  - Visual and audio events come from a separate pure function, `deriveEvents(prev, next)`, in `sim/src/events.ts`.
  - Events are not part of the state and are not hashed. This covers what the renderer needs without changing `step`.
- **Hitboxes are baked offline.** `tools` samples each clip of the glb every tick and writes integer tables to `packages/sim/data/hitboxes.json`. The sim and the server never read a glb.
- **Animation clip timing comes from the Blender file.** Each clip's authored phase split is stored as action custom properties (`cf_phases`) and baked into `hitboxes.json` as per-clip `marks`.
  - `moves.json` can override them with `clipMarks`.
  - The sim and the renderer both call `clipSample(move, frame)` from `sim/src/anim.ts`, so the visuals always line up with the hitboxes.
- **The placeholder chicken is built by a headless Blender script and committed as a glb.** CI never runs Blender.
- **Supabase migrations are hand-written SQL, tested against PGlite in vitest.**
- **The game server is one esbuild bundle containing every dependency.** The Docker runtime stage copies only `dist/`, with no `node_modules` and no `pnpm deploy`.

### 1.3 Deviations from the spec
1. **Next 16.3.6, not 15.** The 15 line only receives backports; soltendogs already runs 16.3.
2. **Colyseus 0.18, not 0.16.** 0.16 is tagged legacy. The browser client is now `@colyseus/sdk`, since `colyseus.js` stopped at 0.16.22.
   - 0.18 has built-ins that match the spec's netcode: `setFixedTimestep`, `defineInput`, `onDrop`/`onReconnect`, `QueueRoom`, and `COLYSEUS_LATENCY` for simulating lag.
   - Room state uses the decorator-free `schema({...})` builder.
   - A Schema can hold at most 63 fields.
3. **three.js r186** satisfies the spec's "r170+".
4. **The Blender export checklist is rewritten** (in `docs/art-pipeline.md`, plus a UI preset and the export script):
   - The "Group by NLA track" box (`export_nla_strips`) does nothing since Blender 3.6. Use Mode = Actions, "Export all Armature Actions", Always Sample, and Merge Animation = NLA Track Names.
   - Turn Optimize on, and turn on "Set all glTF Animation Starting at 0" and Custom Properties (`export_extras`). The last two are new requirements.
   - Draco quantization becomes position 14 / normal 10 / texcoord **12** / color 8 / generic 12. At 8 bits, UVs are off by about 8 texels on a 2k map. ★ Sammy to confirm.
5. **Hitbox helpers are read by an offline bake,** not per clip at runtime. The size of each helper comes from custom properties (`cf_radius`, `cf_half_height`), because glTF does not export an empty's display size.
6. **Heat stops decaying while full** (it "latches"). With decay of 1 per second and no latch, full Heat would last less than a second.
7. **Tiers are material swaps done in three.js at runtime,** not `KHR_materials_variants`. GLTFLoader doesn't apply variants, and packing all four tiers into one glb would break lazy loading of the non-Rust tiers.
8. **Textures use `ktx create` from KTX-Software 4.4.2, not `toktx`.** `toktx` is deprecated and there is no Homebrew formula. Phase 1 uses flat materials, so `tools/textures.sh` only exits with install instructions.
9. **Supabase projects created after 2026-05-30 need explicit grants,** so the migration grants `service_role` itself. The key values will look like `sb_publishable_…` and `sb_secret_…`, but the variable names stay as in the spec.
10. **New env vars, documented only:** `JUPITER_API_KEY` (Price v2 is deprecated; v3 needs a key), `REDIS_URL` (the Colyseus driver needs a TCP `rediss://` URL), `ALLOWED_ORIGINS`, and `PAYOUTS_ENABLED=false`.

### 1.4 Spec ambiguities and the chosen defaults
Every row goes in `docs/decisions.md`. ★ marks the ones Sammy should confirm at the Phase 1 review.

| Topic | Default |
|---|---|
| Units | Position in mu = 1/1000 unit; HP ×100 (max 10000); Heat ×60 (max 6000); time in ticks at 60 Hz. The one division rule is `idiv = (a,b) => (a/b)\|0`. Booleans are stored as 0/1. |
| Input | Stays a 5-bit mask `B={L:1,R:2,U:4,D:8,S:16}`. L+R held together counts as neither; U+D counts as neither. Attacks trigger on the press with a 5-tick buffer that doesn't drain during hit-stop. Jump is level-triggered. A dash is two presses of the same direction within 12 ticks (a third tap doesn't dash again). |
| Space priority (grounded) | Full Heat, not holding ↓ and not holding toward the opponent → **super** ★. Otherwise ↓ → slam; toward → shove; else → peck. In the air (after 4 air ticks, height ≥ 900, once per jump) → dive kick. After Space: dash > jump > block > walk > idle. A peck that connects can cancel into shove or super on frames 5–10. |
| Block | Holding ↓ while grounded blocks attacks from a grounded attacker (peck, shove, super) with 10% chip, truncated; chip can KO. Slam is unblockable. **Dive kick is unblockable** because it is an air attack ★. |
| Knockdown | Slam and super launch the defender at (160, 180). The launched fighter has no hurtbox (no juggles), then lies down for 40 ticks and gets up over 20 ticks, invulnerable throughout. |
| Ring-out | Walking, dashing, jumping and diving stop at \|x\| = 9500. Only a *hit* from shove, slam or super can carry a fighter past 10000 ★. Ring-out counts as a KO. |
| Rounds | 180-tick countdown (outside the 60 s), then 3600 ticks of fighting. The KO freeze and roundEnd are the same 120 ticks. The timer doesn't pause for hit-stop. |
| Ties | Timeout with equal HP → sudden death: 1800 ticks where the first clean (unblocked) hit or a ring-out wins ★. A simultaneous KO is a draw. At most 5 rounds, then the match can end in a draw (`matchWinner=2`). Whether a draw pays is a Phase 3 question. |
| Heat | +480 to the attacker on hit, +180 to the attacker on block, −1 per tick while fighting, latched at max, reset every round. Super costs 6000 and gives no Heat. |
| Hitbox helpers | `hurt_body` and `hit_beak` are required. Other `hit_*` empties are optional and picked per move with `hitNode`. The placeholder animates every attack beak-first. |
| Two players, one keyboard | vs CPU: arrows + Space (the spec), with WASD + J as aliases. 2P: P1 = WASD + Space (alias F); P2 = arrows + `/` (aliases `.`, Enter, Numpad0). Never bind Ctrl, Meta, Alt or Shift (Cmd+W closes the tab; Shift pressed five times opens Sticky Keys on Windows) ★. |
| Tier in Phase 1 | Set with `?tier=` or the mode-picker dropdown. A mirror match gives P2 a hue-shifted palette. |
| Starting spots | x = ±2500, facing each other. |

### 1.5 Move data for `moves.json`
Frame 1 is the tick the input is processed, so the first active frame is startup + 1.

**Movement and body:**
- Walk: 60 mu/tick forward, 45 back.
- Jump: vy = 270 with gravity 15 (y += vy, then vy −= G), which gives exactly **36** airborne ticks and an apex of 2565 mu on ticks 18–19. Horizontal speed 55 forward, 45 back. 4 ticks of landing lag.
- Dash: 12-tick input window, 12 ticks long, invulnerable on ticks 3–6. Forward is 160 mu/tick for 9 ticks; back is 150 for 8.
- Pushbox: half-width 400, height 1200. A fighter higher than 1200 passes over the other.

| Move | Startup / active / recovery | Damage | Hitstun / blockstun | Hit-stop | On hit | Blockable | Ring-out |
|---|---|---|---|---|---|---|---|
| peck | 4 / 2 / 8 | 600 | 14 / 8 | 3 | push 300 over 6 ticks (240 on block) | yes | no |
| shove | 8 / 3 / 16 | 400 | 24 / 12 | 3 | push 2000 over 10 ticks (1000 on block) | yes | yes |
| slam | 14 / 4 / 22 | 1800 | knockdown | 8 | launch (160,180); grounded targets only | no | yes |
| dive_kick | 6-tick hover / active until landing (max 40) / 14 on landing | 1000 | 18 | 3 | velocity (±180,−180); push 400 over 8 ticks; attacker bounces (−40,150) | no | no |
| super | 10 / 6 / 30 | 3000 | knockdown, blockstun 20 | 8 | launch; hits anyone below y 1800 anywhere; invulnerable frames 1–16 | yes (300 chip) | yes |

`rules.ts` validates the data (with zod, only in tests and tools, so the sim runtime stays zod-free):
- every frame count is a positive integer;
- push distance divides evenly by push ticks;
- `vy === G·airTicks/2`;
- every clip name is in the contract.

`rulesHash` is the FNV-1a-64 hash of the canonical `moves.json` plus `hitboxes.json`.

## 2. Repo tree after Phase 1

```
cockfight/
├─ package.json  pnpm-workspace.yaml  pnpm-lock.yaml  .nvmrc  .npmrc(registry only)
├─ tsconfig.base.json  eslint.config.mjs  vitest.config.ts  .gitignore  .dockerignore  .env.example
├─ README.md  CLAUDE.md  AGENTS.md
├─ docs/ decisions.md changelog.md plan.md art-pipeline.md controls.md captures/{phase-0,phase-1}/
├─ .github/workflows/ci.yml
├─ art/blender/ cf_common.py build_placeholder_chicken.py export_chicken.py presets/cockfight_glb.py README.md  (out/ gitignored)
├─ apps/web/  package.json next.config.ts tsconfig.json vercel.json postcss.config.mjs vitest.config.ts playwright.config.ts AGENTS.md
│  scripts/copy-decoders.mjs
│  public/models/chicken_placeholder.glb   public/audio/manifest.json   public/decoders/{draco,basis}/ (gitignored)
│  e2e/{smoke,fight-2p,cpu-match,assets,hud,perf}.spec.ts  e2e/support/{debug.ts,perf.ts}
│  src/env.public.ts
│  src/app/{layout.tsx,page.tsx,globals.css}  src/app/play/{page.tsx,PlayClient.tsx,ModePicker.tsx}  src/app/dev/net/page.tsx
│  src/components/hud/{FightHud,HpBar,HeatMeter,Timer,RoundPips,Banner,PauseMenu,MatchEnd,FpsMeter,KeyTester}.tsx hudStore.ts
│  src/components/site/Hero.tsx
│  src/game/engine/{createFightEngine,loop,quality,perf,bench,assets,debug}.ts
│  src/game/match/{LocalMatch.ts, input/{keyboard,bindings,source,cpuSource}.ts}
│  src/game/view/{FightView.ts, chicken/{ChickenView,materials,blend}.ts, camera/{FightCamera,shake,noise}.ts,
│                 arena/{Junkyard,crowd,fires,env,sky,merge}.ts, shadows/{blob,planar}.ts, debug/HitboxOverlay.ts}
│  src/game/fx/{director,fxTable,Particles,HitFlash,KoPulse}.ts
│  src/game/audio/{AudioEngine,manifest,offline}.ts  recipes/{metal,scream,crowd,horn,bell,ui}.ts
│  src/game/showcase/Showcase.ts   src/game/react/{FightView,ShowcaseCanvas}.tsx
├─ apps/game/  package.json tsconfig.json build.mjs Dockerfile fly.toml vitest.config.ts
│  src/{index,app.config,state,snapshot}.ts  src/rooms/{FightRoom,LobbyRoom}.ts  scripts/smoke.ts  test/fightRoom.test.ts
├─ apps/worker/ package.json tsconfig.json build.mjs Dockerfile fly.toml src/index.ts test/worker.test.ts
├─ packages/sim/  package.json tsconfig.json vitest.config.ts
│  data/{moves.json,hitboxes.json,chicken.contract.json}
│  src/{index,fixed,constants,types,input,rules,state,fighter,physics,collide,combat,round,step,events,anim,rng,hash,serialize,replay,cpu}.ts
│  test/*.test.ts  test/helpers/{dsl,run,freeze}.ts  test/golden/*.replay.json
├─ packages/shared/ src/{index,constants,net,env,db}.ts test/
├─ packages/solana/ src/index.ts test/
├─ supabase/ config.toml README.md migrations/{20260923000000_init.sql,20260923000100_cron.sql}
└─ tools/ package.json tsconfig.json vitest.config.ts textures.sh
   src/assets/{config,validate,bake,sample,inspect}.ts  src/blender/run.ts  src/replay-golden.ts  src/db/harness.ts  src/root.ts
   test/{validate,bake,bakeParity,migrations,infra}.test.ts
```

**Root scripts.** They call `tsx tools/src/...` directly rather than going through nested `pnpm --filter`, which keeps stdout clean for the CI diff. Paths resolve from the repo root via `tools/src/root.ts`.

- `dev`: `pnpm --parallel --filter @cockfight/web --filter @cockfight/game run dev`
- `build`, `lint` (`eslint --max-warnings=0 .`), `typecheck` (`pnpm -r --parallel run typecheck`), `test` (`vitest run`), `test:e2e`, `test:perf`
- `replay:golden [--bless]`
- `assets:placeholder`, `assets:export`, `assets:validate`, `assets:bake [--check]`, `assets:import` (export, then validate, then bake)
- `textures`
- `verify` = lint + typecheck + test + assets:validate + `assets:bake --check` + build

## 3. Git and GitHub flow

The GitHub account is `sammythayermusic-ship-it`, and no `cockfight` repo exists yet.

```
mkdir ~/cockfight && cd ~/cockfight && git init -b main
# commit 0 on main: README stub + .gitignore only
gh repo create sammythayermusic-ship-it/cockfight --private --source . --remote origin --push
git switch -c phase-0-scaffold    # small logical commits, one per step below
git push -u origin phase-0-scaffold
gh pr create --base main --head phase-0-scaffold --title "Phase 0: scaffold" --body-file <scratchpad>/pr0.md
git switch -c phase-1-fighter     # cut from phase-0-scaffold
gh pr create --base phase-0-scaffold --head phase-1-fighter --title "Phase 1: the local fighter" --body-file <scratchpad>/pr1.md
```

- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Both PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Nothing gets merged; Sammy reviews both PRs.
- If PR #1 needs fixes after phase 1 has branched: commit on `phase-0-scaffold`, run `git rebase phase-0-scaffold` on the phase-1 branch, then `git push --force-with-lease`.
- When #1 merges and its branch is deleted, GitHub retargets #2 to `main` automatically.
- Watch CI with `gh pr checks --watch`.
- `gh` can't upload attachments, so screen captures are committed under `docs/captures/phase-N/` (webm or png, each under about 2 MB) and linked from the PR body.
- **CI cost:** macOS runner minutes count 10× on private repos. The replay job takes about 2 minutes, so roughly 20 billed minutes per push. Only the replay job runs on macOS.

## 4. Phase 0, in order

**P0.1 Root setup.**
- **Files:**
  - `package.json` (scripts above)
  - `pnpm-workspace.yaml` (packages, allowBuilds, catalog)
  - `.nvmrc`, `tsconfig.base.json` with every TypeScript 6 default set explicitly: `target`/`lib` ES2023, module ESNext, `moduleResolution: Bundler`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `resolveJsonModule`, `noEmit`, `types: []`
  - `vitest.config.ts` (projects `packages/*`, `apps/*`, `tools`; v8 coverage over `packages/sim/src/**`)
  - `eslint.config.mjs`
  - `.gitignore`: `.next`, `dist`, `coverage`, `test-results`, `*.tsbuildinfo`, `apps/web/public/decoders`, `art/blender/out`, `.env*`, with an exception for `!.env.example`
  - `.dockerignore`
  - `CLAUDE.md` (run commands plus pitfalls, as in soltendogs)
  - `docs/decisions.md`, `docs/changelog.md`, `docs/plan.md`
- **eslint.config.mjs details:**
  - `nextVitals` and `nextTs` are scoped to `apps/web/**` with `settings.next.rootDir: "apps/web/"`; `tseslint.configs.recommended` applies everywhere else.
  - `packages/sim/**`: `no-restricted-properties` bans `Math.random`, `sqrt`, `sin`, `cos`, `tan`, `atan2`, `pow`, `exp`, `log`, `hypot`, `round`, `floor`, `Date.now` and `performance.now`. `no-restricted-globals` bans `window`, `document`, `process`, `setTimeout`, `requestAnimationFrame` and `Date`. `no-restricted-imports` bans three, colyseus and zod.
  - `apps/web/src/game/**`: `no-restricted-imports` bans react, except under `react/`.
  - The `react-hooks/immutability: off` override stays for the imperative folder.
- **Verify:** `pnpm install` succeeds (fix `allowBuilds` from the error if not), then `pnpm lint`.

**P0.2 `packages/sim` skeleton.**
- **Files:**
  - `fixed.ts`: `idiv`, `mulDiv`
  - `constants.ts`
  - `types.ts`: `B`, `St`, `Mv`, `Phase` and `Reason` as `as const` objects; `FighterState` and `MatchState` (the full field list from the sim design, so the Phase 1 hash layout is stable)
  - `rng.ts`: xorshift32 seeded with `fnv1a32(matchId) || 0x9E3779B9`
  - `hash.ts`: FNV-1a-64 over two 32-bit lanes on a fixed `FIELDS` order
  - `serialize.ts`: to and from `Int32Array`
  - `state.ts`: `createMatch({seed, matchId})`, `resetRound`, `clone` (`{...s, f:[{...f0},{...f1}]}`)
  - `input.ts`: edge detection and opposite-direction cleaning
  - `round.ts`: countdown, then fighting, then timeout, sudden-death stub, roundEnd and matchEnd, including the 5-round cap
  - `physics.ts`: walk, facing auto-flip, wall clamp, pushbox
  - `step.ts`, `replay.ts` (`runReplay(r, R)` returns `{state, hash, cps}` and throws if `rulesHash` doesn't match), `rules.ts`
  - `data/moves.json` with the full 1.5 data, and `data/chicken.contract.json` (the 21 clips with name, frames, loop and phases; the helpers and their shapes; the material slots; the budgets of 15k triangles and 40 bones)
  - `data/hitboxes.json`, first version with empty clips, so the fallback boxes are used
  - `test/golden/walk-timeout.replay.json` (a scripted run using the DSL in `test/helpers/dsl.ts`, e.g. `[["R",30],["S",1],…]`)
  - `test/golden/random-3rounds.replay.json` (seeded random 5-bit inputs through a full match)
  - `tools/src/replay-golden.ts`: prints `<name> <ticks> <hash>`, exits 1 on a mismatch, and rewrites `finalHash` plus a checkpoint every 60 ticks with `--bless`
- **Tests:**
  - `fixed.test` (truncation is mirror-symmetric; no −0)
  - `hash.test` (the two-lane FNV matches a BigInt reference on 2,000 random inputs; `Object.keys(fighter)` equals `FIELDS`)
  - `serialize.test` (round-trip)
  - `purity.test` (`step` on a deep-frozen `prev`)
  - `round.test` (180 / 3600 / 120 tick exactness; a timeout match ends)
  - `golden.test` (imports the replay JSON; no Node APIs)
  - `rules.test`
- **Verify:** `pnpm --filter @cockfight/sim test` and `pnpm replay:golden`.

**P0.3 `packages/shared` and `packages/solana`.**
- **shared:**
  - `constants.ts`: `TICK_RATE` 60, `SNAPSHOT_HZ` 20, `INPUT_DELAY` 2, `BUFFER` 6, `MAX_AGE` 30, `GRACE_S` 10, the tier USD thresholds
  - `net.ts`: `InputMsg = z.strictObject({t: z.uint32(), b: z.int().min(0).max(BUTTON_MASK)})`, `Snapshot`, `MatchResult`
  - `env.ts`: the infra zod schema, with `clean()` so an empty `FOO=` falls through to its default, `z.stringbool()` for `PAYOUTS_ENABLED`, and literal `process.env.NEXT_PUBLIC_*` references on the web side
  - `db.ts`: zod row types for each table
- **solana:** interfaces only (`BalanceGate`, `PriceSource`, `FeeClaimer`, `Swapper`, `PayoutSender`), plus `tierForUsd` and `isValidAddress` (bs58-decodes to 32 bytes).
- **Tests:** env parsing (defaults, `"false"` parses as false, the bps refine), `tierForUsd` boundaries, address validation.

**P0.4 `apps/game`.**
- **Files:**
  - `src/app.config.ts`: `defineServer({ greet:false, transport:new WebSocketTransport({server:http.createServer()}), rooms:{lobby:defineRoom(LobbyRoom), fight:defineRoom(FightRoom)}, express:(app)=>app.get('/health',…) })`, importing from `@colyseus/core` (all of these exports are confirmed there)
  - `src/index.ts`: `await server.listen(env.PORT, '0.0.0.0')`
  - `src/state.ts`: `schema()` builder
  - `rooms/FightRoom.ts`: `maxClients 2`; inputs checked with `validate(InputMsg, …)`; `setPatchRate(1000/20)`; `setFixedTimestep(() => {sim = step(sim, btn[0], btn[1]); writeSnapshot(...)}, 60)`
  - `build.mjs`: esbuild with bundle, platform node, target node22, ESM, output `dist/server.mjs`. External: `bufferutil`, `utf-8-validate`, `msgpackr-extract`, `@pm2/io`, `@colyseus/uwebsockets-transport`, `@colyseus/bun-websockets`. Add the banner ``import{createRequire as r}from'node:module';const require=r(import.meta.url);``.
  - `scripts/smoke.ts`: copies `dist/` to a temp directory, spawns it, polls `/health`, then `POST /matchmake/joinOrCreate/lobby` and expects `sessionId`
  - `Dockerfile` and `fly.toml` from the infra design (`iad`, `auto_stop_machines="off"`, `/health` check, `kill_timeout` 300, `shared-cpu-1x` 1gb)
- **Scripts:** `dev` = `tsx watch --clear-screen=false src/index.ts`.
- **Test:** `test/fightRoom.test.ts` with `@colyseus/testing`: `boot(server)` → `createRoom('fight')` → two `connectTo` → `send('input', {t:0, b:B.R})` → `waitForNextSimulationTick()`. Assert that `state.tick` advanced and that P1's x changed once the countdown is over.

**P0.5 `apps/worker` skeleton.** A Node HTTP server on `/health`, port 8080. It parses `workerEnv`, logs `PAYOUTS_ENABLED=false`, and contains no chain code. It has its own esbuild `build.mjs`, a Dockerfile, and a `fly.toml` with no `http_service` and `[checks.alive]` pointing at `/health`. Deploy it with `--ha=false`.

**P0.6 `apps/web`.**
- **Next.js setup:** Next 16 app router with Tailwind 4 (copy `postcss.config.mjs` from soltendogs).
- **`next.config.ts`:**
  - `transpilePackages: ['@cockfight/sim','@cockfight/shared','@cockfight/solana']`, `devIndicators:false`
  - soltendogs' security headers plus a `Content-Security-Policy-Report-Only` header:
    - `script-src 'self' 'wasm-unsafe-eval'`
    - `worker-src 'self' blob:`
    - `connect-src 'self' ${NEXT_PUBLIC_GAME_WS_URL}`
  - `/decoders` served `immutable`. Models are *not* immutable; they load as `?v=<hitboxes.source.sha256[0:8]>`.
- **`scripts/copy-decoders.mjs`:** copies `draco/gltf/draco_wasm_wrapper.js` and `draco_decoder.wasm`, plus `basis/basis_transcoder.{js,wasm}`, into `public/decoders/`. It runs as `predev` and `prebuild` (not postinstall, because Vercel's install is filtered).
- **`vercel.json`:** `regions ["iad1"]`; `installCommand` = `pnpm install --frozen-lockfile --filter @cockfight/web...`; the `ignoreCommand` from the infra design. The web app lists its own `typescript`.
- **Pages:**
  - `/`: a placeholder hero whose `ShowcaseCanvas` loads `chicken_placeholder.glb` through singleton `GLTFLoader` + `DRACOLoader` (`/decoders/draco/`) and plays `idle`.
  - `/play`: a stub.
  - `/dev/net` (dev only): joins `fight` with `@colyseus/sdk` and shows the tick counter, which proves web and game talk end to end.
- **Bundler risk, check it first:** three r185+ loaders call `new URL('../libs/draco/…', import.meta.url)` at module top level (confirmed in the 0.185.1 source).
  - Run a real `pnpm --filter @cockfight/web build` as soon as the loaders are imported.
  - If Turbopack fails on `fs`/`path`, run `pnpm patch three@0.186.0` to replace the six `new URL(...)` defaults with plain strings, and record the patch in `pnpm-workspace.yaml` under `patchedDependencies`.
- **Commit** the `AGENTS.md` that `next dev` writes.

**P0.7 Supabase.**
- **Files:**
  - `supabase/config.toml` (`major_version=17`, seed disabled)
  - `migrations/20260923000000_init.sql`: 8 tables; checks enforced in SQL; RLS on with no policies; the `leaderboard_v` materialized view plus a unique index; the `pool_v` owner-rights view; revokes from `anon`/`authenticated`; explicit `service_role` grants; `next_attempt_at` and `last_error` on `payouts`
  - `migrations/20260923000100_cron.sql`: guarded by `pg_available_extensions`
  - `tools/src/db/harness.ts`: `freshDb('legacy'|'strict')` creates the three roles itself; `as(db, role, fn)`
- **Test:** `tools/test/migrations.test.ts`, the 8 cases from the infra design run under `describe.each(['legacy','strict'])`, plus a column snapshot to catch drift from the zod types.
- **Avoid** anything only Postgres 18 has (`uuidv7`, virtual generated columns); PGlite runs 18 while Supabase runs 17.

**P0.8 Placeholder chicken and `assets:validate` v1.**
- **Blender scripts:**
  - `art/blender/cf_common.py`:
    - `EXPORT_KWARGS` exactly as in the Blender research.
    - `export_chicken(out)` asserts: fps = 60; object mode; the set of armature actions equals the 21 contract clips (fail on a stray `Action`); both helpers exist with their extras.
    - It then selects Rig and its descendants, clears the active action, and exports to a temp file followed by `os.replace`.
    - Finally it reads the glb back and prints `CF_REPORT {json}`.
  - `build_placeholder_chicken.py`:
    - Starts from `read_factory_settings(use_empty=True)`.
    - Builds 16 bones (all +Z, roll 0) from the contract, and beveled bmesh parts rigidly weighted with `vertex_groups.add(...,1.0,'REPLACE')`, `mesh.parent=rig` and an Armature modifier. No operators that need a UI window.
    - Materials `cf_shell`, `cf_trim`, `cf_eye`, `cf_beak`, `cf_comb`, with `use_backface_culling=True`.
    - `hurt_body` (capsule, radius .40, half-height .42, parented to `body`) and `hit_beak` (sphere, radius .14, parented to `head`).
    - All 21 clips via the Blender 5.x channelbag API. Every bone gets keys in every clip; NLA track name = action name = clip name; `cf_phases` stored on each action.
    - Optional `--blend` and `--preview` outputs.
- **Runner:** `tools/src/blender/run.ts` looks for `$BLENDER`, then `/Applications/Blender.app/Contents/MacOS/Blender`, then `blender` on PATH, and runs `-b --factory-startup --python-exit-code 1 --python <script> -- <args>` with `spawnSync`, passing the exit code through.
- **`tools/src/assets/validate.ts`, v1 rules:**
  - The file parses with NodeIO, all extensions and the Draco decoder; `gltf-validator.validateBytes` reports 0 errors.
  - Only allowed extensions are used; node names are unique and sanitizable.
  - `Rig` has identity TRS; `root` is the top joint.
  - Exactly one skinned mesh; ≤ 40 joints; ≤ 15k triangles (via `getGLPrimitiveCount`).
  - Both helpers carry their extras.
  - The clips are exactly the 21 names, with near-miss hints (`peck-Rig`, `Peck`, `walk.fwd`, Levenshtein ≤ 2).
  - Each clip starts at 0, its duration × 60 is a whole number, and there is no root motion.
  - Bounding box and facing are sane.
  - With `--json` it prints machine-readable output.
- **Verify:**
  - `pnpm assets:placeholder` twice gives byte-identical output (`git diff --exit-code`).
  - `pnpm assets:validate` passes.
  - `validate.test.ts` checks that the committed glb passes and that in-memory mutations fail: a renamed clip, a moving root, missing extras, and a joint count pushed over the budget.

**P0.9 Infra tests.** `tools/test/infra.test.ts` parses both `fly.toml` files with smol-toml and checks the ports, the `/health` paths, `auto_stop_machines`, and that the worker has no `http_service`. Also add `.env.example`, the README (local setup, env table, deploy commands, "unverified" markers), and `supabase/README.md` with the three expected advisor warnings.

**P0.10 CI (`.github/workflows/ci.yml`).**
- **Common settings:** `env CI=true`, `permissions: contents: read`, and a per-ref concurrency group with cancel-in-progress.
- **Jobs:**
  - `check` (ubuntu): install with `--frozen-lockfile`, then lint, typecheck, test, `assets:validate`, `assets:bake --check`, `pnpm --filter @cockfight/web build`, and the game build plus smoke.
  - `replay` (matrix ubuntu-latest x64 and macos-latest arm64): full install, then `pnpm -s replay:golden > replay-hashes.txt`, which exits non-zero on a mismatch with the committed hashes. Upload the output as an artifact.
  - `replay-compare`: downloads both artifacts, checks there are exactly two, diffs them, and writes the hashes to the step summary.
  - `docker` (ubuntu): `docker build -f apps/game/Dockerfile .`, run it, and curl `/health` in a retry loop. Do the same for the worker.

**P0.11 Verify and open PR #1.**
- Run `pnpm verify`.
- Run `pnpm dev` in the background, curl `localhost:3000` (200) and `localhost:2567/health`, and open `/dev/net` to confirm the tick climbs. Then stop it.
- The Playwright `smoke.spec.ts` (under a `phase0` tag) checks that `/` renders the canvas with zero console errors and saves `docs/captures/phase-0/landing.png`.
- Save a Blender contact sheet to `docs/captures/phase-0/placeholder_contact.png`.
- Push, open the PR, and wait for green CI.

## 5. Phase 1, in the spec's fun-first order

Each step ends with `pnpm verify`, Playwright captures, a commit, and a changelog entry. If the rules change, re-bless the golden replays in the same commit with `pnpm replay:golden --bless` and give the reason in the commit message.

### 1.1 Sim, placeholder and keyboard: peck, walk, block, HP
- **sim:**
  - `input.ts`: buffer, taps, `dashReq`
  - `fighter.ts`: idle, walkF, walkB, block, blockStun, attack, hitStun, following the action priority in 1.4
  - `collide.ts`: `capsuleHitsCircle` with the bounding-box early-out (without it, products pass 2^53)
  - `combat.ts`: detect both directions, *then* apply both; chip; freeze both fighters for the hit-stop; stun; push slide; `hitDone`; `hitT`/`hitMv`/`hitKind`
  - `anim.ts`: `clipFor(f)` and `clipSample(move, frame)`
  - `events.ts`: `deriveEvents`
- **tools:**
  - `sample.ts`: STEP, LINEAR (slerp) and CUBICSPLINE samplers
  - `bake.ts`: poses the gltf-transform nodes, reads `getWorldMatrix()`, and projects to the 2D plane (sim x = glTF +Z, sim y = +Y). It writes `{v, hz:60, units:1000, forward:"+Z", source:{file, sha256}, clips:{name:{n, marks, hurt:[ax,ay,bx,by,r]×n, hit:{hit_beak:[x,y,r]×n}}}}`, rounding with `Math.round(v*1000)+0`.
  - `bake --check` re-bakes and diffs exactly.
- **web:**
  - `engine/loop.ts`: 60 Hz accumulator, at most 5 catch-up steps, a 250 ms clamp, vsync snap, render interpolation
  - `LocalMatch`
  - `keyboard.ts`: `e.code`, a press latch, ignore `repeat`/`isComposing`, `preventDefault` on bound keys, release everything on blur and when the page is hidden
  - `bindings.ts`
  - `FightView` with a flat floor and a fixed camera
  - `ChickenView`:
    - `SkeletonUtils.clone`, `frustumCulled=false`, materials cloned per fighter
    - facing via `rotation.y = ±π/2` (never negative `scale.x`)
    - `pose()` sets `action.time`, then weights that sum to 1, then `mixer.update(0)`. Never use `crossFadeTo` or `setTime`.
    - Blending is tracked in the view, counted in sim ticks.
  - `HitboxOverlay` (`?debug=1` or H), drawn from `hitboxes.json`, with a frame-data readout
  - Minimal DOM HP bars
  - `window.__cockfight`:
    - Read-only: `state()`, `events()`, `perf`, `audio.recent`, `fx.live()`, `assets()`.
    - Behind `?debug=1`: `setInput`, `stepTicks(n)`, `pause`, `resume`, `loadReplay`.
  - `?manual=1` stops the sim's rAF loop so e2e tests can step it deterministically.
- **Tests:**
  - A table-driven test over peck: whiff returns to idle after exactly 14 ticks; hits land on frames 5–6 but not 4 or 7; hitstun, blockstun and hit-stop (3 frozen ticks) are exact; one hit per move.
  - Chip is exactly 60.
  - Walk speed, cross-up facing, SOCD, a buffered press survives hit-stop.
  - `bake.test`, and `bakeParity.test`, which uses three.js `GLTFLoader` + `AnimationMixer` on a Draco-stripped copy as an oracle, within ±1 mu.
  - `e2e/fight-2p.spec.ts` presses real keys (`KeyD`, `Space`) interleaved with in-page `stepTicks`, never wall-clock timing (a soltendogs lesson). It asserts P2's HP drops from 10000 to 9400, and captures the overlay.

### 1.2 Jump, dive kick, slam, shove, dash, then the CPU
- **sim:**
  - the jump arc (36 air ticks), fall, land plus 4 ticks of lag
  - dive gating, the 6-tick hover and the diagonal velocity
  - slam launch → knockdown 40 → getup 20 (invulnerable); the launched state has no hurtbox
  - shove slide, with any excess near the wall pushing the attacker back
  - double-tap dash with invulnerability on ticks 3–6, and back dash
  - pushbox pass-over in the air, and facing flips on landing
  - clip mapping for all 21 clips (back dash plays `dash` reversed; ring-out reuses `fall`)
- **CPU:** `sim/src/cpu.ts`, `cpuThink(s, side, mem, cfg) → mask`.
  - It has its own xorshift seeded from `matchId+":cpu"` and reacts to the opponent as they were a few ticks ago: easy 22 ticks / 30% block, normal 14 / 60%, hard 8 / 85%.
  - Behaviors: space itself, block startups it sees, punish whiffs, shove near the wall, super on the opponent's recovery, and occasionally jump into a dive kick.
  - The web side wraps it in `cpuSource.ts`.
- **Golden fixtures:** add `every-move.replay.json` (DSL-scripted) and `cpu-seed{1..5}.replay.json`.
- **Tests:**
  - The table-driven frame tests extended to every attack.
  - Jump: exactly 36 non-grounded ticks, apex 2565 on ticks 18–19, y = 0 on step 37, forward and back jump distances.
  - Dash: a 12-tick gap dashes and 13 doesn't; a triple tap gives one dash; a peck timed to each dash frame 1–12 whiffs only on frames 3–6.
  - Dive: its gates; \|vx\| == \|vy\|; 14 ticks of landing recovery.
  - Slam hits grounded targets only.
  - Shove moves the defender exactly 2000 in open space and 1000 on block, clamped at the wall.
  - fast-check properties (200 runs, up to 30k ticks of random input):
    - every field is an integer, with no NaN or −0
    - values stay in bounds
    - running twice gives the same hash every tick
    - `prev` is never mutated
    - rewinding to tick k and replaying gives the same hash
    - mirror symmetry: swap the players and the L/R bits, and the state mirrors
    - the match always ends
  - CPU: deterministic per seed, and CPU vs CPU always finishes.
  - `e2e/cpu-match.spec.ts` (`?mode=demo&seed=1&manual=1&debug=1`) steps until `matchEnd`.

### 1.3 Juice: hit-stop, shake, particles, placeholder sounds
- **`director.ts` and `fxTable.ts`:** one table maps each event kind to its sounds, particles, shake trauma, camera punch and crowd hype.
- **Hit-stop visuals:** hit-stop is sim-owned, so the view never advances its own animation clock. During it, the victim vibrates ±0.04 u based on tick parity, interpolation is off, and a 2-tick white emissive flash plays. Particles and shake keep running.
- **`FightCamera`:**
  - framing computed from the horizontal FOV (vertical FOV ~30°)
  - smoothed dolly and pull-back
  - trauma-based shake: trauma² scaled by seeded value noise, with a directional kick
  - `prefers-reduced-motion` defaults shake to 0.3
- **`Particles.ts`:** instanced quads, not `Points`.
  - Two meshes: additive for sparks and flames, and alpha-tested cutout for screws, feathers and dust.
  - Ring-buffer pools: sparks 512, screws 96, feathers 96, dust 64, flames 144.
  - Updates only on emit, using `addUpdateRange`; per frame only the `uTime` uniform changes.
  - Spawn seeds come from `hash(seed, tick, idx)`, so replays look identical.
- **Audio:**
  - `AudioEngine`: sfx, crowd and ui buses into a master compressor; stereo panning by x.
  - Buffers are pre-rendered during loading with `OfflineAudioContext`; the context resumes on the FIGHT click.
  - At most 4 voices per sound; the variant and ±5% pitch jitter come from `hash(seed, tick)`.
  - Recipes: metal hits, screams per damage tier, crowd loop and swell, KO horn, bell, UI sounds. Reuse soltendogs' `synth.ts` helpers (rng, noiseBuffer, env) but output `AudioBuffer`s.
  - `manifest.ts` exports a `SoundName` union. Files under `public/audio/<name>[_N].m4a` override the procedural sound when present.
- **Tests:** shake determinism, particle ring ranges, fxTable covers every event kind, every `SoundName` has a recipe, the loop's catch-up cap. In e2e, a hit adds `hit_light` and `scream_light` to `audio.recent` and `fx.live() > 0`, with a screenshot mid-hit-stop.

### 1.4 Heat and super, ring-out, rounds, timer, HUD
- **sim:**
  - Heat: ×60 units, latched at max.
  - Super: neutral Space at full Heat; invulnerable frames 1–16; hits anyone below y 1800 anywhere; costs the whole meter.
  - Ring-out: `roAble` set by a ring-out move, then `|x| > 10000`; the fighter keeps falling with no floor, clamped at y ≥ −20000.
  - KO, double KO → draw, timeout, sudden death (1800 ticks), maximum 5 rounds.
  - Hit detection is off during roundEnd; physics keeps running with inputs forced to 0.
- **HUD (DOM):**
  - Hot values (HP, damage trail, Heat) are written straight to `style.transform` by the director. Cold values use a `useSyncExternalStore` store.
  - Damage trail: `transition: transform 350ms ease-in 500ms`.
  - Heat meter pulses and shows "SUPER READY" when full.
  - Timer is `ceil(t/60)` and pulses red under 10 s; 2 round pips per side.
  - Banners: 3 / 2 / 1 / FIGHT!, ROUND N, K.O.!, RING OUT!, TIME!, PERFECT.
  - `PauseMenu` (Esc or P; focus trap) and `MatchEnd` (Rematch, Change mode).
  - `ModePicker`: vs CPU (Easy/Normal/Hard), 2P local, Controls (a `KeyTester` panel that shows ghosting, and remapping saved to localStorage inside try/catch), plus a debug tier picker.
  - Display font Bungee via `next/font`. `touch-action:none` only on the fight container.
- **Tests:**
  - Heat: decays 60 per 60 ticks, latches, resets.
  - Super: needs the latched full meter; neutral Space at full Heat is super, not peck; beats a peck during its invulnerable frames; hits across the arena and misses a fighter jumping over it.
  - Ring-out from x = 8.5 with shove and 6.5 with slam; pecks never ring out.
  - Round scenarios: 2–0 and 2–1 wins, timeout, sudden death, sudden-death expiry draw, double-KO draw, 5-round cap.
  - `hud.spec.ts` screenshots the countdown, FIGHT!, K.O., RING OUT! and the match-end screen.

### 1.5 Hero import path, tier materials, arena, camera
- **Hero import:**
  - `art/blender/export_chicken.py` uses the same `export_chicken()` as the placeholder, so the UI checklist becomes the fallback. Also ship `presets/cockfight_glb.py`.
  - `pnpm assets:import --blend art/chicken.blend` exports to `public/models/chicken.glb`, then validates, then bakes.
  - `hitboxes.json.source.file` decides which glb the runtime loads, so visuals and hitboxes can't drift apart.
- **validate v2 adds:**
  - every `moves.json` clip exists in the glb and in the hitboxes file, and `source.sha256` matches the glb
  - texture rules (all KTX2, ≤ 2048, power of two, correct color transfer function) and arena rules (≤ 60k triangles, `TEXCOORD_1` for the lightmap); both skip when there are no textures or arena
  - a per-file table of total first load, which must be ≤ 12 MB
  - animation byte sizes
- **Tier materials (`materials.ts`), swapped by material name:**
  - `cf_shell`, `cf_trim` and `cf_eye` change per tier; `cf_beak` and `cf_comb` stay fixed.
  - Rust uses metalness 0.6, roughness 0.8. Chrome uses 1 / 0.12. Gold uses 1 / 0.25 with color (1, .78, .34). Diamond uses `MeshPhysicalMaterial` with `iridescence:1`.
  - The environment map comes from `PMREMGenerator.fromScene` of a mini junkyard scene.
  - Tier flags: Chrome leaves a dash trail, Gold throws double sparks, Diamond plays the `entrance` clip with extra effects.
  - Non-Rust tiers are loaded lazily.
- **Procedural junkyard arena (0 bytes of assets):**
  - pit floor with hazard stripes and a drop-off lip at ±10
  - three-high walls of stacked cars; tire stacks; bleachers
  - 6 oil drums with flickering fire glow and 2 point lights
  - 240 crowd sprites in one instanced draw, driven by a hype uniform
  - floodlight cones and a sky dome
  - geometry baked into vertex colors on `MeshBasicMaterial`, with fog; shadows off
  - blob contact shadows, plus a planar projected shadow on the high tier
  - a swap path for Sammy's `arena.glb` via named empties (`fire_*`, `crowd_*`, `ringedge_L/R`)
- **Camera and effects:**
  - KO: a 0.5 s push-in toward the loser plus `KoPulse` (chromatic aberration, flash and vignette, pre-compiled at load).
  - Super: a −3° FOV kick.
- **Quality and performance:**
  - Quality tiers: high caps DPR at 1.5; medium at 1.25; low at half resolution with particles off (the single hit-flash billboard stays).
  - Adaptive quality starts after the first countdown and steps down if 3 of 6 one-second windows average under 50 fps.
  - Prewarm shaders with `renderer.compileAsync` with every effect visible; set `renderer.info.autoReset=false`.
  - FPS meter via `?fps=1` or F3; `?bench=1` bench mode.
- **Landing page:** `/` shows two idle chickens in the Showcase, lazy-loaded after first paint and paused when off-screen.
- **Verify:**
  - Local only (needs Blender): save the placeholder as `art/blender/out/placeholder.blend`, run `export_chicken.py` on it, validate, bake, and confirm the same clip set and a bit-identical `hitboxes.json`. This proves the hero import path end to end.
  - `assets.spec.ts` asserts 21 clips from `__cockfight.assets()` and zero console errors, and screenshots all four tiers.

### 1.6 Hardening and PR #2
Run `pnpm verify`, the full e2e suite and the local perf project. Record captures and bench numbers. Update the README, `docs/controls.md` and `docs/art-pipeline.md`, add a `docs/decisions.md` entry for every ★ item, then open PR #2.

## 6. Test list
- **`packages/sim`:**
  - fixed, hash, serialize, purity, input (edges, SOCD, buffer, dash taps), walk, jump, dash
  - attacks (table-driven from `moves.json`), block, slam, shove, dive, super, heat, round, edges and pushbox, events, rules (schema, 21 clip names, `rulesHash` stability, fallback reporting), cpu
  - `properties.test` (fast-check), `golden.test`, and `perf.test` (average `step` time under 50 µs over 30k ticks, a loose ceiling so CI isn't flaky)
- **`packages/shared` and `packages/solana`:** env, net schemas, tiers, addresses.
- **`apps/game`:** `fightRoom.test` (@colyseus/testing), plus `smoke` against the built bundle.
- **`apps/worker`:** env parsing and `/health`.
- **`apps/web` (vitest, node environment):** loop step counts, keyboard latch, bindings, camera framing clamps, shake determinism, particle ring ranges, fxTable coverage, audio manifest, hudStore.
- **`tools`:** `validate.test`, `bake.test` (the `--check` path), `bakeParity.test` (three.js oracle), `migrations.test` (PGlite in strict and legacy grant modes), `infra.test`.
- **Playwright (`apps/web/playwright.config.ts`):**
  - The `chromium` project runs against `next start -p 3100`: smoke, fight-2p, cpu-match, assets, hud.
  - The `perf` project runs locally only (see section 7). It needs `--use-angle=metal --ignore-gpu-blocklist --enable-gpu`.
  - CI adds an `e2e` job in Phase 1 (`playwright install --with-deps chromium`, functional project only).

## 7. How each acceptance criterion is shown

| Criterion | How it is shown | Fully shown here? |
|---|---|---|
| P0: `pnpm test` passes | CI `check` job plus a local run | Yes |
| P0: `pnpm dev` runs web and game | Local run: curl `:3000` and `:2567/health`, and `/dev/net` shows ticks. CI proves the builds and the bundle smoke test. | Yes, locally |
| P0: replay gives an identical hash on two machines | CI matrix on ubuntu x64 and macOS arm64, with a diff job, plus the local Mac as a third | Yes |
| P0: placeholder glb, CI, migrations, configs | The committed glb re-exports byte-identically and passes validate. PGlite tests pass. Docker builds and serves `/health` in CI. | Fly and Vercel deploys are not run (no CLIs and no accounts linked); they are marked "unverified" |
| P1: every move works with its listed frame data | Table-driven sim tests plus the debug overlay's frame readout, with captures | Yes |
| P1: two people on one keyboard call it fun | Real-key 2P e2e test, the ghosting tester, a 2P capture video. Sammy and a friend have to play it at review. | Needs Sammy |
| P1: hero chicken imports with all 21 clips and no console errors | The placeholder is built from the same contract and round-tripped through the hero export script; e2e checks 21 clips and zero console errors. With the hero file, it's one command: `pnpm assets:import --blend art/chicken.blend`. | Needs the hero asset |
| P1: 60 fps on an M1 Air and a 3-year-old Android | Local bench `/play?bench=1&tier=high` on Sammy's Apple Silicon Mac: p95 ≤ 16.7 ms, ≤ 40 draw calls, ≤ 150k triangles, ≤ 24 shader programs, 0 new programs after the countdown. Android is approximated with Pixel 7 emulation and 4× CPU throttling, results reported only. Sammy opens `/play?bench=1&tier=medium` on a real phone at the LAN URL (`pnpm --filter @cockfight/web dev -H 0.0.0.0`) and pastes the copied results into the PR. | Needs a real phone and M1 Air |

## 8. Pitfalls to keep in mind
- **Blender:** `--python-exit-code 1` is mandatory; without it a Python error exits with 0. Put `--factory-startup` before the .blend path. Stray actions leak into the export as extra clips. Use underscores only in names (`sanitizeNodeName` mangles `.`). Helpers must hang off deforming bones.
- **three.js:**
  - `mixer.update(0)` doesn't loop or clamp, so the view must wrap loop clips and clamp one-shot clips itself.
  - Clone per fighter with `SkeletonUtils.clone`, never plain `.clone()`.
  - The engine owns its canvas and calls `forceContextLoss()` on dispose; never reuse that canvas. This makes StrictMode double mounts safe.
  - `dynamic(..., {ssr:false})` only works inside a `'use client'` file.
  - Never use drei's `useGLTF` (it pulls three-stdlib and the gstatic Draco).
- **Sim:** no float division, `Math.round` or `JSON.stringify` hashing. Resolve both hit directions before applying either. Freeze the buffer and stun counters during hit-stop, but keep reading edges.
- **Colyseus:** pass an explicit `WebSocketTransport` with an `http.Server` so the bundle works. Listen on `0.0.0.0` (Fly needs it). Never import the umbrella `colyseus` package or `@colyseus/tools` in the runtime bundle.
- **Next.js:** reference public env vars as literal `process.env.NEXT_PUBLIC_X` (dynamic lookups aren't inlined). On Vercel, set `ENABLE_EXPERIMENTAL_COREPACK=1` and Root Directory `apps/web`.
- **Tests:** drive keyboard e2e by stepping ticks inside the page, never by wall-clock timing.

## 9. Open questions for Sammy

**At the Phase 1 review (★ items):**
- Super on neutral Space at full Heat.
- Dive kick unblockable; super blockable.
- Heat latching at max.
- Ring-out only from hits.
- Sudden-death and draw rules.
- Keyboard layout.
- Draco texcoord quantization of 12 bits.
- Whether to install KTX-Software 4.4.2 (a pkg installer).
- Linking a Vercel project, so preview URLs work for phone tests.

**Phase 2:**
1. Where the tick-ahead limit comes from. "Server tick + 3" rejects a client that predicts about 10–20 ticks ahead at 80 ms RTT. Also, Colyseus's built-in `defineInput` and prediction versus the hand-rolled protocol.
2. Fly WebSocket routing, since anycast can land a connection on a machine that doesn't hold the room: `fly-replay` versus one app per region. Upstash needs a TCP `rediss://` URL for the Colyseus driver; one global Redis or one per region?
3. Phase 2 snapshots must carry the full serialized sim state (a raw `Int32Array` message), because the spec's partial field list can't be rewound deterministically.
4. Who writes `balance_checks` and who does the match-start re-check, given "game never calls Helius". Proposal: the game server writes rows from the JWT claims and calls an internal web route with a shared secret.
5. Jupiter Price v3 key; the curve-quote fallback comes from the DBC or DAMM pool, not pump.fun.

**Phase 3:**
1. The exact launchpad: pump.fun leftovers versus Meteora DBC. Who owns the config (the partner and creator fee split), `migrationFeeOption: 6` so the 3% fee survives graduation, and a nonzero permanently locked liquidity share, which DAMM v2 fee claims need.
2. Which GME: the meme coin `8wXt…iHsB` or the xStocks GMEx, which is jurisdiction-restricted and possibly Token-2022. This also has legal weight.
3. Does a drawn match pay?
4. The payout `q` multiplier leaves out the "over 30% dropped inputs voids the payout" tier. The P_min floor contradicts "never promises more than fees deliver".
5. "Switch to GME payouts is one flag" is false: it needs SPL transfers and recipient token-account rent of about 0.002 SOL each.
6. The web app has no write path for `/admin` actions: give it a scoped key or proxy through the worker.
7. Get the lawyer read and settle the geo-block list before mainnet.
