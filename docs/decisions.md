# Decisions

Every non-obvious choice lives here. The spec (`docs/research/spec-extracted.txt`) is the
contract; anything below either fills a gap it left to Code or deviates from it with a
reason. ★ = Sammy should confirm at the Phase 1 review.

## Stack and versions (checked 2026-09-23)

| Decision | Why |
|---|---|
| Next.js **16.3**, not 15 | 15 only receives backports; soltendogs already runs 16.3. "Next.js on Vercel" (the locked decision) is unchanged. |
| Colyseus **0.18**, not 0.16 | 0.16 is tagged legacy. 0.18 has `setFixedTimestep`, `defineInput`, `QueueRoom` and `allowRewindState`, which match the Phase 2 netcode. The browser client is now `@colyseus/sdk` (`colyseus.js` stopped at 0.16). Room state uses the decorator-free `schema({...})` builder. |
| three **0.186.0** exact | Satisfies "r170+". Decoders are copied from this exact version into `/decoders/r186/`. |
| TypeScript **6.0**, not 7 | TS 7 (Go) has no JS API; typescript-eslint and Next's type check need one. |
| ESLint 9, Vitest 4, React 19.2.8 | The newer majors are too fresh for their plugin ecosystems (eslint-config-next plugins, R3F-era React pins). Upgrade each in its own PR. |
| pnpm 11.27.1 via `packageManager` | pnpm 12 is too new for Vercel and `pnpm/action-setup`. Vercel needs `ENABLE_EXPERIMENTAL_COREPACK=1`. |
| No turbo, no R3F, no drei, no `postprocessing` | Two dev processes and one test runner don't need turbo. The fighter needs a strict per-frame order (sim → presentation → render) that R3F makes hard to control; soltendogs hit several R3F bugs on this stack. |
| Plain three.js engine under `apps/web/src/game/` | React renders the page shell and the DOM HUD only. ESLint bans React imports in the engine. |

## Art pipeline

| Decision | Why |
|---|---|
| Export checklist rewritten ★ | "Group by NLA track" (`export_nla_strips`) has done nothing since Blender 3.6. Use: Mode = Actions, Export all Armature Actions, Always Sample, Merge Animation = NLA Track Names, Optimize, Set all glTF Animation Starting at 0, Custom Properties. The scripted `export_chicken()` in `art/blender/cf_common.py` applies these; the UI checklist is the fallback. |
| Draco quantization 14 / 10 / **12** (position / normal / texcoord) ★ | The spec's "14/10/8" read literally gives 8-bit UVs, about 8 texels of error on a 2k map. |
| `export_def_bones=True` | IK / control bones in a hand-made rig would otherwise count toward the 40-joint budget. |
| Hitbox helpers are baked offline | `tools` samples every clip at 60 Hz and writes integer tables to `packages/sim/data/hitboxes.json`. The sim and server never read a glb (determinism, no DOM). Helper sizes come from custom properties `cf_radius` / `cf_half_height`, because glTF does not export an empty's display size. |
| Sim frame f = clip sample f | Clip frame counts in `chicken.contract.json` equal the move's startup+active+recovery. Clips authored with a different split carry `cf_phases` and are remapped piecewise. |
| Tiers are runtime material swaps | Not `KHR_materials_variants`: GLTFLoader doesn't apply variants, and packing all tiers into one glb would defeat lazy loading. |
| Textures via `ktx create` (KTX-Software 4.4) | `toktx` is deprecated and not installable via Homebrew. Phase 1 uses flat materials, so `tools/textures.sh` only explains how to install it. |

## Gameplay defaults (data in `packages/sim/data/moves.json`)

| Topic | Default |
|---|---|
| Units | Position in mu = 1/1000 unit; HP ×100 (max 10000, so 10% chip is exact); Heat ×60 (max 6000, so 1/s decay is exactly 1 per tick); time in 60 Hz ticks. One division rule: truncate toward zero (`idiv`). |
| Input | 5-bit mask L/R/U/D/Space. Opposite directions held together cancel (SOCD). Attacks trigger on press with a 5-tick buffer that survives hit-stop. Jump is level-triggered. A dash is two presses of one direction within 12 ticks (200 ms); a third tap doesn't dash again. |
| Space priority ★ | Grounded: full Heat and not holding ↓ or toward → **super**; else ↓ → slam; toward → shove; else peck. Airborne (≥ 4 air ticks, height ≥ 0.9 u, once per jump) → dive kick. A peck that connects can cancel into shove or super on frames 5–10. |
| Blocking ★ | Holding ↓ while grounded blocks attacks from a grounded attacker (peck, shove, super) with 10% chip; chip can KO. Slam is unblockable (spec). **Dive kick is unblockable** (it is an air attack; "blocks all grounded attacks"). |
| Ring-out ★ | Walking, dashing, jumping and diving stop at \|x\| = 9.5 u. Only a *hit* from shove, slam or super can carry a fighter past 10 u. Ring-out counts as a KO. No suicide walk-offs in a money game; no peck-spam at the edge. |
| Rounds | 180-tick countdown, then 3600 ticks of fighting. "KO freeze 2 s" and "roundEnd 2 s" are the same 120 ticks. |
| Ties ★ | Timeout with equal HP → sudden death: 1800 ticks where the first clean (unblocked) hit or a ring-out wins. Sudden-death expiry and simultaneous KOs are drawn rounds. At most 5 rounds, so a match can end drawn (`matchWinner = 2`). Whether a draw pays is a Phase 3 question. |
| Heat ★ | +8 per hit landed, +3 per hit blocked (to the attacker), −1/s. **Latches at full** instead of decaying: otherwise "full" lasts under a second and the super can't be used on purpose. Resets every round. |
| Keyboard ★ | vs CPU: arrows + Space (the spec), with WASD + J as aliases. Two players on one keyboard: P1 = WASD + Space (alias F); P2 = arrows + `/` (aliases `.`, Enter, Numpad0). Ctrl / Meta / Alt / Shift are never bound (Cmd+W closes the tab). |

## Infrastructure

| Decision | Why |
|---|---|
| Supabase grants to `service_role` explicitly | Supabase projects created after 2026-05-30 no longer grant table access by default. |
| Migrations tested with PGlite | No Docker / Supabase CLI locally or in CI; PGlite runs real Postgres in WASM. PGlite is Postgres 18 and Supabase is 17, so nothing 18-only is used. |
| Game server = one esbuild bundle | The Docker runtime stage copies only `dist/`: no `node_modules`, no `pnpm deploy`. |
| `verifyDepsBeforeRun: false` | Filtered installs (CI replay job, Docker) must not trigger pnpm's automatic full reinstall on `pnpm run`. |
| Env vars added (documented only) | `JUPITER_API_KEY` (Price v2 is deprecated; v3 needs a key), `REDIS_URL` (the Colyseus Redis driver needs a TCP `rediss://` URL, not Upstash REST), `ALLOWED_ORIGINS`, `PAYOUTS_ENABLED=false`. |
