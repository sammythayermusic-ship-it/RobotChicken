**Glb pipeline research (Phase 0/1): `assets:validate`, hitbox baking, three.js runtime, textures**

Everything below was checked read-only. I did not create or change any files. The Node probes ran in memory against the packages already installed in `~/soltendogs/node_modules`.

## 0. Verified versions and facts
- **npm today:** three **0.186.0** (r186, released 2026-09-08), @types/three 0.186.0, @gltf-transform/{core,extensions,functions,cli} **4.5.0**, draco3dgltf **1.5.7**, ktx-parse 2.0.0 (gltf-transform itself depends on ^1.1.0), gltf-validator 2.0.0-dev.3.10, tsx 4.23.15, @react-three/fiber 9.8.0, drei 10.7.8, vitest 5.0.1.
- **Pin three exactly** (`"three": "0.186.0"`). The copied decoder files must come from the same version.
- **Blender 5.2.1 exporter** is io_scene_gltf2 5.2.40. I read its option names from `/Applications/Blender.app/Contents/Resources/5.2/scripts/addons_core/io_scene_gltf2/__init__.py`.
- **Node 22.22.2 strips TypeScript types natively.** Still use `tsx` for the tools: native stripping rejects enums and needs `.ts` import extensions, and workspace packages resolve through node_modules symlinks.

**Probe results:**
- `NodeIO` plus `draco3dgltf` decodes a Draco glb fine.
- three's `GLTFLoader.parseAsync` works in plain Node 22 without any DOM, as long as the file has no Draco and no textures.
- three's `DRACOLoader` fails in Node with "Failed to parse URL … draco_wasm_wrapper.js". It needs fetch of relative URLs plus Blob workers.
- The custom evaluator sketched in (b) matched `AnimationMixer` exactly (max error 0) on a test rig covering LINEAR rotation, STEP translation, CUBICSPLINE scale, hierarchy and extras.
- three copies glTF extras into `object.userData`.

## 1. Blender export contract (`tools/blender/export_chicken.py`, run headless)
Run: `/Applications/Blender.app/Contents/MacOS/Blender -b art/chicken.blend --python tools/blender/export_chicken.py -- --out apps/web/public/models/chicken.glb`

`pnpm assets:import` = that export, then validate, then bake.

The script selects Rig, the mesh and both empties. It copies each empty's `empty_display_size × max(scale)` into a custom property `cf_radius` when missing. Then:
```python
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True,
  export_yup=True, export_apply=True, export_extras=True,          # extras carry cf_radius/cf_half_height
  export_image_format='NONE',                                       # tier textures ship as separate KTX2
  export_skins=True, export_def_bones=True, export_influence_nb=4, export_morph=False,
  export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
  export_frame_step=1, export_optimize_animation_size=True, export_anim_slide_to_zero=True,
  export_reset_pose_bones=True, export_rest_position_armature=True,
  export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
  export_draco_position_quantization=14, export_draco_normal_quantization=10,
  export_draco_texcoord_quantization=12, export_draco_generic_quantization=12,
  export_cameras=False, export_lights=False)
```
Spec corrections this implies:
- **"Group by NLA track"** (`export_nla_strips`) does nothing since Blender 3.6. Use `export_animation_mode='ACTIONS'`.
- **Texcoord quantization 8** gives a UV step of 1/256, about 8 texels on a 2k map. Use 12.
- **`export_apply`** applies modifiers only. "Apply all transforms" is a separate Ctrl+A step Sammy does in Blender.
- **`export_extras`** defaults to False, and **`export_anim_slide_to_zero`** defaults to False. A Blender action that starts on frame 1 would otherwise export with a time offset.
- **Multi-slot actions** (Blender 4.4+) export as `"<action>-<slot>"`, for example `peck-Rig`. Validate must point this out.
- **`export_def_bones=True`** drops non-deform bones. Mark `root` as Deform, and parent the empties to deform bones.
- **Author at 60 fps**, so Blender frame numbers equal sim ticks. Never change fps inside the script: that retimes the clips.
- **Forward axis:** the chicken faces Blender −Y ("Front" view), which becomes **glTF +Z**. The capsule axis is the empty's Blender local +Z, which becomes glTF local +Y.

## 2. (a) `pnpm assets:validate` → `tsx tools/assets/validate.ts [--json]`
Budgets and the list of required clips live in `tools/assets/config.ts`. The 21 clip names are imported from `packages/sim/src/clips.ts`, the single source of truth. Errors exit 1, warnings don't. It runs in CI on the committed glbs and needs no Blender or ktx.

**Fighter rules** (the hero chicken, and the placeholder with `requireKtx2:false`):
1. **Parse:** NodeIO with ALL_EXTENSIONS and the Draco decoder succeeds. gltf-validator `validateBytes` reports 0 errors.
2. **Extensions:** `extensionsUsed` must be within {KHR_draco_mesh_compression, KHR_texture_basisu, KHR_materials_emissive_strength, KHR_texture_transform, KHR_mesh_quantization}. Warn if Draco is not used.
3. **Node names:** glTF names are unique. three renames duplicates to `x_1`. Warn on names containing `.`, `:`, `/`, `[`, `]` or spaces: three sanitizes on load, so `wing.L` becomes `wingL` and `hit beak` becomes `hit_beak`.
4. **Rig:** a node `Rig` exists with identity TRS (±1e-4).
5. **root bone:** `root` is a skin joint, it is the top joint, and its world translation at rest is under 1e-3.
6. **Skinned mesh:** exactly **one** node with both a mesh and a skin. Warn if it has more than 3 primitives (each primitive is one draw call). Warn on any non-skinned mesh node.
7. **Bones:** `skin.listJoints().length ≤ 40`.
8. **Triangles:** the skinned mesh's triangle count, summed with `getGLPrimitiveCount`, is **≤ 15,000**.
9. **Hitbox empties:** `hurt_body` and `hit_beak` each exist exactly once, are descendants of `Rig`, have no mesh, and carry numeric extras: `cf_radius > 0` on both, `cf_half_height ≥ 0` on hurt_body. The error hint tells Sammy to use the export script or tick Include › Custom Properties.
10. **Clips, by name:**
    - Every missing required clip and every extra clip is listed by name.
    - Near-miss hints: a case difference (`Peck`), a slot suffix (`peck-Rig`), `.` or space for `_` (`walk.fwd`), or Levenshtein distance ≤ 2.
    - Duplicate names are an error.
11. **Per-clip checks:**
    - First keyframe time is 0 (±1e-4).
    - Warn if the keyframe spacing isn't 1/60 s (24 fps means the scene wasn't set to 60).
    - **Root motion:** error if any translation channel on `root` or `Rig` moves by more than 1e-3.
    - Warn on channels that target anything other than joints or the two empties.
    - Warn if loop clips (idle, walk_fwd, walk_back, block) have first and last poses more than 2° apart.
12. **Sanity:**
    - The skinned mesh's bounding-box width is between 0.5 and 2 units.
    - `bbox.min.y` is within ±0.05.
    - **Facing:** at idle frame 0, hit_beak's forward coordinate must exceed hurt_body's, or report "wrong facing".
13. **moves.json cross-check:** every `moves[*].clip` exists in the glb and in hitboxes.json. `hitboxes.json.source.sha256` must equal the glb's sha256, else "run pnpm assets:bake".
14. **Textures (via `inspect(doc).textures`):** all `image/ktx2`, at most 2048, power of two. Warn if a normal map is ETC1S.
15. **Tier KTX2 files** `public/textures/chicken/<tier>/{basecolor,orm,normal,emissive}.ktx2`, read with ktx-parse `read()`:
    - `pixelWidth` ≤ 2048.
    - `dataFormatDescriptor[0].transferFunction` is `KHR_DF_TRANSFER_SRGB` for basecolor and emissive, linear for the rest.
    - The color model is ETC1S or UASTC.

**Arena rules:**
- Total triangles ≤ 60k, counted as mesh triangles × instances (including the `EXT_mesh_gpu_instancing` count).
- Lit meshes have `TEXCOORD_1`.
- `arena_lightmap.ktx2` is at most 4096.

**Total first load:** chicken.glb + Rust textures + arena.glb + lightmap + decoders (~0.8 MB) + audio must be **≤ 12 MB**, counting raw bytes (KTX2 and glb gain little from gzip). Print a per-file table.

```ts
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() }); // import draco3d from 'draco3dgltf'
const doc = await io.read(file); const root = doc.getRoot(); const report = inspect(doc);
const skinned = root.listNodes().filter(n => n.getMesh() && n.getSkin());
const tris = skinned.flatMap(n => n.getMesh()!.listPrimitives()).reduce((s, p) => s + getGLPrimitiveCount(p), 0);
const joints = skinned[0]?.getSkin()!.listJoints() ?? [];
const clips = root.listAnimations().map(a => a.getName());
const missing = REQUIRED_CLIPS.filter(c => !clips.includes(c)), extra = clips.filter(c => !REQUIRED_CLIPS.includes(c));
const near = (m: string) => extra.find(e => { const k = e.split('-')[0].replace(/[ .]/g, '_').toLowerCase(); return k === m || lev(k, m) <= 2; });
for (const m of missing) err('clips', `missing "${m}"${near(m) ? ` (found "${near(m)}")` : ''}`);
for (const a of root.listAnimations()) for (const ch of a.listChannels()) {
  const n = ch.getTargetNode(); if (ch.getTargetPath() !== 'translation' || !(n === rigNode || n === rootBone)) continue;
  const v = ch.getSampler()!.getOutput()!.getArray()!; if (maxDev(v, 3) > 1e-3) err('root-motion', `${a.getName()} moves ${n!.getName()}`);
}
```

## 3. (b) Hitbox baking → `tsx tools/bake-hitboxes.ts [--check]`
**Recommendation: a custom evaluator on the gltf-transform document.**
- It sets each node's TRS from sampled channels, then calls `node.getWorldMatrix()`, so gltf-transform does the hierarchy math.
- It uses the same reader as validate. It needs no browser shims, no workers and no three.

**Why not three headless:** its DRACOLoader and KTX2Loader need workers and fetch, so you would have to decode Draco and strip textures with gltf-transform anyway. That's two code paths for no gain. Three is used only as a **parity oracle** in a vitest test:
1. Read the glb with NodeIO.
2. Dispose the `KHR_draco_mesh_compression` extension and all textures.
3. `writeBinary`, then `GLTFLoader.parseAsync`, then an `AnimationMixer`.
4. For every clip and tick: `action.time = f/60; mixer.update(0)`.
5. Assert that the `hit_beak` and `hurt_body` world positions, ×1000, are within ±1 of the baked values.

I ran this exact path in Node and it works.

**Floats only at bake time.** The bake rounds with `Math.round(x*1000)+0` (the `+0` turns −0 into 0). The sim only indexes integer arrays. The JSON is committed. In CI, `--check` re-bakes and diffs exactly; this is deterministic on a pinned Node, since V8's math functions are fdlibm ports.

**Sizes come from extras, not scale.** Ctrl+A folds an empty's scale into its display size, and glTF doesn't export display size. So:
- `hit_beak` is a circle with radius `cf_radius × maxScale(world)`.
- `hurt_body` is a capsule along its local ±Y: endpoints `M·(0, ±cf_half_height, 0)`, radius `cf_radius × maxScale`.
- Everything is projected to the 2.5D plane: sim x is glTF +Z (forward), sim y is +Y. Depth is dropped.

```ts
function sample(s: AnimationSampler, t: number): number[] {
  const inp = s.getInput()!.getArray()!, out = s.getOutput()!.getArray()!, k = s.getOutput()!.getElementSize();
  const mode = s.getInterpolation(), cub = mode === 'CUBICSPLINE', st = cub ? 3*k : k, o = cub ? k : 0, n = inp.length;
  const at = (i: number) => Array.from(out.subarray(i*st+o, i*st+o+k));
  if (t <= inp[0]) return at(0); if (t >= inp[n-1]) return at(n-1);
  let lo = 0, hi = n-1; while (hi-lo > 1) { const m = (lo+hi) >> 1; (inp[m] <= t) ? lo = m : hi = m; }
  const dt = inp[hi]-inp[lo], u = (t-inp[lo])/dt;
  if (mode === 'STEP') return at(lo);
  if (cub) { const p0 = at(lo), p1 = at(hi), u2 = u*u, u3 = u2*u;
    const m0 = Array.from(out.subarray(lo*st+2*k, lo*st+3*k)), m1 = Array.from(out.subarray(hi*st, hi*st+k));
    const r = p0.map((_, j) => (2*u3-3*u2+1)*p0[j] + (u3-2*u2+u)*m0[j]*dt + (-2*u3+3*u2)*p1[j] + (u3-u2)*m1[j]*dt);
    return k === 4 ? norm(r) : r; }
  return k === 4 ? slerp(at(lo), at(hi), u) : at(lo).map((v, j) => v + (at(hi)[j]-v)*u);
}
// slerp: flip b if dot<0; lerp+normalize if dot>0.9995; else sin-weighted
function poseAt(anim: Animation, t: number) {
  for (const [n, T, R, S] of rest) n.setTranslation(T).setRotation(R).setScale(S); // untracked props = rest (matches three restoring original state)
  for (const ch of anim.listChannels()) { const v = sample(ch.getSampler()!, t) as any, n = ch.getTargetNode()!;
    ({ translation: () => n.setTranslation(v), rotation: () => n.setRotation(v), scale: () => n.setScale(v) } as any)[ch.getTargetPath()!]?.(); }
}
const xf = (m: mat4, [x, y, z]: number[]) => [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];
const q = (v: number) => Math.round(v * 1000) + 0;
for (const anim of root.listAnimations()) {
  const frames = Math.round(maxInput(anim) * 60) + 1, hurt: number[] = [], hit: number[] = [];
  for (let f = 0; f < frames; f++) { poseAt(anim, f / 60);
    const mh = hurtNode.getWorldMatrix(), mb = beakNode.getWorldMatrix(), a = xf(mh, [0,-HH,0]), b = xf(mh, [0,HH,0]), p = xf(mb, [0,0,0]);
    hurt.push(q(a[2]), q(a[1]), q(b[2]), q(b[1]), q(R_HURT*maxScale(mh))); hit.push(q(p[2]), q(p[1]), q(R_HIT*maxScale(mb))); }
  out.clips[anim.getName()] = { frames, hurt, hit };   // flat int arrays: 5/frame, 3/frame
}
```
**Output:** `packages/sim/data/hitboxes.json` = `{version, rate:60, units:1000, forward:"+Z", source:{file, sha256}, clips}`. Node ESM needs `import hb from '../data/hitboxes.json' with { type: 'json' }` plus `resolveJsonModule`.

**Retime in the sim, shared by the renderer.** moves.json holds `{clip, startup, active, recovery, hitNode?:"hit_beak", clipContact?:[c0,c1]}`. The piecewise-integer map below means frame data can be retuned without a re-export:
```ts
export function clipFrame(m: Move, t: number, frames: number): number {
  const s = m.startup, a = m.active, r = m.recovery, last = frames - 1;
  const [c0, c1] = m.clipContact ?? [Math.trunc(last*s/(s+a+r)), Math.trunc(last*(s+a)/(s+a+r))];
  if (t < s) return Math.trunc(t*c0/s);
  if (t < s+a) return c0 + Math.trunc((t-s)*(c1-c0)/a);
  return Math.min(last, c1 + Math.trunc((t-s-a)*(last-c1)/Math.max(1, r)));
}
// hit test (2D, ints; all products < 2^53; Math.trunc not |0)
function circleCapsule(px:number,py:number,pr:number, ax:number,ay:number,bx:number,by:number,cr:number) {
  const abx=bx-ax, aby=by-ay, apx=px-ax, apy=py-ay, L=abx*abx+aby*aby, d=apx*abx+apy*aby;
  const [dx,dy] = d<=0||L===0 ? [apx,apy] : d>=L ? [px-bx,py-by] : [apx-Math.trunc(abx*d/L), apy-Math.trunc(aby*d/L)];
  const R = pr+cr; return dx*dx+dy*dy <= R*R;
}
```
The world position is `pos.x + facing*hit[3f]`.
- Extra `hit_*` empties (for example `hit_foot` for the dive kick) should be accepted by the bake, chosen per move with `hitNode`, and only produce a warning in validate.
- The super keeps `hitbox:"screen"` in moves.json.

## 4. (c) three.js runtime (r186)
**Loaders:** one singleton each, never disposed in React effect cleanup. Import from `three/addons/...` paths, never the `Addons.js` barrel.
```ts
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
export function initLoaders(renderer: WebGLRenderer) {
  if (L) return L;
  const draco = new DRACOLoader().setDecoderPath('/decoders/draco/').preload();   // fetches wrapper.js+wasm only
  const ktx2 = new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(renderer); // before any load
  return (L = { gltf: new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2), ktx2 });
}
```
- **Decoders: self-host, not the gstatic CDN.** A `postinstall` script (`tools/copy-decoders.mjs`) copies these into `apps/web/public/decoders/`:
  - from `three/examples/jsm/libs/draco/gltf/`: `draco_wasm_wrapper.js` and `draco_decoder.wasm` (~250 KB)
  - from `libs/basis/`: `basis_transcoder.{js,wasm}` (~580 KB)

  Why self-host: same origin, matches the pinned three version, no third-party outage or CSP entry, no extra DNS/TLS round trip.
- **r185+ bundler risk.** The loaders now default to `new URL('../libs/…', import.meta.url)`. Webpack 5 and Turbopack then parse the Emscripten files and fail on `fs`/`path` (three.js issue #34627, milestoned for r187). `setDecoderPath` does not prevent this, because the build-time analysis happens anyway.
  - soltendogs only escaped because tree-shaking dropped the loaders from its `Addons.js` barrel import. Its built bundle contains drei/three-stdlib's Draco loader with the gstatic 1.5.5 default, not three's.
  - **Phase 0 must run a real `next build`.** If it fails, use `pnpm patch three@0.186.0` to replace the six `new URL(...)` defaults with plain strings, or add webpack `resolve.fallback {fs:false, path:false}` or Turbopack `resolveAlias`.
- **Rendering setup:**
  - Mount the canvas with `dynamic(..., {ssr:false})`.
  - Use WebGLRenderer for Phase 1. WebGPU needs `await renderer.init()` before `detectSupport`.
  - CSP needs `worker-src 'self' blob:` and `script-src 'wasm-unsafe-eval'`. The loaders build blob workers that compile wasm, and soltendogs' report-only CSP lacks this.
  - Cache headers: serve `/models`, `/textures` and `/decoders` with `max-age=31536000, immutable`, fetched as `?v=<sha8>` from a manifest that validate writes.
- **Don't use drei `useGLTF`.** It uses three-stdlib's GLTFLoader and a gstatic Draco 1.5.5 default. Use the singleton above wrapped in a promise cache (and `use()`/Suspense if R3F is used).

**Two fighters from one glb:**
```ts
class FighterView {
  root = cloneSkinned(src.scene); mixer = new AnimationMixer(this.root); acts: Record<string, AnimationAction> = {};
  constructor(src: GLTF, mat: Material) {
    this.root.traverse(o => { if ((o as SkinnedMesh).isSkinnedMesh) { o.frustumCulled = false; (o as Mesh).material = mat; }
                              if (o.name === 'hurt_body' || o.name === 'hit_beak') o.visible = false; });
    for (const c of src.animations) { const a = this.mixer.clipAction(c); a.play(); a.setEffectiveWeight(0); this.acts[c.name] = a; }
  }
  pose(to: string, toF: number, from: string | null, fromF: number, w: number) {  // all from sim state
    for (const k in this.acts) this.acts[k].setEffectiveWeight(0);
    const A = this.acts[to]; A.time = toF / 60; A.setEffectiveWeight(from && from !== to ? w : 1);
    if (from && from !== to && w < 1) { const B = this.acts[from]; B.time = fromF / 60; B.setEffectiveWeight(1 - w); }
    this.mixer.update(0);
  }
}
```
- **Why `update(0)` is safe:** I read the source. `AnimationAction._updateTime(0)` returns `this.time` immediately, before any loop, clamp or 'finished' logic. So setting `action.time` and calling `mixer.update(0)` is a pure function of sim state. Hit-stop freezes (stateTick stops advancing), and replays and rollback reproduce exactly.
- **Never use `crossFadeTo` or `mixer.setTime`.** Fades run on mixer time, which never advances here, and `setTime` triggers LoopOnce disable/clamp.
- **Weights must sum to 1.** `PropertyMixer` fills any remainder with the rest pose.
- Clips are shared across both mixers. Bindings resolve by name within each clone's root.

**Blending policy:** a pure function of the sim. Record `animFrom` and `animFromFrame` in `FighterState` at each state change, and freeze the from-pose there.
- Attacks, hits, block_hit, KO: 0 ticks (snap), so frame data stays readable.
- Landing and getup: 3 ticks.
- idle ↔ walk: 6 ticks.
- Loops: `frame = stateTick % (frames-1)`.
- Facing: `root.rotation.y = facing > 0 ? +π/2 : −π/2` maps model +Z to ±X. Don't mirror with `scale.x = -1`.

**Tier materials:** swap by the authored material name (for example `MAT_chicken`), never by primitive order.
- Build and cache one material per tier:
  - Rust, Chrome and Gold: `MeshStandardMaterial`.
  - Diamond: `MeshPhysicalMaterial({iridescence:1, iridescenceIOR:1.3, iridescenceThicknessRange:[100,800]})`.
- Texture maps: `map=basecolor`, `roughnessMap=metalnessMap=orm` (G = roughness, B = metalness, R = AO if present), `normalMap`, `emissiveMap` with `emissive=#fff`.
- `KTX2Loader.loadAsync` textures have `flipY=false`, which matches glTF UVs. The color space comes from the file's DFD transfer function; set it explicitly anyway.
- Clone the material per fighter (textures stay shared) so hit-flash emissive doesn't bleed to a same-tier opponent.
- Preload Rust. Lazy-load the other tiers.
- Arena lightmap: `mat.lightMap = lm; lm.channel = 1`. GLTFLoader maps TEXCOORD_1 to `uv1`.
- The live `hit_beak` Object3D is a free anchor for sparks and trails. The debug overlay should draw from hitboxes.json, not from the empties.

## 5. (d) soltendogs `SkinnedDogRig.tsx` lessons to reuse
- `SkeletonUtils.clone` inside `useMemo`, and `frustumCulled=false` on skinned meshes.
- One glTF mesh with N materials arrives as N `SkinnedMesh` children (the dog has 5). Match by `material.name`.
- **StrictMode:** attach in effects and dispose only when a genuinely new value replaces the old one. Never dispose cached glTF resources.
- Take rest-pose and attachment corrections from the unposed clone at build time, never from a live bone.
- The dog is posed procedurally with no clips, so there's no mixer precedent to copy.
- `build_dog.py`'s `export_apply=True` applies modifiers only.
- Don't copy its `three/examples/jsm/Addons.js` barrel import.

## 6. (e) `tools/textures.sh`
- **Use `ktx`, not `toktx`.** `toktx` is deprecated; KTX-Software's 4.4.2 notes say the legacy tools are removed in 4.5 (5.0.0-rc2 is out). gltf-transform 4.5's `etc1s`/`uastc` commands also call **`ktx create`** and require KTX-Software ≥ 4.4.0.
- **Install:** there is no Homebrew formula (`brew search ktx` finds nothing). Use `KTX-Software-4.4.2-Darwin-arm64.pkg` from the v4.4.2 GitHub release (2025-10-04).
```bash
#!/usr/bin/env bash
set -euo pipefail
if ! command -v ktx >/dev/null; then cat >&2 <<'EOF'
textures.sh: KTX-Software `ktx` (>=4.4) not found. Install KTX-Software-4.4.2-Darwin-arm64.pkg from
https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2 (no Homebrew formula; toktx is deprecated).
Committed .ktx2 files still work; only re-encoding needs ktx.
EOF
exit 3; fi
color()  { ktx create --format R8G8B8_SRGB  --assign-tf srgb   --assign-primaries bt709 --encode basis-lz --clevel 4 --qlevel 200 --generate-mipmap "$1" "$2"; }
linear() { ktx create --format R8G8B8_UNORM --assign-tf linear --assign-primaries none  --encode uastc --uastc-quality 2 ${3:-} --zstd 18 --generate-mipmap "$1" "$2"; }
# art/textures/<tier>/{basecolor,emissive}.png -> color; orm.png -> linear "--uastc-rdo"; normal.png -> linear (no RDO, no --normal-mode: three expects RGB)
# arena glb: npx gltf-transform etc1s in.glb out.glb --slots "{baseColorTexture,emissiveTexture}" && gltf-transform uastc ... --slots "{normalTexture,metallicRoughnessTexture}"
# skip if out newer than in; inputs 8-bit PNG, power-of-two
```
- Base color with alpha uses `R8G8B8A8_SRGB`.
- `--zstd` can't be combined with basis-lz.
- **Budget math is tight:** 2k UASTC+zstd normal ~2–4 MB, ETC1S colour ~0.5–1 MB, 4k ETC1S lightmap ~2–4 MB. Validate's 12 MB total is the arbiter; if over, drop the normal map to 1k or ETC1S.

## 7. Other pitfalls
- **Validate against exact glTF names.** Code must look nodes up by their sanitized three.js names, which is why the required names avoid `.` and spaces.
- **Placeholder chicken:** it must satisfy the same contract (Rig, root, both empties with extras, all 21 clips) so validate and bake run in CI. It can be generated by a gltf-transform TS script (rigid skinning, one bone per box) or a headless Blender script.
- **Animation bytes:** 21 sampled clips with ~40 joints is roughly 0.5–2 MB, and Draco doesn't compress animation. Validate should report `inspect().animations[].size`. Blender 5.2 can export EXT_meshopt, but the spec requires Draco, so keep Draco.

Sources: [three.js issue #34627](https://github.com/mrdoob/three.js/issues/34627), [KTX-Software releases](https://github.com/KhronosGroup/KTX-Software/releases), [ktx create reference](https://github.khronos.org/KTX-Software/ktxtools/ktx_create.html), [KTX-Software repo](https://github.com/khronosgroup/ktx-software).
