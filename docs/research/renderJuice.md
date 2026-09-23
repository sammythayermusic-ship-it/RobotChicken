# apps/web Phase 1 client plan: rendering, juice, audio, HUD, perf

## 0. Decisions and versions

- **Use plain imperative three.js, not R3F.** Four reasons:
  - The fight needs a strict per-frame order: step the sim, run presentation, then render. R3F makes that order hard to control.
  - Several soltendogs bugs were caused by R3F on this same stack (`~/soltendogs/docs/decisions.md`):
    - the `@react-three/postprocessing` frame subscription never fired with fiber 9.7;
    - drei `<Instances>` rendered as black triangles;
    - the `<Canvas dpr>` prop was re-applied on every render, which broke the medium tier's DPR cap;
    - fresh `position` arrays snapped the camera back;
    - StrictMode double-invoke plus `useMemo` disposal bugs.
  - R3F adds about 58 KB gz (measured with esbuild; three and React external).
  - The same engine can later drive `/m/[id]` replays and a headless KO snapshot.
  - React stays for the page shell, the mode picker and the HUD.
- **Pin versions exactly.** three.js has breaking changes every release.
  - Rendering: `three@0.186.0` (released 2026-09-08) and `@types/three@0.186.0`.
  - App: `next@16.3.6` and `react`/`react-dom` at `19.3.0` (or `19.2.8` to match soltendogs). The spec says Next 15, but soltendogs already runs 16.3, so use 16 and note it in `docs/decisions.md`.
  - Tooling: `zustand@5.0.15` (UI state only), `tailwindcss@4.3.3`, `@playwright/test@1.63.0`, `vitest@5.0.1` (soltendogs is on 4.1.11; 5.0 came out on 2026-09-03).
  - Not used: postprocessing, stats-gl, Howler, drei.
- **Use `WebGLRenderer` (WebGL2), not WebGPU.** `ShaderMaterial` and GLSL work there; WebGPURenderer needs TSL. Android coverage is also safer.
  - Measured size: three core plus the GLTF, DRACO and KTX2 loaders and SkeletonUtils is **187 KB gz**.
- **Use a custom KO pass, not a composer.** Measured deltas on top of three core:
  - pmndrs `postprocessing@6.39.5`: +11 KB gz. Its peer range is `three >=0.168 <0.187`, so it would break on r187.
  - three addons `EffectComposer` + `OutputPass`: +2.7 KB gz.
  - Either composer renders every frame through an offscreen target, which costs bandwidth on phones all the time.
  - r186 adds `outputBufferType: HalfFloatType` + `renderer.setEffects()`. Checked in `WebGLOutput.js`: with any tone mapping it **always** renders to an MSAA HalfFloat target plus an output pass, even with no effects. Reject it for the same reason.
  - Chosen: a ~40-line `FramebufferTexture` copy pass (§3) that costs GPU time only during the 0.6 s KO pulse.
- **Use raw WebAudio, not Howler/WAV blobs.** Render sounds with `OfflineAudioContext` into `AudioBuffer`s and play them through `AudioBufferSourceNode`. This gives lower latency, no blob URLs in the CSP, and Sammy's files decode into the same buffer map.
- **`THREE.Clock` is deprecated since r183.** Drive the loop from the rAF timestamp.

## 1. Loop (`src/game/engine/loop.ts`)

- Fixed 60 Hz sim with an accumulator, plus render interpolation.
- At most **5** catch-up steps per frame. If the cap is hit, drop the backlog: the game goes slow-mo rather than into a spiral of death.
- Clamp any `dt > 250 ms` to one step (tab return, breakpoint).
- Snap `dt` near the refresh interval to exactly 16.667 ms. This prevents alternating 0-step and 2-step frames on 60 Hz panels. 120 Hz ProMotion and 90 Hz Android displays get smoothness from interpolation.

```ts
const STEP = 1000 / 60;
frame(now) {
  this.raf = requestAnimationFrame(this.frame);
  let dt = this.last < 0 ? STEP : now - this.last; this.last = now;
  if (dt > 250) dt = STEP;
  if (Math.abs(dt - STEP) < 0.5) dt = STEP;               // vsync snap
  if (!this.paused && !this.manual) {
    this.acc += dt; let n = 0;
    while (this.acc >= STEP && n < 5) { this.tick(); this.acc -= STEP; n++; }
    if (n === 5) this.acc = Math.min(this.acc, STEP);
  }
  this.view.render(this.prev, this.cur, this.paused ? 1 : this.acc / STEP, now);
}
tick() {                        // also called by __cockfight.stepTicks(n)
  const b1 = this.src[0].sample(this.cur), b2 = this.src[1].sample(this.cur);
  this.copyInterp(this.cur, this.prev);        // prev x/y only, no alloc
  this.cur = step(this.cur, b1, b2);           // packages/sim
  this.director.tick(this.cur, this.cur.events); // camera, shake, fx, audio, HUD: fixed-dt, deterministic
}
```

**Needs from the sim researcher:**
- `step()` must emit `events[]` each tick (hit, block, whiff, dash, jump, land, heatFull, superStart, ko, ringout, round/phase changes), each carrying `{attacker, move, damage, x, y}`. Events are excluded from the state hash.
- Fighter `state` + `stateTick` + a global `hitstop` counter.

**Input sources (`InputSource.sample(state): uint8`):**
- `KeyboardSource(bindings)`:
  - held set plus a **press latch** ORed in once, so a sub-16 ms tap still registers;
  - `e.code`, not `e.key`; ignore `e.repeat` and `isComposing`;
  - `preventDefault` on arrows, Space and `/` (Firefox Quick Find);
  - clear all keys on `blur` and `visibilitychange`.
- Bindings:
  - vs CPU: arrows + Space (spec), with WASD + J as an alternate;
  - 2P: P1 = WASD + F, P2 = arrows + `/` (Enter as alternate).
  - Avoid Shift (Windows sticky keys).
  - Test for laptop keyboard ghosting.
- `CpuSource` wraps `packages/sim/src/ai/cpu.ts`:
  - pure and seeded; reads state from `reactionTicks` ago (easy 24 / normal 14 / hard 8);
  - behaviours: spacing, block on seen startup (probability by level), punish whiffs, shove near the edge, super when Heat is full and in range.
  - Deterministic, so it also drives the bench and e2e.
- Dash double-tap detection belongs in the sim, from bitmask history, not in the client.

**Visibility:**
- `/play` local modes: `hidden` → auto-pause (open the pause menu) and `audioCtx.suspend()`. On return, stay paused and set `last = -1`.
- Landing showcase: stop rAF when hidden or off-screen (IntersectionObserver).
- Online mode (Phase 2) swaps in a network tick source. Keep `TickSource` an interface.

## 2. Camera (`view/camera/FightCamera.ts`)

- `PerspectiveCamera` with a ~30° vertical FOV (telephoto look, flatter 2.5D).
- Framing is computed from the *horizontal* FOV, so narrow aspects still fit both fighters.
- State is stepped in `director.tick` (fixed dt, deterministic) and interpolated at render.

```ts
const sep = Math.abs(x1 - x2), mid = (x1 + x2) / 2;
const wantW = clamp(sep + 7, 10, 20);                          // visible width at fighter depth
const hfov = 2 * Math.atan(Math.tan(VFOV / 2) * aspect);
const dist = clamp((wantW / 2) / Math.tan(hfov / 2) - this.punch, DMIN, DMAX);  // pull-back as they separate
const maxX = Math.max(0, 10 + 1.5 - wantW / 2);                // show 1.5u past ring edge for ring-outs
this.x = damp(this.x, clamp(mid, -maxX, maxX), 6, DT);
this.d = damp(this.d, dist, 4, DT);
this.punch = damp(this.punch, 0, 10, DT);                      // dolly-in impulse
// damp(a,b,k,dt) = a + (b-a)*(1-Math.exp(-k*dt))
onHit(dmg) { this.punch = Math.min(this.punch + 0.04 * dmg, 1.2); this.trauma = Math.min(1, this.trauma + 0.1 + 0.02 * dmg); }
```

- On KO: a 0.5 s push-in toward the loser.
- On super: an FOV kick of −3°.

## 3. Juice

**Hit-stop is sim-owned.** The view never advances its own animation clock.
- Clip time is computed from `(state, stateTick)` using the phase boundaries in moves.json (piecewise-linear retime of startup/active/recovery).
- Each frame: `action.time = t; action.setEffectiveWeight(w); mixer.update(0)`.
- **Pitfall (checked in the r186 `AnimationAction._updateTime`):** with `deltaTime === 0` the mixer does not loop or clamp. The view must wrap loop clips (`t % dur`) and clamp one-shot clips itself.
- Blending: a 4-tick crossfade that counts *sim* ticks, so it also freezes during hit-stop.
- During `hitstop > 0`:
  - interpolation is forced off for the fighters;
  - the victim vibrates ±0.04 u using `(tick & 2)` parity (deterministic);
  - the hit fighter gets a 2-tick white emissive flash (per-fighter cloned material).
- Particles and camera shake keep running during the freeze. That is where they read best.

**Shake uses the trauma model** (Eiserloh, GDC 2016):
- Trauma added per hit: light 0.25, heavy 0.45, slam/super 0.7, KO 1.0. It decays at 1.6/s, stepped in fixed ticks.
- `s = trauma²`. Offsets are `maxX 0.25u, maxY 0.18u, roll 1.5°` × `s` × `noise1D(seed_k, (tick + α) × 25/60)`, using seeded value noise (`camera/noise.ts`, seed = match seed).
- Add a directional kick along the hit direction (spring back).
- Same event stream, same pixels: replays look identical at any frame rate.
- Add a "screen shake" setting. `prefers-reduced-motion` defaults it to 0.3.

**KO chromatic-aberration pulse (`fx/KoPulse.ts`):**

```ts
const fb = new THREE.FramebufferTexture(bufW, bufH);   // renderer.getDrawingBufferSize(); recreate on resize
const mat = new THREE.ShaderMaterial({ depthTest:false, depthWrite:false,
  uniforms:{ tScene:{value:fb}, uAmt:{value:0}, uFlash:{value:0}, uVig:{value:0} },
  vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
  fragmentShader:`uniform sampler2D tScene; uniform float uAmt,uFlash,uVig; varying vec2 vUv;
   void main(){ vec2 d=vUv-.5; float r2=dot(d,d); vec2 o=d*r2*uAmt;
    vec3 c=vec3(texture2D(tScene,vUv+o).r, texture2D(tScene,vUv).g, texture2D(tScene,vUv-o).b);
    c=mix(c,vec3(1.),uFlash); c*=1.-uVig*r2*2.; gl_FragColor=vec4(c,1.); }` });
// render(): renderer.render(scene,cam); if (amt>1e-3){ renderer.copyFramebufferToTexture(fb);
//   renderer.autoClear=false; renderer.render(quadScene, orthoCam); renderer.autoClear=true; }
```

- The pass works on the already tone-mapped sRGB image, so there are no extra material shader variants to compile.
- The official three `webgl_framebuffer_texture` example does this with `antialias:true`. Still confirm it with a KO screenshot test.
- Envelope: `uAmt` 0 → 0.15 → 0 over 0.6 s, plus a 2-frame `uFlash`.
- **Pitfalls:**
  - Prewarm this material at load by rendering once with `uAmt > 0`, so the KO frame never compiles a shader.
  - If a render-target path is ever used instead, every material compiles a second variant (no tone mapping, linear output). That is a KO-frame stall unless prewarmed with `setRenderTarget(rt); compile()`.
  - Set `renderer.info.autoReset = false` and reset once per frame, or the second `render()` undercounts draw calls (a soltendogs lesson).

**GPU particles (`fx/Particles.ts`):**
- A mesh on `InstancedBufferGeometry` (quad), not `Points`. Points are square, sized in screen pixels, and capped by `ALIASED_POINT_SIZE_RANGE` on Mali/Adreno.
- Two meshes:
  - **additive**: sparks, flames, hit flash; `depthWrite:false`;
  - **cutout**: screws, feathers, dust; alpha-test, `depthWrite:true`, no sorting.
- Ring buffers with fixed pools: sparks 512, screws 96, feathers 96, dust 64, flames 144.
- CPU work happens only on emit: write slots, then `attr.addUpdateRange(off, n*4); attr.needsUpdate = true` (two ranges when the ring wraps). Per frame, only `uTime` changes.

```glsl
attribute vec4 aSpawn;  // xyz, t0
attribute vec4 aVel;    // xyz, life
attribute vec4 aMeta;   // kind, size, seed, spin
float age = uTime - aSpawn.w;
if (age < 0. || age > aVel.w) { gl_Position = vec4(0., 0., -2., 1.); return; }    // dead → clipped
vec3 p = aSpawn.xyz + aVel.xyz * age + .5 * uGrav * age * age;                   // sparks/screws
// feathers: p = spawn + vel*(1.-exp(-k*age))/k + vec3(sin(age*7.+seed)*.15, -.4*age, 0)
// screws: one analytic floor bounce (restitution .4); spin = aMeta.w*age
// sparks: stretch quad along projected (vel + g*age) → streak; colour >1 HDR white→orange
// flames: age = mod(uTime + seed*life, life) (looping, never emitted)
```

- `frustumCulled = false`.
- `uTime` is fx seconds since match start. Floats lose precision after hours, so reset it each match.
- Spawn seeds come from `hash(matchSeed, tick, eventIdx)`, so replays are identical.
- Low tier: particles off (spec), but keep the single **HitFlash** billboard (one draw call). Hits must still read.

## 4. Placeholder arena (`view/arena/`, procedural, 0 bytes)

**Materials:**
- Arena geometry is baked into vertex colours (AO darkening at the base, rust variation) with `MeshBasicMaterial` + `scene.fog`. That is the "baked lightmap" look without textures.
- Fighters only: `MeshStandardMaterial` lit by a hemisphere light, one directional key and **2** flickering `PointLight`s (left and right fire clusters).
- Env map: `PMREMGenerator.fromScene()` of a mini junkyard scene (orange fire blocks, cold floodlight panels, dark ground). Chrome and Gold reflections need it.
- `renderer.shadowMap.enabled = false`. Tone mapping: `ACESFilmicToneMapping`, exposure 1.0.

**Geometry** (each group merged into one geometry per material, like soltendogs `mergeCopies`):

| Element | Build | Tris | Draw calls |
|---|---|---|---|
| Pit floor | 24×12 plane, hazard stripes at ±10, drop-off lip | ~1k | 1 |
| Car walls | 36 boxy cars (body, cabin, 8-sided wheels), stacked 3 high | ~5k | 1 |
| Tire stacks | | ~3k | shared |
| Bleachers | | ~2k | 1 |
| Oil drums | 6 | ~0.6k | 1 |
| Fire glow decals | additive radial quads on floor and wall behind each drum | | 1 |
| Floodlight cones | additive, fresnel-gated (soltendogs light-shaft lesson) | | 1 |
| Sky | gradient dome + distant junk skyline | ~1k | 1 |

- **Fires:** emissive drum rims. Flicker is `0.8 + 0.2·noise(t·8 + seed)`, shared by the glow decal, rim emissive and the point lights. Flame particles loop in the shader.
- **Crowd:** 240 instanced **camera-facing sprites**. The camera is fixed side-on, so billboards never show.
  - Atlas: 4 silhouette frames (wings up/down × 2 bodies) drawn by Canvas2D at load into a `CanvasTexture`; the G channel masks the red eyes.
  - Vertex shader: `y += hype·abs(sin(t·(4+6·hype)+phase))·.15`, with frame flipping at a hype-driven rate.
  - `uHype` = 0.2 + heat/250 + decaying spikes on big hits; 1.0 for 2 s on KO, plus random white "camera flash" instances.
  - Cost: 1 draw call, ~500 tris.
- **Fake contact shadows:**
  - blob quads (radial gradient, `depthWrite:false`, `polygonOffset`) scaled and faded by height;
  - high tier adds a **planar projected shadow**: the skinned mesh redrawn flattened onto the floor at 30% black. This is +2 draw calls; skip drei `ContactShadows`, which rendered an opaque plane in soltendogs.
- **Totals:** arena ≈ 20–25k tris (headroom under the 60k budget for Sammy's glb). Fight frame ≈ 20 draw calls, ≤ 120k tris including the planar shadows.
- **Swap path for Sammy's `arena.glb`:** named empties `fire_*`, `crowd_*`, `ringedge_L/R` replace the procedural anchors behind the same `ArenaView` interface.

**Chickens:**
- Clone with `SkeletonUtils.clone`. Plain `.clone()` breaks skinned meshes.
- Clone materials per fighter.
- **A mirror match needs a P2 alternate palette** (hue-shifted body, different eye colour), or two Rust chickens are unreadable.
- Facing: a 5-tick `rotation.y` turn in the view.
- Tiers:
  - Rust: metal 0.6, rough 0.8.
  - Chrome: metal 1, rough 0.12.
  - Gold: metal 1, rough 0.25, colour (1, 0.78, 0.34).
  - Diamond: `MeshPhysicalMaterial` with `iridescence: 1`.

## 5. HUD (DOM overlay, React, `src/components/hud/`)

- **Two channels** so React never re-renders at 60 Hz:
  - Hot values (HP, trail, Heat): the director writes directly to registered elements, `el.style.transform = scaleX(v)` (compositor-only). P2 is mirrored with `transform-origin: right`.
  - Cold values (phase, banner, timer seconds, round wins, paused, winner): a tiny external store read with `useSyncExternalStore`.
- **Damage trail:** set the trail bar to the same value as the main bar, with `transition: transform 350ms ease-in 500ms`.
  - An interrupted CSS transition restarts its delay, so the trail holds for the whole combo and drains after the last hit.
  - Add a white flash class on hit.
- **Heat meter:** at 100, a pulsing glow + "SUPER READY" label (+ `crowd_swell` sound).
- **Timer:** `ceil(ticksLeft/60)`, red pulse under 10 s.
- **Round pips:** 2 per side.
- **Banners** (CSS keyframe overshoot): 3 / 2 / 1 / FIGHT! at countdown ticks, ROUND N, K.O.!, RING OUT!, TIME!, PERFECT.
- **Pause:** Esc or P. Menu: Resume / Restart / Quality / Shake / Mute / Controls / Quit; with a focus trap.
- **Match end:** winner, Rematch, Change mode.
- **Styling and input CSS:**
  - Tailwind; display font via `next/font` (e.g. Bungee, OFL).
  - `touch-action:none` and `user-select:none` on the fight container only (pinch-zoom elsewhere, a soltendogs WCAG lesson).
  - `overscroll-behavior:none` on /play; `contextmenu` blocked on the canvas.

## 6. Procedural audio (`src/game/audio/`)

- **Graph:** buses `sfx`, `crowd`, `ui` → master → `DynamicsCompressor` → destination. `StereoPanner` = `x/10 × 0.6`.
- **Timing:**
  - Prerender with `OfflineAudioContext` (44.1 kHz mono) **during loading, before any user gesture**. Offline rendering is not autoplay-gated.
  - Create/resume the `AudioContext` on the FIGHT button click.
  - Optional for iOS later: `navigator.audioSession.type = 'playback'` so the mute switch is ignored.
- **Per sound:** 4 variants. The variant and ±5% `playbackRate` jitter are chosen by `hash(seed, tick)`, so replays sound the same. Max 4 voices per name (steal the oldest).
- **Reuse** soltendogs `synth.ts` helpers: `rng`, `noiseBuffer`, `env`, `render`.

**Recipes:**

| Sound | Recipe |
|---|---|
| `hit_light` / `hit_heavy` | (1) 3 ms high-passed noise click; (2) inharmonic partials at bar-mode ratios 1 : 2.76 : 5.40 : 8.93, base 420–700 Hz (heavy 180–300), exponential decays 80–250 ms (heavy ×2); (3) sine thump 90→45 Hz over 60 ms (heavy: 60→30 Hz + WaveShaper crunch + noise LP sweep 6k→600). |
| `hit_slam` / `hit_super` | Heavy layers ×1.5, plus a low boom. |
| `block` | Partials low-passed at 2 kHz, 60 ms, plus a tick. |
| `whiff_*` | Bandpassed noise sweep 400→2 kHz, 120 ms. |
| `scream_light` / `_medium` / `_heavy` | Saw carrier with a "bawk" contour 700→1100→600 Hz (90 / 200 / 450 ms); two formant bandpasses (~1 k, ~2.5 k); 28 Hz AM for rasp; ring-mod with a 90 Hz square for "robot"; heavy adds drive and peaks at 1.4 kHz. |
| `scream_ko` | 1.2 s descending wail, vibrato slowing, pitch sliding to 50 Hz ("power-down"). |
| `crowd_loop` | 8 s loopable noise through 3 bandpasses with slow random AM. Hype drives bus gain and BP frequency (`setTargetAtTime`). |
| `crowd_swell` / `crowd_roar` | One-shot swells layered over the loop. |
| `ko_horn` | 3 detuned saws (233 / 236 / 311 Hz), LP 1.8 kHz, onset pitch bend up, drive, 1.4 s. |
| `round_bell` | Partials 1 / 2.0 / 2.76 / 5.4 at 600 Hz, 1.5 s, struck twice. |
| `countdown_tick` / `fight` | Sine at 880 Hz / 1760 Hz. |
| `ringout` | Falling whistle 1.5 k→200 Hz, then a crash. |
| `super_start` | Rising saw 200→1200 Hz with noise roar. |
| Other | `dash`, `jump` (servo glide), `land`, `step`, `heat_full`, `timeout`, `win_jingle`, `ui_move`, `ui_select`, `ui_back`, `pause`. |

**Drop-in for Sammy's sound pack:**
- `manifest.ts` exports a typed `SoundName` union with `{bus, gain, pitchJitter, maxVoices, variants}`.
- Files go at `public/audio/<name>[_N].m4a` (AAC decodes everywhere, including Safari) and are listed in the generated `public/audio/manifest.json`, written by `assets:validate`. No 404 probing.
- Files present → `decodeAudioData`; missing → the procedural recipe. Unit test: every `SoundName` has a recipe.
- `fx/fxTable.ts` maps each `SimEvent` to sounds + particles + trauma + punch + hype in one table.
- Scream tier by damage: <8 light, 8–15 medium, >15 or slam heavy, KO `scream_ko`.

## 7. Performance

**Quality tiers** (`engine/quality.ts`, key `cockfight:quality:1`, versioned like soltendogs):

| Tier | DPR cap | Particles | Shadow | Default for |
|---|---|---|---|---|
| high | min(dpr, 1.5) | on | planar | desktop |
| medium | min(dpr, 1.25) | on | blob | mobile |
| low | max(0.5, min(dpr, 2) × 0.5) ("half-res") | off (HitFlash kept) | blob | — |

- **Keep `antialias:true` in every tier.** It cannot change after the context exists, and MSAA is cheap on tile-based GPUs. This avoids recreating the renderer.
- **Adaptive quality:** judge six 1 s windows, starting only after the first round's countdown (a soltendogs lesson: compile hitches demoted capable machines). Step down if ≥ 3 windows average < 50 fps. Step up at most once. Any manual choice turns adaptive off.
- **Budgets** (asserted in the perf e2e): ≤ 40 draw calls; ≤ 150k tris; ≤ 24 programs; 0 program links after the countdown; no per-frame allocations (preallocated temp vectors — GC jank on Android); canvas ≤ 1.0 MP on mobile medium.
- **Prewarm with `renderer.compileAsync(scene, cam)`** during loading, with every fx mesh visible and `instanceCount > 0` (compile only traverses visible objects), every tier material used in the match, and the KO quad. Soltendogs saw an 80–90 ms first-use stall without this.
- **In-app meter** (`?fps=1` or F3): fps, p50/p95 frame ms over 2 s, draw calls, tris, DPR, tier. Exposed as `__cockfight.perf.snapshot()`.
- **Measuring without a phone:**
  1. **Bench page `/play?bench=1&tier=medium`:** a fixed-seed CPU-vs-CPU full best-of-3 (~3 min, so thermal throttling shows). It reports p50/p95/p99, % of frames > 16.7 ms and the `UNMASKED_RENDERER_WEBGL` GPU string, with a Copy button. Sammy opens it on any phone via the Vercel preview URL or the LAN IP (`next dev -H 0.0.0.0`). This covers the "real mid-range Android" check in the spec with no infrastructure.
  2. **Playwright perf project** adapted from `~/soltendogs/e2e/support/perf.ts`:
     - headless Chromium with `--use-gl=angle --use-angle=metal --ignore-gpu-blocklist --enable-gpu`;
     - config A: desktop, vsync off (headroom);
     - config C: Pixel 7 emulation plus `cdp.send('Emulation.setCPUThrottlingRate', {rate: 4})`, verified with a timing loop.
     - This proxies CPU cost only, not a phone GPU. Headless GPU timer queries are unreliable.
  3. **Optional real-device automation:** BrowserStack Automate supports Playwright on real Android Chrome, if Sammy has an account.
  4. **GPU side:** hold the fill budget (DPR caps, bounded additive overdraw).

## 8. Code layout, mounting, routes, debug

**`src/game/` is framework-free.** Enforce with ESLint `no-restricted-imports: react` outside `src/game/react/`.

```
engine/     createEngine.ts, loop.ts, quality.ts, perf.ts (+bench), assets.ts, debug.ts
match/      LocalMatch.ts, input/{keyboard.ts, bindings.ts, source.ts, cpu.ts}
view/       FightView.ts
            chicken/{ChickenView.ts, materials.ts}
            camera/{FightCamera.ts, noise.ts}
            arena/{Junkyard.ts, crowd.ts, fires.ts, env.ts, sky.ts}
            shadows/{blob.ts, planar.ts}
fx/         Particles.ts, HitFlash.ts, KoPulse.ts, director.ts, fxTable.ts
showcase/   Showcase.ts          (landing: idle clips via mixer.update(dt), random taunt every 4–7 s, fog, one fire)
audio/      AudioEngine.ts, manifest.ts, offline.ts, recipes/{metal, scream, crowd, horn, bell, ui}.ts
react/      FightView.tsx, ShowcaseCanvas.tsx
components/hud/   FightHud, HpBar, HeatMeter, Timer, RoundPips, Banner, PauseMenu, FpsMeter, hudStore.ts
app/        page.tsx
            play/{page.tsx, PlayClient.tsx, ModePicker.tsx}
```

**Mounting:** `dynamic(..., {ssr:false})` is rejected inside Server Components, so call it in a `'use client'` wrapper.

```tsx
// app/play/PlayClient.tsx
'use client';
const FightView = dynamic(() => import('@/game/react/FightView'), { ssr: false, loading: () => <Loading/> });

// game/react/FightView.tsx
useEffect(() => {
  const eng = createFightEngine(host.current!, opts);
  return () => eng.dispose();
}, [key]);
```

**The engine creates and owns its own `<canvas>`.** `dispose()` does `renderer.dispose(); renderer.forceContextLoss(); canvas.remove()`.
- This is safe under StrictMode double mounts. A context lost with `forceContextLoss` stays lost on that canvas, so never reuse the canvas.
- It also avoids "too many WebGL contexts" when navigating / → /play.

**Routes:**
- `/`: hero with `ShowcaseCanvas`. Lazy-load it after first paint with a CSS poster in the meantime. DPR ≤ 1.25, silent, paused when off-screen.
- `/play`: ModePicker (vs CPU with Easy/Normal/Hard | 2P local | Controls | debug tier picker Rust/Chrome/Gold/Diamond) → FIGHT (the audio-unlock gesture) → match → end screen.
- Query params: `mode=cpu|2p`, `seed`, `difficulty`, `tier`, `bench`, `fps`, `debug`, `manual`. Keep `mode` extensible for `'online'`.

**Loaders:**
- One shared GLTFLoader, DRACOLoader and KTX2Loader (`detectSupport(renderer)`).
- Decoders self-hosted in `public/draco/` and `public/basis/`, copied from `three/examples/jsm/libs` at the pinned version.
- **CSP:** add `'wasm-unsafe-eval'` to `script-src` for the Draco/Basis wasm, and `worker-src 'self' blob:` for their blob workers. The soltendogs CSP has neither.
- Workspace TS packages: set `transpilePackages: ['@cockfight/sim', '@cockfight/shared']`.

**Debug handles:**

```ts
window.__cockfight = {
  // read-only
  state(), events(), hud(), perf: { snapshot() }, audio: { recent: SoundName[] }, fx: { live() }, quality,
  // behind ?debug=1
  setInput(p, mask), stepTicks(n), pause(), resume(), loadReplay(log),
};
```

- `?manual=1` stops the rAF sim so e2e is deterministic: step N ticks, assert HP, screenshot KO.
- Online cheating is impossible regardless (the server is authoritative).

**Vitest (node, no WebGL):**
- loop step counts and catch-up cap (fake timestamps);
- keyboard latch;
- camera framing clamps;
- shake determinism (same seed gives identical offsets);
- particle ring-buffer ranges;
- fxTable coverage;
- audio manifest completeness.

**Playwright (functional):**
- real key presses in 2P;
- a scripted CPU match reaching KO;
- zero console errors;
- budgets read from `__cockfight.perf`.

Sources:
- [three.js r186 release notes](https://github.com/mrdoob/three.js/releases/tag/r186)
- [three.js webgl_framebuffer_texture example](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgl_framebuffer_texture.html)
- [BrowserStack: real Android devices on Playwright](https://www.browserstack.com/blog/introducing-android-playwright/)
- [BrowserStack Playwright-Android docs](https://www.browserstack.com/docs/automate/playwright/playwright-android/nodejs)
