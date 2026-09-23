**Adversarial review of the COCKFIGHT Phase 0/1 draft plan: 30 fixes, most urgent first**

Most of what the plan says checks out. The problems below are either build-breakers, hazards to determinism, or places where the plan contradicts itself. Every fix says what to change and why. Where I checked a claim myself, I say how.

One process note: I made no project changes. While checking a file I briefly wrote a temp file (`/private/tmp/next_wcd.js`) outside the scratchpad. It was empty and I deleted it right away.

---

## A. Things that break the build or turn CI red

**1. Bake is used in Phase 0 but built in Phase 1.**
- `assets:bake --check` runs in `verify` and in CI's `check` job from P0.10.
- But `sample.ts` and `bake.ts` are only written in Phase 1 step 1.1.
- Fix: move `sample.ts`, `bake.ts` and `bake --check` into P0.8, right after the placeholder glb exists.
- Commit a real `hitboxes.json` in Phase 0 and drop the "empty clips" version.
- Also move validate v2's `source.sha256 == glb` check into P0.8. It's cheap, and without it hitboxes can drift from the model.

**2. P0.6 needs the model before P0.8 makes it.** The `/` page (Showcase) loads `chicken_placeholder.glb`, which P0.8 builds. Do P0.8 before P0.6. `chicken.contract.json` already exists from P0.2, so nothing else blocks the swap.

**3. The ESLint rules conflict with the hash code.**
- The sim-design hash uses `Math.floor(m/4294967296)`, but P0.1 bans `Math.floor` in `packages/sim/**`.
- Replace it with `(m / 4294967296) >>> 0`. I checked this against a BigInt FNV-1a-64 reference: 0 mismatches over 2,000 random inputs.
- Narrow the restricted-globals scope to `packages/sim/src/**`. Otherwise the bans on `process`, `performance` and `Date` hit `packages/sim/vitest.config.ts` and `perf.test`.
- Switch from a banned list to an allowed list. The current ban list misses `asin`, `acos`, `cbrt`, `log2`, `log10`, `fround` and others. Use:
  - `no-restricted-syntax: MemberExpression[object.name='Math'][property.name!=/^(abs|min|max|trunc|imul|sign|clz32)$/]`
  - `BinaryExpression[operator='**']`
  - `ForInStatement`
  - a `CallExpression` selector banning `Object.keys/values/entries` everywhere except `rules.ts`.

**4. Vitest will run the Playwright specs.**
- The root config's `projects: ["apps/*", …]` combined with Vitest's default include (`**/*.{test,spec}.*`) picks up `apps/web/e2e/*.spec.ts`, and `pnpm test` crashes.
- Fix: in the web Vitest config set `include: ["src/**/*.test.{ts,tsx}"]`, which is what soltendogs does.

**5. ESLint's ignore list doesn't fit a monorepo.**
- soltendogs' `globalIgnores([".next/**", "coverage/**", "next-env.d.ts"])` patterns are relative to the root, so they don't match `apps/web/.next`.
- `eslint --max-warnings=0 .` would then lint build output and fail.
- Use: `**/.next/**`, `**/dist/**`, `**/coverage/**`, `**/test-results/**`, `**/playwright-report/**`, `apps/web/next-env.d.ts`, `apps/web/public/decoders/**`, `art/blender/out/**`.

**6. The new CSP drops directives soltendogs needs.**
- soltendogs' `next.config.ts` uses `script-src 'self' 'unsafe-inline' blob:` plus `'unsafe-eval'` in dev. The comments explain why:
  - the App Router streams its data through inline scripts;
  - Turbopack's hot reload needs eval.
- The plan's `script-src 'self' 'wasm-unsafe-eval'` removes all of that. Even in Report-Only mode, every page load then logs `[Report Only]` violations.
- Chrome reports these as browser log entries at error level, and Playwright most likely surfaces them as console errors. That would fail every "zero console errors" check.
- Fix:
  - use soltendogs' directive plus `'wasm-unsafe-eval'`, and keep dev `ws: wss:` in `connect-src`;
  - have the e2e helper also count `securitypolicyviolation` events, so the policy is actually tested.

**7. CI end-to-end tests have no WebGL.**
- Ubuntu runners have no GPU. Chromium 151 then needs `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, or WebGL context creation fails. These are exactly soltendogs' `SOFTWARE` flags in its `playwright.config.ts`.
- Also set `workers: 1`.
- The plan only lists the Metal flags, for the perf project.

**8. The web typecheck runs before its route types exist.**
- `pnpm -r run typecheck` runs `tsc` in apps/web before `.next/types` has been generated.
- Next 16.3 type-checks by running the project's own `tsc`.
- Fix: make web's typecheck `next typegen && tsc --noEmit`, and keep `typescript` in apps/web's devDependencies (Vercel's filtered install needs it too).

**9. Root scripts depend on a root `tsx`.**
- Root scripts call `tsx tools/src/...`, so `tsx` must be a root devDependency.
- A filtered CI install (`--filter X...`) doesn't install root devDependencies.
- Fix: put the golden-replay runner in `packages/sim` with `tsx` as a devDependency there. The macOS job then installs only `--filter @cockfight/sim...`.
- This takes macOS install time from about a minute to a few seconds. macOS minutes are billed at 10×.

**10. The Dockerfile needs `ENV CI=true`.** The infra report's Dockerfile, which the plan adopts, leaves it out. The toolchain report says pnpm 11 needs it so no interactive prompt can hang the build.

## B. Determinism hazards

**11. The mirror-symmetry property test will fail as designed.**
- Pushbox separation splits the overlap as `idiv(o,2)` for one fighter and the rest for the other. When the overlap is odd, one side always gets the extra 1 mu.
- Under "swap the players and mirror", that becomes 3/4 in one run and 4/3 in the other, so the states differ.
- Fix: move each fighter by `(o+1)>>1`, which overshoots by at most 1 mu and is symmetric.
- Same problem in trades: the attacker's wall-excess push and the defender's push both write `slideV/slideT`, so whichever hit is applied second overwrites the first. That quietly favours whichever player is processed first. Fix: accumulate both hit records' slide contributions, then assign once.
- The `dx==0` tie-break by facing is fine; I checked that swap plus mirror preserves it.

**12. Slide distances can have remainders.**
- The wall-excess distance computed at hit time won't always divide evenly by the tick count.
- The rules check `dist % ticks == 0` only covers push values from `moves.json`, not computed ones.
- Fix: store the remaining distance (`slideRem`) plus a speed, and move `min(slideV, slideRem)` each tick.

**13. `rulesHash` isn't defined precisely.**
- "Canonical moves.json + hitboxes.json" leaves open what "canonical" means:
  - hashing the file text breaks on reformatting or CRLF line endings;
  - sorting keys hides a key reorder, which changes behaviour if anything iterates the object.
- Fix:
  - `compileRules` turns everything into arrays indexed by `Mv` / clip id;
  - `rulesHash` is the FNV hash of that compiled Int32 table;
  - the sim never iterates plain objects (enforced by the lint rule in fix 3).

**14. Tighten the hash-coverage tests.**
- Also check the top-level `MatchState` keys (minus `f`), not just the fighter's.
- Assert that `serialize(s).length` equals the expected field count.
- In test builds, assert `b !== 0` inside `idiv`: `(a/0)|0` silently returns 0.

**15. Add a `.gitattributes`.** Use `* text=auto eol=lf`, `*.glb binary`, `*.blend binary`, and `*.replay.json linguist-generated -diff`. This keeps JSON used in hashes safe from CRLF conversion.

**16. The random golden fixture will be about 1 MB.**
- Random inputs that change every tick for up to 28.5k ticks, stored as change events, come to roughly 2×28k entries per fixture, with a noisy diff on every re-bless.
- Fix: hold each random button mask for 1–30 ticks, or store `{gen:"xorshift", seed, ticks}` and expand it inside `runReplay`.

**17. Cross-engine replay checks are free on this machine.**
- Playwright 1.62.1's Firefox (1538) and WebKit (2336) builds are already in `~/Library/Caches/ms-playwright`, next to chromium and headless_shell 1234.
- Add `e2e/replay-engines.spec.ts`: run the goldens inside Chromium, Firefox and WebKit and compare hashes.
- V8 on x64 versus V8 on arm64 proves little. Phase 2 will run prediction in Safari.

**18. Consequences of the sim's `types: []` and ES2023-only lib.** There is no `console`, `TextEncoder` or `performance` in the sim. So:
- `compileRules` returns its list of fallback moves instead of logging it;
- `fnv1a32(matchId)` uses `charCodeAt` and rejects non-ASCII ids;
- `perf.test` moves to `tools`, or gets its own tsconfig with Node types.

## C. Version and API corrections (checked today)

**19. Two Colyseus pins are less than a day old.**
- `@colyseus/testing ^0.18.6` was published 2026-09-23 05:24 UTC and `@colyseus/tools ^0.18.4` at 05:26 UTC. Both break the plan's own "at least a day old" rule.
- pnpm's docs confirm that, when `minimumReleaseAge` isn't set explicitly, it silently falls back to the too-new version.
- Use `^0.18.5` and `^0.18.3`.
- Everything else checks out:

| Item | Status |
|---|---|
| next 16.3.6 | published 09-22 16:19 UTC, now old enough |
| @colyseus/core 0.18.15, schema 5.0.33, ws-transport 0.18.2, sdk 0.18.3 | fine |
| pnpm 11.27.1 | exists |
| TypeScript 6.0.3 | fits typescript-eslint 8.70.1's peer range `>=4.8.4 <6.1.0` |
| Actions | checkout v7.0.1, setup-node v7.0.0, pnpm/action-setup v6.1.0, upload-artifact v7.0.1, download-artifact v8.0.1 |
| sharp 0.35.4 | no install script |
| Colyseus core's peers (`@pm2/io`, `@colyseus/auth`, express, zod, ws-transport) | all optional, so none are auto-installed |

**20. Colyseus API changes (read from the 0.18.15 type declarations).**
- `setPatchRate` is deprecated; use `this.patchRate = 1000/20`.
- `setFixedTimestep((ctx: StepContext) => …, 60)` is correct as planned.
- In the testing package:
  - `waitForNextSimulationTick` is deprecated; use `waitForNextTimestep()`.
  - `boot(serverInstance)` ignores its `port` argument (always 2568).
  - When given a server instance, `boot` does not turn off `gracefullyShutdown`; it only does that for config objects.
- Fix: export a `makeServer(opts)` factory rather than a `defineServer` singleton created at import time. Tests then build a fresh server with `gracefullyShutdown: false`.

**21. Add two more items to the early `next build` check.**
- I confirmed three r186's `DRACOLoader` and `KTX2Loader` call `new URL(..., import.meta.url)` at module top level, so the planned check is right.
- A string `setDecoderPath` also sets `dep_js = draco_decoder.js`, which is only fetched when WebAssembly is unavailable. The planned copy list is fine.
- Also check, in the same build, that Turbopack accepts JSON import attributes (`with {type:"json"}`) coming from a transpiled workspace package.

**22. Cached decoder files will go stale.**
- `/decoders/*` is served `immutable` but has no version in its path. After a three upgrade, browsers keep the old wasm for a year.
- Copy to `/decoders/r186/…`, taking the version from three's `package.json`.

**23. Put copy-decoders inside the scripts.**
- pnpm 11 does run `pre*` scripts by default (`enablePrePostScripts` is true).
- But any direct `next build` call skips them.
- Use `"build": "node scripts/copy-decoders.mjs && next build"` and do the same for `dev`.

**24. Set `export_def_bones=True`.**
- The Blender report's settings use `False`; the glTF-runtime report uses `True`.
- With `False`, IK and control bones in Sammy's hero rig count toward the 40-joint budget.
- Use `True`, mark `root` as Deform, and have validate require `root` to be among the skin's joints.

## D. Phase 0 artifacts that contradict the Phase 1 sim

**25. Draws can't be stored.** The sim allows draws: double KO, sudden-death expiry, and the 5-round cap (`matchWinner=2`). But:
- the migration only allows `reason in ('ko','ringout','timeout','forfeit')` and requires `(ended_at is null) = (reason is null)`, so a drawn match can't be written;
- the shared zod schemas cap rounds at 3 (`MatchResult.rounds.max(3)`, `Snapshot.round.max(3)`);
- `PHASES = ['waiting','countdown',…]` is off by one against the sim's `Phase.countdown = 0`.

Fix now, because migrations are a Phase 0 deliverable:
- add a `'draw'` reason with `winner` null, and allow up to 5 rounds;
- derive the shared enums from the sim's constants;
- or leave `Snapshot` and `MatchResult` out of Phase 0 entirely (see fix 26).

## E. Scope creep to cut

**26. Phase 0 FightRoom.**
- Stepping the sim, `validate(InputMsg)`, an 11-field schema and `writeSnapshot` are Phase 2 protocol. The plan itself says Phase 2 must send the full Int32Array instead, so this work would be thrown away.
- Keep only a `tick`/`phase` room that `/dev/net` displays, and make `/dev/*` return `notFound()` in production.
- Defer:
  - `net.ts` `Snapshot`/`MatchResult`;
  - the worker env schema (lamports, bps, stringbool);
  - `db.ts` row types and the column snapshot test.
- Keep the migrations and the grant/RLS tests.

**27. Phase 1 features the spec doesn't ask for.**

| Cut | Keep instead / why |
|---|---|
| Adaptive quality | The spec asks only for a low-quality toggle |
| Planar projected shadow of the skinned mesh | Blob shadows are enough |
| Key remapping | Keep the ghosting tester |
| 4 variants per sound | 1 variant plus pitch jitter |
| Lazy loading of non-Rust tiers | Flat materials have nothing to lazy-load |
| Diamond entrance effects | — |
| PauseMenu settings | Keep Resume, Restart, Quit, Mute |

Keep `?bench=1`, which the Android acceptance check needs.

**28. The fast-check budget is too big for every run.**
- 200 runs × up to 30k ticks × 7 properties, several of which run twice or rewind, adds minutes to every `pnpm test`.
- Default to 50 runs and at most 6k ticks. Use `SOAK=1` for 200 runs / 30k ticks in a separate CI job.

## F. Verification gaps

**29. Frame-data tests can pass even when attacks never reach.**
- Assert that `compileRules().fallbacks` is empty once hitboxes are baked.
- Add a sim test with the real baked placeholder: starting at ±2500, walk in and land a peck.
- Add a validate rule: during each attack's active samples, its hit helper must be in front of `hurt_body`.
- Without these, the frame-data tests pass with geometry that never connects.

**30. Pin the clip-frame convention and make the placeholder clips match.**
- Pin it: sim frame f maps to clip sample f, where sample 0 is the pose before the input.
- Author the placeholder clips to match `moves.json`, so the mapping is the identity:
  - shove is authored as [8,4,14] = 26 frames, but `moves.json` has 8/3/16 = 27;
  - the land clip is 8 frames, but landing lag is 4 ticks.

**31. The hero import is only tested on a clean, script-built file.**
- Add a "messy .blend" fixture script that mimics UI-authored habits:
  - actions not on NLA tracks;
  - a 24 fps scene;
  - frame_start = 1;
  - a stray `Action`;
  - a non-deform control bone;
  - empties with a display size but no `cf_radius`.
- Assert that `export_chicken.py` either fixes each one or fails with the exact hint.
- In the placeholder round trip, compare only `clips`: `source.sha256` changes whenever the glb bytes do.

**32. PGlite has never been run.** Make `migrations.test` the first step of P0.7. The infra report couldn't run it. Check specifically:
- `refresh materialized view concurrently`;
- `set role` together with RLS;
- `alter default privileges for role postgres`.

**33. PR captures won't render as planned.**
- PR bodies don't resolve relative paths, and a webm in a private repo won't play inline.
- Use absolute links of the form `https://github.com/sammythayermusic-ship-it/cockfight/blob/<sha>/docs/captures/…?raw=true`, pointing at PNG or GIF files. ffmpeg is at `/opt/homebrew/bin/ffmpeg`.
- Link the webm files rather than embedding them.

**34. Squash-merging PR #1 would break PR #2.**
- If #1 is squash-merged, #2 retargets to main but still carries the Phase 0 commits, which causes conflicts.
- Say "merge commit, not squash" in PR #1's body, or rebase afterwards: `git rebase --onto main phase-0-scaffold phase-1-fighter`.

**35. Limit the macOS replay job.** With the sim-only install from fix 9, it costs about 10 billed minutes per push instead of 20. Also run it only when `packages/sim/**` or `pnpm-lock.yaml` change.

---

Files referenced:
- Spec: `/Users/samthayer/.claude/projects/-Users-samthayer-Library-Application-Support-Claude-scratch-workspaces-91621548-4b89-4455-b3f7-36c68eaadb27-a5528d0a-317c-4efc-9ddf-27b3781fafdc-scratch-2026-09-23-c83513/d6dfe493-e1d7-4cf7-bd2b-2427ead14763/tool-results/brqdk8myk.txt`
- `/Users/samthayer/soltendogs/next.config.ts`
- `/Users/samthayer/soltendogs/playwright.config.ts`
- `/Users/samthayer/soltendogs/eslint.config.mjs`
- `/Users/samthayer/soltendogs/vitest.config.ts`
- `/Applications/Blender.app/Contents/Resources/5.2/scripts/addons_core/io_scene_gltf2/__init__.py`

Sources: [pnpm dependency-resolution settings](https://pnpm.io/settings/dependency-resolution) · [pnpm build settings](https://pnpm.io/settings/build) · [pnpm other settings](https://pnpm.io/settings/other) · [Next.js 16.3](https://nextjs.org/blog/next-16-3) · [Next.js TypeScript config](https://nextjs.org/docs/app/api-reference/config/typescript) · [pest issue #1929 on CSP report-only console messages](https://github.com/pestphp/pest/issues/1929) · Colyseus type declarations via jsDelivr (`@colyseus/core@0.18.15`, `@colyseus/testing@0.18.5`, `@colyseus/schema@5.0.33`) · `three@0.186.0` DRACOLoader, KTX2Loader and Clock source via jsDelivr.
