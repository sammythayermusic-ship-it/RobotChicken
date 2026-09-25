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
| Textures via `ktx create` (KTX-Software 4.4) | `toktx` is deprecated. `pnpm textures` converts `art/textures/<tier>/*.png`: colour maps ETC1S (sRGB, BT.709), data maps UASTC + RDO + zstd (linear, never gamma-decoded), normals as plain RGB (not `--normal-mode`, which three.js can't read). `--dry-run` output is tested; validate rejects two-channel normals. |

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

## Phase 1: the local fighter

| Decision | Why |
|---|---|
| `step()` is pure and clones internally | Rollback (Phase 2) keeps a history of states; storing references must be safe. Three shallow copies per tick cost ~1 µs. |
| Both hit directions are detected, then applied | Trades are symmetric; a fast-check property proves swapping the players mirrors every state exactly. In a trade, getting hit beats a dive kick's bounce. |
| Knockback slides accumulate, then assign once; `slideRem` carries remainders | Order-independent and exact even when a wall shortens a push. |
| Pushbox split rounds up for both fighters | `(overlap+1)>>1` each: symmetric under mirroring (the overshoot is at most 1 mu). |
| Hit-stop freezes the fighter completely | Stun, buffer, slide and Heat decay all pause, so a hit-stop can't eat a buffered press and the meter reads exactly +8 after a hit. |
| Walls stop outward motion only | A fighter left beyond 9.5 u by a ring-out hit that fell short stays there (no teleport) and can walk back in. |
| No floor past the ring edge | Anyone beyond ±10 u falls, so a KO'd chicken carried out of the pit drops out of sight. Mid-round, that can only be a ring-out. |
| A round ended by KO starts its 120-tick clock on the next tick | Same timing as a timeout. |
| CPU lives outside `step()` | It reads the state and returns buttons, seeded from the match id; a CPU match replays from its input log alone. Difficulty = reaction delay (22 / 14 / 8 ticks) and block / punish rates. |
| Presentation events are derived, not stored | `deriveEvents(prev, next)` diffs two states; events never enter the hash, and replays produce the identical event stream. |
| The animation mixer is posed from sim state | `action.time` from `(state, stTick)` + `mixer.update(0)`; blends and turns count sim ticks. Hit-stop freezes the pose exactly. |
| Camera shake is seeded value noise on the tick counter | Replays shake identically at any frame rate. `prefers-reduced-motion` defaults it to 30%. |
| KO chromatic aberration is a copy-the-framebuffer pass | Costs GPU only during the 0.6 s pulse; a composer would cost every frame on phones. Prewarmed at load. |
| GPU particles: instanced quads, motion in the vertex shader | CPU work only when a burst is emitted; per frame only `uTime` changes. Low quality keeps just the hit flash. |
| HUD: hot bars written straight to the DOM, cold values in a store | React never re-renders at 60 Hz. Meters keep a whole-percent `aria-valuenow`. |
| Tier cosmetics | Chrome: dash light trail. Gold: double sparks on hits. Diamond: iridescent physical material. Mirror matches tint P2 (hue shift, or copper for grey tiers). Gold's KO sting and Diamond's name chant / entrance wait for Sammy's sound pack and hero model. |
| Perf is measured from FIGHT | Loading and shader warm-up don't count. `/play?bench=1` runs a fixed-seed CPU match on any device and prints copyable percentiles. |
| Determinism is checked in three JS engines | The golden replays run in Chromium, Firefox and WebKit (e2e) as well as Node on x64 and arm64 (CI). |
| Audio renders on the FIGHT click; autostart links create it at mount | WebAudio needs a user gesture. From the picker, FIGHT creates and starts it (first-exchange sounds ready ~40–110 ms later, all 30 within ~370 ms). Autostart links (`/play?mode=…`) create it under LOADING and start it on the first key, tap or click. Bench and manual runs are silent. |
| Every sound is loudness-levelled after rendering | Peak ≤ 0.89 or a fixed short-term loudness, whichever is quieter, so `SOUND_SPECS` gains compare like with like; the KO moment is deliberately the loudest. Heavy thumps start at 140–170 Hz so phone and laptop speakers reproduce them. |
| Sound pack drop-in: `public/audio/manifest.json` | `{"hit_light": "hit_light.m4a"}`; listed files replace recipes, failures fall back to the recipe. No 404 probing. |
| Arena shaders are custom (three's fog / tone-mapping chunks) | Static light is baked into vertex attributes, but the fire light is per-pixel from shared uniforms, so walls and floor flicker in sync with the fighters' point lights. 7 draw calls, ~17k triangles. |
| The env-map scene is brighter behind the camera | Otherwise chrome / gold reflect the dark pit and read as black paint. |
| Fog and the far plane follow the camera distance | Portrait views pull the camera ~75–95 u back to keep both fighters in frame; fixed fog would swallow them. |
| Hero import resamples authored attack phases onto the contract | The sim reads frames and phases from the contract, so a hero clip with a different `cf_phases` split is retimed phase by phase at export. `--retime` stretches 24 fps clips within one authored frame of the contract length. |
| Dive kick without `cf_phases` is checked against its 30-frame clip | Its active window has no fixed length in the sim (active until landing). |
| First load = art assets that load before FIGHT (glb, decoders, audio overrides) | Must stay ≤ 12 MB. App JS/CSS/fonts are excluded, so leave headroom; non-Rust tiers and arena extras are lazy. |
## Phase 0 review outcomes

An adversarial review (5 area reviewers, each finding independently re-verified) confirmed 32 low/medium issues; all were fixed before PR #1. The choices worth remembering:

| Decision | Why |
|---|---|
| The golden gate checks every checkpoint plus a whole-trajectory hash | After `resetRound` the final state only reflects the last round; a divergence in rounds 1–4 would have passed the cross-machine diff. |
| `SIM_VERSION` is part of `rulesHash` | The hash covered data, not code. Bump it whenever `step()` behaviour changes (same commit as the golden re-bless). |
| Rule values are read as checked int32s | A float, typo or missing field used to hash identically and leak into state. `RULES` is frozen. |
| Moves pick their hit helper by `hitNode` | The data field existed but was ignored; now it resolves per move and fails if the baked helper is missing. |
| Clips are sampled at `Math.fround(f / 60)` | That is the exact float32 key time the exporter writes; three.js and the bake then agree even on STEP curves. |
| A chicken must be centered | Root bone at the origin; `hurt_body` at idle frame 0 within 0.02 u of it in x/z. Extra (non-skinned) meshes are errors: the spec says one skinned mesh. |
| Entry gate: `tierForUsd(usd, GATE_USD_MIN)` | One source of truth for the gate; anyone past it is at least Rust. |
| Game server runs one machine (`--ha=false`) until Phase 2 | Rooms live in memory; matchmaking and the WebSocket join must reach the same machine. |
| `matches.reason` adds `sudden_death` and `decision` | A match can be won on rounds at the 5-round cap after a drawn final round. The sim → reason mapping is in `supabase/README.md`. |
| Daily payouts: one per address per day, linked to `daily_rewards` by (id, address, lamports) | A retry that re-ranks can't double-pay; Phase 3 ranks once and reuses the stored snapshot on retry. |
| `fee_swaps` holds one row per swap chunk | Jupiter swaps run in ≤ $2k chunks, each with its own signature. |
| `match_replay_v` is public (finished matches only) | The spec's public replay page needs input logs, and the web app reads public views only. It never exposes IP hashes, fingerprints or flags. |
| `balance_checks.tokens` is raw base units + `decimals` | Exact; no UI-unit rounding. |
| New `public` functions are not executable by anon/authenticated by default | A test fails if any function outside an (empty) allowlist is. |
| Landing showcase: pause button; reduced motion shows still frames | WCAG 2.2.2. Play under reduced motion animates the chickens but keeps the camera still. |
| Disposing a renderer also disposes three's shared DFG LUT texture | r186 keeps a listener per renderer on it, which leaked every disposed canvas. Recheck on a three upgrade. |

## Phase 1 review outcomes

A second adversarial review (6 areas including a data-driven balance critic, every finding re-verified) confirmed 50 issues (2 high, 12 medium); all were fixed before PR #2. ★ = Sammy's call.

| Decision | Why |
|---|---|
| ★ At full Heat, away+Space is a peck; the super is Space with no direction (or up) | Poking no longer burns a full meter by accident, and "away+Space peck, then Space" is a working peck → super cancel. |
| ★ The dive kick stays unblockable but is reactable | It can start only from the 14th air tick (was 4) and its landing recovery is 24 (was 14); the spec's 6-frame startup is unchanged. It now connects 21–24 ticks after the jump press. Making it blockable remains an option. |
| Wake-up is invulnerable for 2 ticks | A meaty dive kick used to beat every wake-up option except the super. |
| The peck cancels only into the super, and only on a clean hit | Cancels on block made blocked pecks safe; the peck → shove cancel whiffed or was punishable at most ranges. |
| A buffered Space remembers the directions held at the press; dash taps read the raw keys | Short taps no longer turn shoves into pecks, and SOCD cleaning no longer invents a dash in the wrong direction. |
| Shoves move exactly 2 units; anyone shoved past 8.0 u rings out | The slide's last tick used to be wall-clamped. |
| ★ Slam launch stays [160, 180] | Ring-outs end 21% of rounds between reactive bots, half of them by slam; [100, 180] would make it 15%. |
| CPU rebuilt: ordered, beatable, not trivially exploitable | Levels keep the plan's reaction delays (22 / 14 / 8 ticks) and block rates; each harder level beats the easier one 100%. Walk-and-peck used to win 100% against every level; now 30–58% vs Easy, 3–45% vs Normal, 0% vs Hard. Hard is the patient level. |
| Camera: a hard fit on top of an eased composition | Both bodies, the feet and the top of a jump stay between the frame edges and the HUD band (a fixed CSS height, `hudBand.ts`, measured in e2e) at every aspect including portrait. Jumps raise the look target before pulling back. |
| The shake setting scales everything that moves the view | Trauma shake, the per-hit kick, the punch zoom and the super's FOV kick. Off really is off. |
| Quality "low" also trims the arena | Drops embers, smoke, the crowd flash pass and the haze, with no rebuild or recompile. |
| The ring lip is flush with the floor | A shove that falls short leaves a fighter standing up to x = 10. |
| A fight engine resets the HUD and drops its callbacks | Rematches and restarts used to keep every earlier engine alive (6 WebGL contexts after 5 restarts; now 1) and could show a stale pause menu. Renderers are disposed through `disposeRenderer`. |
| Game keys ignore focused controls and are off while paused | The pause menu and match-end buttons work from the keyboard; keys pressed while paused don't fire after resume. |
| The arena rules run whenever `arena.glb` exists | `ringedge_L/R` empties are required at x = ∓10 (±0.05); missing fire / crowd / flood groups are warnings (the procedural layout fills in). |
| Hero import is staged in `art/blender/out/` and swapped in atomically | The glb and `hitboxes.json` are renamed in, `hitboxes.json` last; Ctrl-C cleans up. A dry run never overwrites the glb the game loads. |
| The Blender UI preset is generated and sets every exporter option | Applying a preset only sets what it lists, so a partial preset didn't guarantee the scripted settings. |

## Phones: on-screen buttons (added to Phase 1)

Sammy asked for the playtest to work on phones, so the spec's Phase 2 mobile controls moved up. ★ = Sammy's call.

| Decision | Why |
|---|---|
| ★ Both orientations play; upright is a controller panel under the fight | Sammy's choice, instead of the spec's "rotate your phone" card. The fight takes the top of the screen (about square, ≥ 200 px left for the panel), the panel the rest. Sideways, the fight fills the screen and the buttons sit see-through in the bottom corners. Layout is CSS only (`app/play/play.css`), one element tree, so turning the phone never remounts the canvas or restarts the fight. |
| ★ Buttons: a d-pad, PECK, and a context button reading JUMP / SLAM / DIVE | The d-pad is the arrow keys (hold ▼ to block, double-tap to dash); PECK is Space. The context button jumps on the ground, slams with ▼ held when the thumb lands, and dives in the air: the moves that need two keys become one thumb. JUMP is its idle label; DIVE dims when a dive can't happen (spent, too low, knocked into the air). PECK reads SUPER when Heat is full, the d-pad is neutral and you're grounded. |
| Touch makes the same 5-bit mask as the keyboard | No separate sim path (the spec's rule): the sim, replays and golden hashes are unchanged. Touch plays P1 against the CPU only; 2P still needs a keyboard (the mode picker says so on phones). |
| D-pad changes are queued, one per tick; Space is a one-tick pulse per press | Thumbs are faster than 16.7 ms ticks. A tap and re-tap between two ticks still reach the sim as R, 0, R (the two raw press edges a dash needs), and every button press is a new Space press edge (holding PECK then pressing DIVE would otherwise send nothing new). The sim only reads Space's press edge, and the CPU already sends it this way. |
| The d-pad is 8-way with sticky edges | Neutral inside 28% of its radius (16% once a direction is held); left/right sectors are the widest (60°); a held sector keeps 7° past its edge; a diagonal stays diagonal while the thumb stays on its side (↘ back to ↓ keeps ↘). The sim counts every raw → press toward a dash, so without these a blocking thumb wobbling between ↓ and ↘ dashed forward. No outer limit: a thumb that slides off keeps its direction. |
| Fingers: the newest on the d-pad drives it; when it lifts, a finger still on the pad takes over | A second finger on the context button is one more press of what it's doing (holding JUMP in the air and tapping dives, like ↑ + Space). |
| Each half of the upright panel is one hit zone | A thumb anywhere on the left drives the d-pad; on the right, whichever button is nearer. Sideways, each cluster has a large invisible zone. No zone reaches into the 32 px at the screen's sides (the system back swipe: ~24 dp on Android). Upright, the pad and buttons sit under the PAUSE / SOUND pills and shrink to fit a short panel (the panel is a size container). |
| The system back gesture pauses instead of leaving | An edge swipe is easy to hit with a thumb on the d-pad. During a touch fight one extra history entry sits on top (Next's router copies its state into it, so going back to it restores the page without a reload); going back pauses. From the pause menu or a finished match, back leaves as usual. |
| No pull-to-refresh, no iOS input zoom on the fight screen | `overscroll-behavior: none` on the page while a fight is on screen and `overscroll-contain` on the pause menu (a downward swipe there would reload and end the fight). The pause menu's selects are 16 px, because iOS zooms into smaller fields, and the fight screen allows no gesture to zoom back out. |
| The camera keeps 60% of the buttons' reach clear (`INSET_SHARE`) | The buttons sit in the corners; keeping all of it clear would shrink the chickens by a quarter on a phone held sideways. At 60% close-range framing is unchanged; jumps pull back a little more. The inset never leaves under 0.6 NDC of height between it and the HUD. |
| HUD tiers follow the fight area (container queries), with a new short tier | Sideways phones got the 112 px desktop band (a third of the screen); the short tier is 72 px (measured 53). Upright, the fight area is under 640 px wide, so the narrow tier (88 px). Names never wrap (a wrapped "CPU (NORMAL)" pushed the bars past the band). |
| Upright and square screens compose tighter | 2 u of pit each side of the pair (not 3.5) and a 6.5 u minimum width below aspect 0.95, easing to the landscape values at 1.3 (so a pixel of height never jumps the framing; landscape desktops and phones are unchanged). The width sets the scale there, and the old margins left the chickens ~45 px tall on a phone, including the about square fight area an iPhone gets upright in Safari. The hard fit still keeps both bodies and a full jump in frame. |
| The timer is the pause button (plus PAUSE / SOUND pills upright) | There was no way to pause without a keyboard. It works with a mouse too, but stays out of the tab order and never takes focus on a click: a focused button would take Space and Enter (the peck keys). |
| The controls are divs, never focusable, with native non-passive touch listeners | A focused control would take the keyboard's keys; React's touch listeners are passive, so preventDefault (no scroll, no pinch or double-tap zoom, no callout) needs native ones. |
| Shown on coarse pointers, or after the first touch in a tab | `?touch=1` forces them on (desktop testing), `?touch=0` off. |
| iOS audio plays as "playback" (`navigator.audioSession`) while unmuted | The default "ambient" category is muted by the silent switch, which would make the game silent on most iPhones. "playback" stops the player's own music, so muting the game (the SOUND pill, the pause menu) switches back to "ambient". |
| Screen readers get the timer (labelled with the time and round), the pills and the pause menu | The pad itself is `aria-hidden` (thumbs only). The pills are click targets so VoiceOver / TalkBack can press them. |
| `viewport-fit=cover` on /play | The fight area stays inside the safe area itself (notch, rounded corners); only the floor runs under the home bar. |
| `?debug=1&cpu=idle` stands the CPU still | e2e checks P1's touch input without the CPU hitting P1 mid-check. Ignored without debug. |
| CI e2e: more time under software GL | CI renders about a frame a second (SwiftShader has no parallel shader compile). The keyboard walk steps the sim inside the page instead of rendering a frame per tick; the six-page quality test gets 240 s; tests get 150 s under software GL; the touch suite runs as its own CI job (`test:e2e:touch`) beside the desktop one (`test:e2e:desktop`). |

