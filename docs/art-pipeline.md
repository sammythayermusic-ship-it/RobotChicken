# Art pipeline: Blender → glTF → game

Everything the game needs from a chicken is defined in
`packages/sim/data/chicken.contract.json`: the 21 clip names and frame counts, the two hitbox
helpers, the material slots and the budgets. The placeholder chicken is built from that same
contract by `art/blender/build_placeholder_chicken.py`, so the game is always playable.

## The one-command path (recommended)

```bash
pnpm assets:import --blend art/chicken.blend
```

It runs three stages and stops at the first one that fails, saying exactly what to change:

1. **export**: Blender runs headless on your .blend with `art/blender/export_chicken.py`
   (the exporter settings live in `art/blender/cf_common.py`). Habits with one right answer
   are fixed on the fly (listed as `fixed:`); everything else is listed at once, numbered,
   with the change to make in Blender. Your .blend is never modified or saved.
2. **validate**: the glb is checked against the contract, `moves.json` and the budgets
   (`pnpm assets:validate`, below).
3. **bake**: the hitbox helpers are sampled on every frame of every clip into
   `packages/sim/data/hitboxes.json`. Its `source.file` and `sha256` now name the new glb,
   and that is what makes the game load it.

The glb goes to `apps/web/public/models/chicken.glb` (`--out` picks another file under
`apps/web/public/`; the placeholder's file is off limits). Relative paths are relative to
the directory you run the command from. The glb and the bake are staged in
`art/blender/out/` (gitignored) and moved into place together only after all three stages
pass, so a failed or interrupted (Ctrl-C) import never leaves the game half-updated or stray
files in the repo.

A hero chicken changes gameplay (its helpers are the hitboxes), so a successful import changes
the rules hash. It prints the next steps:

```bash
pnpm replay:golden --bless        # every golden replay changes with the hitboxes
pnpm test && pnpm assets:validate && pnpm assets:bake --check
pnpm dev                          # then http://localhost:3000/play?debug=1 (H toggles the hitbox overlay)
```

Commit the glb, `hitboxes.json` and the re-blessed goldens together, and say why.

| Option | What it does |
|---|---|
| `--out <file.glb>` | where the glb goes (default `apps/web/public/models/chicken.glb`, or `art/blender/out/<name>.glb` in a dry run) |
| `--retime` | the file is not at 60 fps: scale every clip to 60 fps, keeping its real-time length, instead of failing |
| `--hitboxes <file.json>` | a dry run: bake somewhere else, so the game keeps loading what it loads now. The glb goes to `art/blender/out/<name of the .blend>.glb` unless `--out` says otherwise, and it may never be the glb `hitboxes.json` names |

Exit codes: 0 done, 1 a stage failed, 2 bad arguments, 3 Blender not found (it looks at
`$BLENDER`, then `/Applications/Blender.app`, then `blender` on `PATH`).

### What the export fixes for you

| You left... | The export... |
|---|---|
| actions that were never pushed down to the NLA, or the last clip still in the Action Editor | puts each on its own NLA track named after it |
| clips that start on frame 1 (Blender's default) | slides them to 0 (glTF "Set all animations starting at 0") |
| the file in Pose or Edit mode, or in NLA tweak mode | switches to Object mode / leaves tweak mode |
| the armature showing its Rest Position | switches it to Pose Position (otherwise every clip would export as the rest pose) |
| the hitbox empties hidden | unhides them for the export |
| an attack whose action has `cf_phases` but a different length or split than the contract | retimes it to the contract phase by phase (wind-up onto startup, hit onto active, recovery onto recovery) |
| IK / control bones | nothing: bones not marked Deform are not exported and don't count toward the 40 joints |
| a scene at 24 fps, with `--retime` | scales every clip by 60/24, keeping its real-time length; a clip within one of your frames of its contract length is stretched onto it exactly |

### What it asks you to fix

| Problem | The hint says |
|---|---|
| the scene is not at 60 fps (without `--retime`) | set Output Properties > Frame Rate to 60 if your keys are already on the contract's frame counts; re-run with `--retime` if you animated at 24 fps by eye |
| a stray action: `Action`, `RigAction`, a `peck.001` copy, `Peck` instead of `peck` | its name, and whether to delete it or rename it (every armature action exports as a clip) |
| a hitbox empty without `cf_radius` | the empty's name, and the value to use: its display size (glTF does not export display sizes) |
| a hitbox empty without `cf_shape` / `cf_half_height`, or parented to the object instead of a bone | the property to add, or Ctrl+P > Bone |
| an attack clip without `cf_phases` whose length is not the move's in `moves.json` | both numbers (e.g. 18 frames vs 4 + 2 + 8 = 14) and the two ways out: fix the length, or add `cf_phases` |
| any other clip whose length is not the contract's | both numbers |
| an action with several slots, or on several NLA tracks | keep one |
| more than 40 bones marked Deform | untick Deform on control/IK/mechanism bones |

## Rig requirements

- Armature named `Rig`, root bone `root` at the origin, marked **Deform**. Root motion stays off:
  `root` must not move in any clip (the simulation moves the fighter).
- Scale 1.0 = 1 game unit ≈ one chicken width. Apply all transforms. The chicken faces **-Y**
  in Blender (it exports as +Z).
- One skinned mesh, ≤ 15k triangles, ≤ 40 deform bones (non-deform IK/control bones are fine;
  they aren't exported).
- Materials named `cf_shell`, `cf_trim`, `cf_eye`, `cf_beak`, `cf_comb`. Tiers swap `cf_shell`,
  `cf_trim` and `cf_eye` at runtime; beak and comb keep your look.
- Two empties parented to bones (Parent Type: Bone):
  - `hurt_body` on the body bone: the capsule you can be hit on. Custom properties:
    `cf_shape = "capsule"`, `cf_radius` and `cf_half_height` (in units; the capsule's axis is the
    empty's local Z in Blender, which is local +Y in the glb).
  - `hit_beak` on the head bone: the sphere that hits. Custom properties: `cf_shape = "sphere"`,
    `cf_radius`.
  Empties' display size isn't exported by glTF, which is why the sizes are custom properties.
  Don't key the empties: they follow their bones.

## Animations

- 60 fps scene, 1 frame = 1 simulation tick. One Action per clip, named exactly as the contract.
  Each ends up on its own NLA track of the same name (the export does this if you didn't).
  Any other armature action (a stray `Action`, a `.001` copy) fails the export on purpose,
  because it would ship as an extra clip.
- Clip lengths: frame 0 is the pose *before* the move's first tick; a clip of N frames spans
  N frames (0..N, or 1..N+1: starting on frame 1 is fine).
- Attacks (peck, shove, slam, dive_kick, super): the clip is either as long as the move in
  `moves.json` (startup + active + recovery), or the Action carries a custom property
  `cf_phases = [startup, active, recovery]` describing your own split, and the export retimes it
  to the contract phase by phase. The dive kick's active window is open-ended in `moves.json`
  (it lasts until landing), so without `cf_phases` it must be the contract's 30 frames. Either
  way moves can be retuned in `moves.json` later without re-exporting.
- During an attack's active frames the `hit_beak` helper must reach the opponent (it is what
  hits). `assets:validate` checks it is in front of the body's center and not entirely below the
  floor on every active frame.

## Manual export (fallback)

Install the exporter preset once: copy `art/blender/presets/cockfight_glb.py` to

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/Blender/5.2/scripts/presets/operator/export_scene.gltf/` |
| Windows | `%APPDATA%\Blender Foundation\Blender\5.2\scripts\presets\operator\export_scene.gltf\` |
| Linux | `~/.config/blender/5.2/scripts/presets/operator/export_scene.gltf/` |

Then select `Rig` and everything parented to it, File → Export → glTF 2.0 (.glb), and pick
**Cockfight Glb** from the preset menu at the top of the dialog. It sets exactly the scripted
exporter's settings (a test checks the two stay equal and export the same bytes):

| Setting | Value |
|---|---|
| Format | glTF Binary (.glb) |
| Include | Selected Objects (select `Rig` and its children) · Custom Properties ✅ |
| Transform | +Y Up ✅ |
| Data → Armature | Use Rest Position ✅ · Export Deformation Bones Only ✅ |
| Animation | Mode: **Actions** · Export all Armature Actions ✅ · Always Sample Animations ✅ · Sampling Rate 1 · Set all glTF Animation Starting at 0 ✅ · Merge Animation: **NLA Track Names** · Optimize Animation Size ✅ |
| Compression | Draco ✅ · level 6 · quantization **position 14, normal 10, texcoord 12**, color 8, generic 12 |
| Textures | none embedded (tier textures ship as separate KTX2 files) |

"Group by NLA Track" (from older checklists) has done nothing since Blender 3.6; the settings
above replace it. A manual export gets none of the fixes above, so the file must already be
clean. Then run `pnpm assets:validate apps/web/public/models/<file>.glb` and
`pnpm assets:bake apps/web/public/models/<file>.glb`.

## Validation: `pnpm assets:validate [glb] [--json] [--arena=<file>]`

Validates the glb `hitboxes.json` tracks (or the one given), and the arena whenever there is
one (below). CI runs it on every push and never needs Blender. It checks:

- the contract: rig, root bone, one skinned mesh, joints, triangles, material slots, helpers and
  their extras, the 21 clips with their exact frame counts, no root motion, facing;
- `moves.json`: every clip a move plays exists in the glb and has a hit table in
  `hitboxes.json`, and during each attack's active frames the hit helper is in front of
  `hurt_body`'s center and reaches above the floor;
- textures, when there are any (the placeholder has none, so these rules skip): KTX2 with Basis
  inside (`KHR_texture_basisu`), power-of-two sides ≤ 2048, color maps (base color, emissive)
  sRGB, data maps (normal, metal/rough, occlusion) linear, normal maps RGB (not the two-channel
  `--normal-mode` layout); the same for the tier sets below;
- `hitboxes.json` was baked from exactly this file (sha256).

It also prints each clip's animation size and the **first-load table**: the art assets a new
player downloads before the first fight, in raw bytes, which must stay ≤ 12 MB. That is the
chicken glb, the Draco decoder, the Rust tier textures (plus the Basis transcoder once there is
any KTX2), Sammy's arena and lightmap when they exist, and any audio overrides in
`apps/web/public/audio/`. The app's own code (the Next.js and three.js JavaScript, CSS and
fonts) is not in the table: the 12 MB is the art budget (`docs/decisions.md`, "First load"), so
leave headroom under the spec's 12 MB on the wire for it. The Chrome, Gold and Diamond tier sets
load lazily and are listed separately.

## Textures (later)

Tier sets live in `apps/web/public/textures/chicken/<tier>/` (`rust`, `chrome`, `gold`,
`diamond`) as `basecolor.ktx2`, `orm.ktx2` (occlusion / roughness / metalness packed),
`normal.ktx2` and `emissive.ktx2`, each ≤ 2048 and a power of two. Put 8-bit PNGs in
`art/textures/<tier>/{basecolor,orm,normal,emissive}.png` and run

```bash
pnpm textures             # converts every PNG it finds, then: pnpm assets:validate
pnpm textures --dry-run   # prints the ktx commands instead (no KTX-Software needed)
```

It needs [KTX-Software 4.4](https://github.com/KhronosGroup/KTX-Software/releases)'s `ktx`
(`toktx` is deprecated). For reference, the commands it runs:

```bash
# color maps (basecolor, emissive): sRGB, ETC1S
ktx create --generate-mipmap --fail-on-color-conversions --format R8G8B8_SRGB --assign-tf srgb \
  --assign-primaries bt709 --encode basis-lz --clevel 4 --qlevel 200 basecolor.png basecolor.ktx2
# data maps (orm, normal): linear, UASTC + RDO + Zstandard (--uastc-rdo-l 1.0 for orm, 0.5 for normal)
ktx create --generate-mipmap --fail-on-color-conversions --format R8G8B8_UNORM --assign-tf linear \
  --assign-primaries none --encode uastc --uastc-quality 2 --uastc-rdo --uastc-rdo-m --zstd 18 \
  --uastc-rdo-l 0.5 normal.png normal.ktx2
```

- `--assign-tf` matters: without it `ktx` reads an 8-bit PNG as sRGB and gamma-decodes the
  data maps' numbers into linear (128 becomes 55). `--fail-on-color-conversions` makes any
  colour conversion an error instead.
- Normal maps are plain RGB = XYZ tangent-space normals, which is what three.js reads.
  Don't add `--normal-mode` (it stores X and Y as RGB = X, A = Y); `assets:validate` rejects it.
- UASTC without `--zstd` is 5.6 MB per 2048 map; two of them alone would nearly fill the
  first-load budget, so validate warns about it.

The placeholder uses flat materials, so nothing needs converting yet.

## Arena (when Sammy's arena.glb lands)

The fight uses a procedural junkyard that needs no files. A hand-made arena goes to
`apps/web/public/models/arena.glb`, with its baked lighting in
`apps/web/public/models/arena_lightmap.ktx2` (or as a texture the glb reads through its second
UV map). `pnpm assets:validate` checks it whenever that file exists (so CI does too;
`--arena=<file>` checks another file): at most 60k triangles counting every GPU instance, a
lightmap of at most 4096, every mesh has `TEXCOORD_1` for it, and the anchor empties below. With
no arena file it skips cleanly.

The game keeps its fires, crowd and floodlights and checks the ring edges from **named empties**
in the glb (`anchorsFromScene` in `apps/web/src/game/view/arena/layout.ts`; empties export as
glTF nodes, and three.js drops `.` from names, so `fire_L.001` works):

| Empty | What it marks | If it is missing |
|---|---|---|
| `ringedge_L`, `ringedge_R` | the ring edges; **must sit at x = −10 / +10** (±0.05), where the sim rings fighters out. Beyond them the floor must drop away | error |
| `fire_L*`, `fire_R*` (at least one per side) | one per oil drum, at its base centre; each side's fire light sits 2.1 above the drums' mean, flames 0.95 above each drum | warning: that side uses the procedural drums |
| `crowd_<n>_a`, `crowd_<n>_b` | the two ends of crowd row *n*, at seat (feet) height; custom property `count` (a positive number, default 30) | warning: the procedural bleachers' crowd |
| `flood_<n>` + `flood_<n>_target` | a floodlight bank and where its beam lands | warning: the procedural towers' lights |

## Budgets (checked by `assets:validate`)

| Asset | Budget |
|---|---|
| Chicken | ≤ 15k triangles, one skinned mesh, ≤ 40 joints |
| Chicken textures | 2k (2048) KTX2, one set per tier |
| Arena | ≤ 60k triangles, lightmap ≤ 4k (in `TEXCOORD_1`) |
| First load (art assets; app code excluded) | ≤ 12 MB raw; non-Rust tiers and arena extras lazy-load |

## Testing the pipeline itself

`art/blender/make_messy_fixture.py` builds the placeholder as a UI-authored file would arrive
(actions off the NLA, 24 fps, frame-1 starts, a stray `Action`, control bones, empties without
`cf_radius`, ...) into `art/blender/out/` (gitignored):

```bash
pnpm --filter @cockfight/tools run blender art/blender/make_messy_fixture.py --habits all
pnpm assets:import --blend art/blender/out/messy_chicken.blend --out art/blender/out/messy.glb \
  --hitboxes art/blender/out/messy.json --retime
```

`--habits fixable` leaves out the habits that need an artist, so that import succeeds.

`tools/test/heroImport.test.ts` runs these fixtures and a clean placeholder round trip through
the import on any machine with Blender (it is skipped in CI, and with `CF_SKIP_BLENDER=1`).
