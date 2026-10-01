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


## Phase 2: online

Agreed with Sammy before the build (2026-09-24): an **open playtest mode** so friends can play online before $COCK exists; **one region (US-East)** to start; **usernames** (message signing) move to Phase 3. ★ = Sammy's call; ✓ = confirmed by Sammy at the Phase 2 review (2026-09-24).

### Netcode

| Decision | Why |
|---|---|
| ★ Both fighters are predicted and rolled back, not "the opponent interpolated 100 ms behind" | In a fighter, a 100 ms-old opponent means getting hit by moves you never saw start, and hits resolve against positions you weren't shown. The deterministic sim makes rollback cheap: the client keeps the server's confirmed state and re-simulates ~5–10 ticks (a few µs each) when new confirmations arrive. The spec's 2-tick input delay is kept, which keeps rollbacks short. |
| Own protocol on `packages/net`, not Colyseus' `defineInput` / `Predict` | The client needs the server's exact buttons per tick to re-run the same sim; schema snapshots can't carry the 73-field state (Schema's 63-field cap) and aren't needed when the inputs are. Room metadata (seats, status, result) still uses Schema. |
| Snapshots: the buttons used, every tick, plus a full-state sync twice a second | "Snapshots must carry the full sim state" (open question): they do, at 2 Hz and on join / resume, as a desync check. Every tick the server sends the two masks it used (6 bytes). A client whose confirmed state differs from a sync adopts the server's (counted; 0 in every test). |
| Clock: the client runs a tick more or less to keep its inputs ~2 ticks early | The server reports how early each player's inputs arrive; no clock maths, robust to drift (tested at 59.9 vs 60.05 Hz) and jitter. |
| Tick-ahead limit: 40 ticks, not the spec's "+3" | Open question resolved. A predicting client's inputs arrive ~INPUT_DELAY + 2 ticks early, and the same limit caps how far a client predicts, which has to cover a whole round trip: 40 ticks keeps players up to ~500 ms playable (tested at 300 ms: input quality > 0.97). Far-future inputs are rejected and counted (Phase 3 can flag them). |
| ★ Corrections up to 3 u blend (at most 0.15 u per frame, over 3–20 frames); only bigger ones snap | The spec says snap above 0.5 u, but a dash moves 0.16 u a tick: every dash the prediction learns about 4 ticks late (80 ms RTT) would teleport the chicken, ~30 times a minute in the harness. Blended, the drawn chicken never moves faster than a dash would, and the harness sees 0 snaps at 80 ms. Presentation only: the sim state is never touched. |
| Events after a rollback are re-derived tick by tick and deduplicated | A hit the prediction missed still gets its sparks and sound (late); one it already showed doesn't show twice. Only hits, KOs, ring-outs, round / match ends and full Heat are shown late; a late jump or walk is skipped. |
| A missing input repeats the last one for 15 ticks, then goes neutral | A dead connection is only noticed at the WebSocket ping timeout; until then a held attack would keep swinging. Pings are every 1.5 s with 2 retries (~3–4.5 s to notice, default was 6–9 s). |
| Net quality = share of fighting ticks with the input on time | Stored per player (`net_quality_p1/p2`); Phase 3 halves / voids payouts from it. |
| Clients must run the server's sim rules | The queue refuses a client whose `rulesHash` differs ("reload the page"): a stale cached page would desync every sync. |

### Matches

| Decision | Why |
|---|---|
| Rooms start when both players have loaded (30 s, else cancelled) | Loading the chicken and compiling shaders takes seconds; the sim's 3 s countdown starts only when both can see it. |
| ✓ A dropped player pauses the match for up to 10 s, out of a 20 s budget per player per match | Spec: "10 s grace then forfeit". The budget stops a player stalling a match by dropping over and over (a malformed message or flooding also drops a client). |
| Both players gone: the match is off (no result, no ELO) | Unless one comes back while the other's grace has already run out: then the one who came back wins by forfeit. |
| A forfeit during the 2 s after a deciding KO plays the sim out | The match is already won; walking away from the KO screen mustn't hand it to the loser. |
| Leaving on purpose forfeits at once | Spec. The result card's "find another match" leaves an over match, which is harmless. |
| Forfeits record the round they happened in | The database needs 1–5 rounds for a finished match; the forfeit round's winner is the player who stayed. |
| Results are written once, at the end, by `record_match()` | One transaction: the `matches` row and both ELO updates, locked in address order, idempotent on the match id. The row is not written at match start. |
| ELO: K = 32, draw = ½, rounded half up, same formula in SQL and TS | A test checks them against each other; a reviewer checked 6,003 cases. |
| ✓ Pasting an address is enough to move its ELO | Anyone can paste someone else's address (≥ $30) and throw matches under it. Harmless for payouts (they go to the holder), but it can move a stranger's rating and leaderboard row until Phase 3's message signing. The queue refuses a second ticket for an address already queued (so a paster can't kick the holder out). |
| `input_log` is the replay JSON (UTF-8) | Two `{t, b}` arrays, a few KB; `result_hash = sha256(matchId + winner address + log)`, empty address for a draw or a playtest guest. |
| Open (playtest) matches never touch the database | They'd pollute ELO and the leaderboard. The game server keeps the last 500 matches (all of them) and a playtest rating table in memory, served at `/api/matches/:id` and `/api/leaderboard`, so replays and a leaderboard work with zero env vars. |

### Queue and gate

| Decision | Why |
|---|---|
| ★ The wallet gate runs on the game server (`POST /gate`), not in a Vercel API route | The spec wanted the game server to never call Helius, but the match-start re-check needs a balance read anyway. One place for the Helius key, no extra hop for the re-check, and the web app stays a static site (the Netlify playtest keeps working). The 5-minute queue JWT is kept (Turnstile tokens are single use; the tier badge shows before queueing). "Who writes `balance_checks`" (open question): the game server, through `record_gate()`. |
| No Redis in Phase 2 | One machine keeps the queue, rooms and the 60 s balance cache in memory. A second machine or region needs Redis and per-machine WebSocket routing (the `fly-replay` question); deferred with Sammy's one-region choice. |
| Price: Jupiter Price v3; a fixed configured price on devnet | No price API quotes a devnet test mint. The spec's bonding-curve quote (the gate takes the lower price) waits for the launchpad decision (Phase 3); `BalanceGate` already takes several sources and uses the lowest. The price is reused for 20 s. |
| Only passing checks are cached | Someone $2 short who buys can retry at once instead of waiting 60 s. |
| Off-curve addresses are refused | A program-derived address can't sign; SOL sent there is lost forever. |
| ✓ The match-start re-check lets a match go ahead if the chain can't be read | Availability over strictness: the player passed the gate at most 5 minutes earlier. A re-check that reads below $30 still removes them (told why) and puts the other player back in the queue. |
| Turnstile is required in production | An unset secret closes the gate (503) instead of falling back to Cloudflare's always-pass test secret; the token's hostname must be one of `ALLOWED_ORIGINS`. |
| ✓ Pairing: 120 ms RTT, 200 ms after 20 s, anyone after 60 s | Spec, plus the last step: in a thin queue nobody should wait forever. Sides are random. Phase 3's anti-abuse rules (≥ 4 in the queue, IP / fingerprint, rematch cooldown) plug into `canPair()`. |
| One queue room, created at boot; tokens checked at the HTTP matchmaking step | Clients can't create queue or fight rooms, and a seat is only reserved for a valid token (or, open mode, a name). Fight rooms are private. |
| Request bodies over 16 KB (or unsized) are refused | Colyseus reads bodies into memory with no cap; a few 200 MB posts would take the 1 GB machine down. |
| `/gate` rate limit: 20 per minute per IP (IPv6 per /64); on Fly only `Fly-Client-IP` counts | `X-Forwarded-For` is whatever the client sends. |

### Web

| Decision | Why |
|---|---|
| The engine takes a match driver (local or online) | `OnlineMatch` draws the prediction and samples this player's buttons; everything else (view, director, HUD, audio, touch) is unchanged. Online fights never pause; the on-screen buttons play whichever side this browser has; the back gesture isn't intercepted online. |
| `NetSession` registers the sim handlers when the fight room is joined | Nothing the server sends is dropped while the fight loads. |
| The SDK reconnects on its own (from the first second) | Colyseus waits 5 s of uptime by default; a drop in a match's first seconds would otherwise be a forfeit. A connection lost for good shows "connection lost" with a way out. |
| `/m/<id>` is the static `/m` page | `next start` rewrites it; the static export writes a Netlify `_redirects` rule. The page re-simulates the match headless and shows ✓ verified when it reaches the stored final state and the result hash matches. The OG image / share card is Phase 3 (with share cards). Replays are silent for now. |
| Ranked replays show both chickens as Rust | `match_replay_v` has no tier column (tiers can change after a match). Playtest replays (from the game server) have their tiers. |
| The leaderboard shows Supabase's ranked standings when configured, else the playtest ones | One source at a time; the page says which. |
| The landing page's wallet box opens `/play?mode=online&wallet=…` | The gate itself runs in the lobby (Turnstile, balance, how far from $30, buy link). |
| The browser doesn't parse the public env with zod | zod 4 probes `new Function("")` on its first parse, a CSP violation (no `'unsafe-eval'`). The server validates the same inlined values at build; the browser applies the defaults (a test keeps them equal). The online e2e now fails on any CSP violation too. |

## Phase 3: money

Agreed with Sammy before the build (2026-09-24): launch on **pump.fun**, Custom Pair with **PUMP** as
quote, creator fee **3%**, fees shared 70% to the hot wallet / 30% to the launch wallet through
pump.fun's "Share creator rewards"; players paid in PUMP; tiers $30 / $250 / $1,000 at 1× / 2.5× / 6×;
cross-tier pairs after 60 s at the lower rate; the seed drains at most 1/14 per day; one global daily
top 10 by wins. ★ = Sammy's call; ✓ = confirmed by Sammy at the Phase 3 review (2026-09-25).

### Economy (`packages/economy`, proven by the synthetic-month test)

| Decision | Why |
|---|---|
| The budget rule is a **ledger allowance**, not a trailing-24 h window | The plan said "payouts in any 24 h ≤ 70% of fees claimed in that window + the seed draw". Run as written, an eight-hour claim outage stalls every payout (the window's claims age out while its payouts don't), which contradicts invariant 7. The allowance (claimed player share + seed draws − payouts sent − sweeps) is what the hot wallet should hold by the ledger's own count; a payout may never take it below zero. The trailing-24 h prize sizing (D / W) and the USD caps provide the rate limit. Invariant 1 and 6 in `docs/plan-phase3.md` now read this way. |
| ✓ `MAX_PAYOUT_USD` is **500**, not 75 | 75 is below a Gold win's cap (P_max × 6 = $450): every Gold win would have paused payouts. `validateParams` refuses a cap below the Gold cap. |
| ✓ Daily rewards have their own cap (`MAX_DAILY_REWARD_USD` = 5,000) and are exempt from the hourly cap | First place on a $500k-volume day is $750 and on a launch day well over $1,500; with the $75 / $3,000-per-hour caps the midnight batch paused payouts every night in the simulation. Wins keep the per-payout and hourly caps; everything counts toward the daily cap. |
| ✓ The caps as shipped: $500 / win, $5,000 / daily reward, $3,000 / hour of wins, $20,000 / day | $20k covers about $950k of daily volume (payouts run ≈ 2.1% of volume). Sammy chose to keep it at launch and resume by hand if a big day trips it: a pause is one click in `/admin`, and the tighter cap bounds what a bad day could leak. |
| Amounts are `bigint` raw units; dollars are converted at the hourly price, truncated | A double holds PUMP's 6 decimals badly at the sizes the vault holds; a dollar knob converted at $0.0000031 keeps its digits by scaling to micro-dollars first. |
| Sweep = min(wallet − keep, allowance − keep), where keep = hot target + payouts booked but unsent | Dust the ledger never saw stays in the wallet; what is booked stays covered. Only with `COLD_WALLET` set. |
| A signed payout is written to the ledger before it is broadcast | The signature is known at signing. A crash in between leaves a `sent` row that reconcile settles from the chain: confirmed → paid; blockhash dead (or, after a restart, unseen for 5 minutes) → back to pending with a new attempt; five expired attempts → failed with an alert. Every status change is a guarded PATCH (`status=in.(…)`), so a row can't be sent twice. |
| The seed draw is estimated from the day that just closed | The draw is booked at 00:00 UTC for the day ahead from yesterday's fees (the plan's formula); a dead day draws the day after. A failed seed transfer books nothing and retries every minute. |
| Zero-amount daily rewards are skipped; a day is booked even with no rewards | `daily_pools` is the idempotency record, so midnight never runs twice. |
| Draws, open matches, quality 0, a flagged wallet and the caps book **0**, with the reason on the match row | `payout_reason` (`draw`, `open`, `quality`, `flagged`, `cap_wins`, `cap_opponent`, `no_pool`); the result screen says why. ✓ Drawn matches don't pay (two players can't draw on purpose to split prizes). |
| ✓ The q-multiplier "void over 30%" is 0 (nothing paid), not a voided match | The match still counts for ELO and the leaderboard; only the prize is 0. |

### Chain

| Decision | Why |
|---|---|
| No web3.js at runtime: a hand-rolled legacy transaction layer in `packages/solana` | ~150 lines (PDAs, ATAs, compact-u16, ed25519 from `@noble/curves`), one dependency fewer in the worker bundle, and a test that proves byte-for-byte and signature parity with `@solana/web3.js` + `@solana/spl-token` (dev dependencies only). |
| Fees are claimed with the permissionless `distribute_creator_fees_v2` from the hot wallet | Verified on the throwaway coin: after "Share creator rewards" the bonding curve's creator is the sharing config, the vault is `pda(["creator-vault", sharing_config])`, and anyone may pay the distribution to the shareholders' ATAs. The launch wallet's key is never on a server. After graduation `transfer_creator_fees_to_pump_v2` sweeps the AMM side first. The claim refuses to run until the sharing config lists the hot wallet. |
| A winner's PUMP ATA is created in the payout transaction (idempotent), rent paid by the hot wallet | About 0.002 SOL per first-time winner; the hot wallet's SOL has a low-balance alert. |
| The claim's "received" is the hot ATA's balance delta | Independent of pump.fun's fee accounting; gross = received / 0.70. |
| Fees are claimed every 10 minutes (`CLAIM_EVERY_MIN`) | Sammy's call (2026-09-25), up from the plan's hourly. Prizes are sized from claimed fees, so on launch day they catch up with trading within 10 minutes instead of an hour. A claim costs about 0.000013 SOL with the priority fee (under 0.002 SOL a day) and is skipped, with no transaction, when nothing is waiting. The price is refreshed and the sweep checked at the same time. |
| Priority fee 100,000 µlamports / CU, compute limit 80k | Was 10,000; two claims were dropped on the first live afternoon. 100k is 0.000008 SOL a transaction, still well under a cent. `PRIORITY_FEE_MICROLAMPORTS` tunes it. |

### Worker

| Decision | Why |
|---|---|
| Three modes from env: health, observer, live | Health with nothing set (Phase 0 behaviour, the Docker boot test). Observer with Supabase + RPC + `PAYOUT_MINT`: the pool is computed and the daily top 10 booked, nothing sent (`PAYOUTS_ENABLED=false` or no hot key), so the site shows real numbers before the wallet goes live. Live with the hot key and `PAYOUTS_ENABLED=true`. |
| Pool state is recomputed every minute and written to `pool_state`; `record_match` books from it | The game server never does pool maths: it passes the paid tier and q, the SQL picks the tier's amount. What the site shows is exactly what the next win gets. |
| `/admin` knobs live in `settings`; env holds the defaults | The worker merges them every minute; an invalid set is ignored with a log line. The pause switch is a settings row too, so the game server and the site read it the same way. |
| Telegram alerts dedupe identical messages for ten minutes | A stuck condition pages once, not every five seconds. |
| A failed fee claim alerts on the 3rd in a row (then every 36 more, ~6 h), plus a "working again" note | Live on the test coin, 2 of the first 16 claims were dropped by the network and the next claim collected the fees anyway. Alerting on every drop was noise; three in a row (30 min) is a real outage. Claims (and the seed draw and sweeps) now rebroadcast the same signed transaction while they wait, and the priority fee went from 10k to 100k micro-lamports per CU (80k CU ≈ 0.000008 SOL a transaction). |

### Game server

| Decision | Why |
|---|---|
| ✓ `QUEUE_MIN_PLAYERS` defaults to **2** (the spec says 4) | With 4, two friends can never play ranked on a quiet night. The rematch cooldown and the 10-per-opponent cap already bound what two colluding wallets can farm. Set it to 4 at launch if the queue is busy enough. |
| Private and loopback IPs count as unknown | Locally everyone is 127.0.0.1; on Fly the client IP is `Fly-Client-IP`. Only salted hashes of the IP's /24 and the browser id (the open queue's guest id, reused as the fingerprint) reach the database. |
| The bot check is timing only, and it holds rather than refuses | Metronome-regular button changes (CV < 0.04 over ≥ 60 changes) or a macro repeated ≥ 4 times flag the match; the payout is booked but held (`deferred` until `/admin` clears or voids it) and an abuse event is filed. A false flag costs a human look, not a prize. |
| Usernames: `cockfight:claim:<nonce>:<name>` signed by the wallet, the nonce an HMAC with a 5-minute expiry | The name is inside the signed text, so a signature can't be reused for another name; nonces need no table. The claim UI uses the wallet-standard `window.solana.signMessage`, nothing on chain. |
| The gate refuses a banned wallet (403) and hands the username out with the token | A ban takes effect at the next gate check (tokens last 5 minutes). |
| `/admin` is basic auth with an optional IP allowlist, off without `ADMIN_PASSWORD` | One page of plain HTML and JS on the game server (it already holds the service key); constant-time password check; 403 before the password when the IP isn't listed. |

### Web

| Decision | Why |
|---|---|
| Every pool number comes from `pool_v` / `payouts_v` / `daily_rewards_v` | No estimates on the page: the tiers' next win, today's pool and its countdown (from the server's clock), fees claimed, paid to players, the seed left, the last payouts with their transactions. Without a pool row the panel says payouts start with the coin; a pool older than ten minutes says so. |
| The result screen follows the payout to its transaction for 55 s | The room polls `payouts` every 3 s after booking; the winner sees "sending…" then the Solscan link. |
| `/p/<address>` is the static `/p` page, like `/m/<id>` | Profile: record, earnings, rank today, the caps, payouts, the username claim. |
| No share card / OG image yet | Needs image generation on a static site (a build-time template per match isn't possible); deferred to the launch kit. |

## Launch kit: the videos (`tools/video`, plan in `docs/plan-videos.md`)

| Decision | Why |
|---|---|
| Footage is rendered one sim tick per frame through `__cockfight.fight.stepTicks`, never screen-recorded | Exact 60 fps with no dropped frames, free slow motion (render every tick, play at 24), choreographed fights (both sides' buttons are scripted off the live state, so every beat lands), and a per-tick log of events and the sounds the director fired, which the edit uses to cut on the impact frame and lay the game's own sounds back in. Re-shooting after the art or the coin changes is one command. |
| Fights are shot at 2× (3840×2160) on the Mac's GPU | The edit punches in up to 2.5× and stays sharp at 1080p. ~0.5 s a frame; the whole shot list is ~40 min. |
| A virtual clock for `performance.now` and the rAF timestamp, one tick per captured frame | Shake, particles and mixers stay in step with the sim however long a screenshot takes. Timers and fetch are untouched, so loading is unaffected. |
| Title cards are HTML with the site's faces, stepped through the Web Animations API and captured with alpha | One design language with the site; deterministic motion; overlays composite in ffmpeg. |
| The edit is data (`edl.ts`) rendered by ffmpeg, no NLE | Sammy asked for finished MP4s and a fast revision loop; a change is a line in the EDL and a rebuild. |
| Voice is Higgsfield's ElevenLabs engine, preset "Gideon"; the spoken copy spells "Cockfight" as a word and "$COCK" as "Cock" | Seed Audio read the all-caps "COCKFIGHT" as an acronym ("cock fit"). Sammy's own ElevenLabs account had a failed invoice, so the ElevenLabs engine runs on Higgsfield credits (~0.5 a line). Captions keep the ticker. |
| Music is Sammy's own Suno tracks (`Claude outputs/video/music/`): a 30.4 s rap spot for the promo, a bed for the explainer | Higgsfield's music model is not available for standalone tracks. The promo is cut to the spot's grid (152 BPM: the four hits on "peck / shove / slam / dive kick", the KO on "K.O.", the tag on the downbeat of the outro). Suno masters around −16 LUFS, so the explainer bed sits at gain 0.16 (~9 dB under the voice) with a gentle sidechain duck; a bed shorter than the picture loops under the end card. |
| The prize on the result screen is staged (blurred amount, real-looking transaction link) and the pump.fun page is not on screen | The site runs on the throwaway test coin; live dollar amounts are hidden, mechanics shown. `video:online` re-shoots the card from a real ranked match after the live payout test. |
| On-screen tagline is "HOLD $COCK. GET PAID." | Payouts are in PUMP, so "win SOL" would be wrong. |
