# art/blender

Headless Blender scripts that turn a chicken into `apps/web/public/models/*.glb`.
The contract every chicken must meet (clip names, frame counts, phases, hitbox
helpers, material slots, budgets) is `packages/sim/data/chicken.contract.json`;
these scripts and `tools/src/assets/validate.ts` both read it.

| File | What it does |
|---|---|
| `cf_common.py` | `EXPORT_KWARGS` (the one set of exporter settings) and `export_chicken(out, contract)`: `prepare_scene()` fixes UI habits in memory (`CF_FIX`) and lists every other problem (`CF_ERROR`), then it exports Rig + descendants to a temp file, re-reads it, `os.replace`s it into place and prints `CF_REPORT {json}`. |
| `build_placeholder_chicken.py` | Builds the boxy placeholder robot chicken (16 bones, ~1.6k triangles, 21 clips) from the contract and exports it. Also renders the contact sheet. |
| `export_chicken.py` | The hero export: run on an artist's .blend (`pnpm assets:import --blend <file>` does, then validates and bakes). `--retime` rescales a file not authored at 60 fps. |
| `make_messy_fixture.py` | Builds the placeholder with UI-authored habits (`--habits all\|fixable\|<list>`) into `out/`, to test the hero export. |
| `presets/cockfight_glb.py` | The same settings as a glTF-exporter UI preset (every exporter setting: `EXPORT_KWARGS` plus the exporter's defaults); where to install it is in `docs/art-pipeline.md`. Generated: don't edit it by hand. |
| `make_preset.py` | Regenerates `presets/cockfight_glb.py` from `EXPORT_KWARGS` for the running Blender. |

Blender 5.2 (tested with 5.2.1) is needed only to rebuild art. CI never runs
it: the glb and `packages/sim/data/hitboxes.json` are committed.

## Commands

```sh
pnpm assets:placeholder      # build + export the placeholder, validate it, re-bake hitboxes.json
pnpm assets:validate [glb]   # contract checks + gltf-validator; --json for machine output
pnpm assets:bake [glb]       # re-bake hitboxes.json (then: pnpm replay:golden --bless)
pnpm assets:bake --check     # exit 1 if hitboxes.json differs from a fresh bake
pnpm --filter @cockfight/tools run assets:inspect apps/web/public/models/chicken_placeholder.glb

# Contact sheet (no export), or save the built scene as a .blend (art/blender/out/ is gitignored):
pnpm --filter @cockfight/tools run blender art/blender/build_placeholder_chicken.py --preview docs/captures/phase-0/placeholder_contact.png
pnpm --filter @cockfight/tools run blender art/blender/build_placeholder_chicken.py --blend art/blender/out/placeholder.blend
```

The runner (`tools/src/blender/run.ts`) finds Blender at `$BLENDER`, then
`/Applications/Blender.app/Contents/MacOS/Blender`, then `blender` on `PATH`,
and always runs `-b --factory-startup --python-exit-code 1` (without the last
flag a Python exception still exits 0). A problem the artist must fix prints one
`CF_ERROR: ...` line and exits 1.

`pnpm assets:placeholder` twice gives byte-identical files: the scripts use no
randomness or clock, and the exporter output is deterministic. The bytes do
depend on the Blender/exporter version (it is recorded in `asset.generator`),
so rebuilding with anything but 5.2.x changes the glb and its sha256; the
script prints a `CF_WARNING` when that happens. After any rebuild that changes
hitboxes.json, re-bless the golden replays (`rulesHash` covers the baked tables).

## Authoring rules (placeholder and hero alike)

- **60 fps, one frame per sim tick.** A clip of N frames has samples 0..N;
  sample 0 is the pose before the move's first tick, and sim frame f shows
  sample f. For attacks with `phases: [s, a, r]`, samples s+1..s+a are active.
  Never change the scene fps after animating (it retimes every clip).
- **Axes.** The chicken faces Blender -Y, which exports as glTF +Z (the sim's
  forward). Feet on Z = 0. `Rig` and the mesh have identity transforms.
- **Clips.** One action per clip, each on its own NLA track named exactly like
  the clip (and the action named the same), frame range 0..N. Any other armature
  action (a stray `Action`, a second slot) fails the export. Attack actions carry
  a `cf_phases` custom property equal to the contract's phases.
- **No root motion.** `root` is a Deform bone at the origin and never moves;
  the sim owns position. Move `body` instead.
- **Centered on the origin.** The sim places the fighter at the model origin,
  so model the chicken around it: `root`'s head sits exactly at the origin, and
  at idle frame 0 `hurt_body` is within 0.02 of it in x and z (both are
  errors). The export and `assets:validate` check the root; `assets:validate`
  checks the body and warns if the mesh is off-center left-right.
- **One skinned mesh.** Everything the chicken draws is one mesh with an
  Armature modifier (at most 15k triangles). An extra mesh fails the export and
  `assets:validate`, even one parented to a bone: join it in (Ctrl+J) and
  weight it to its bone.
- **Bones.** All exported bones must be Deform (`export_def_bones=True` drops the
  rest, so control/IK bones do not count toward the 40-joint budget).
- **Hitbox helpers.** Empties parented to Deform bones (`Bone` parent type):
  - `hurt_body` on `body`: `cf_shape = "capsule"`, `cf_radius`, `cf_half_height`
    (the capsule's axis is the empty's local Z in Blender, glTF local +Y).
  - `hit_beak` on `head`: `cf_shape = "sphere"`, `cf_radius`.

  Sizes must be custom properties: glTF does not export an empty's display size.
  They travel as node extras, and the bake scales them by the helper's world scale.
- **Materials** are named exactly `cf_shell`, `cf_trim`, `cf_eye` (swapped per
  tier at runtime), `cf_beak`, `cf_comb` (fixed). Backface culling on.

## Exporter settings

`EXPORT_KWARGS` in `cf_common.py` is the source of truth; `presets/cockfight_glb.py`
is the same settings as a UI preset. Applying a preset sets only what it lists (the dialog
keeps its last-used value for anything else), so the preset lists every exporter setting,
the rest at the exporter's defaults. After changing `EXPORT_KWARGS`, or on a new Blender,
regenerate it (`heroImport.test.ts` fails until you do):

```sh
pnpm --filter @cockfight/tools run blender art/blender/make_preset.py
```

If you must export by hand from the UI (File > Export > glTF 2.0) without the preset,
start from **Operator Defaults** in the dialog's preset menu, then match:

- Format glTF Binary; Include: Selected Objects, Custom Properties; Transform: +Y Up
- Data > Mesh: Apply Modifiers, UVs, Normals; Materials: Export; Images: None
- Data > Armature: Use Rest Position, **Export Deformation Bones Only**
- Data > Compression: Draco level 6, quantization position 14, normal 10,
  texcoord 12, color 8, generic 12
- Animation: Mode **Actions**, Always Sample Animations, sampling rate 1,
  **Export all Armature Actions**, Merge Animation **NLA Track Names**,
  Optimize Animation Size, **Set all glTF Animation starting at 0**, Reset pose bones

"Group by NLA Track" (`export_nla_strips`) does nothing since Blender 3.6; the
settings above replace it. Always run `pnpm assets:validate` on the result.

## The placeholder's hitbox design

The placeholder exists so the sim's frame data has real geometry behind it.
`build_placeholder_chicken.py` solves each attack's active keys so `hit_beak`
lands on a target (model space, units), and checks every sample in Blender
before exporting (`CF_BEAK` lines in the log):

| Clip | Active samples | Beak z (forward) | Beak y (up) |
|---|---|---|---|
| peck | 5-6 | 0.85-1.00 | 0.75-0.90 |
| shove | 9-11 | 0.70-0.80 | ~0.6 |
| slam | 15-18 | 0.80-0.90 | 0.10-0.20 |
| super | 11-16 | 0.90-1.00 | ~0.8 |
| dive_kick | 7-16 | 0.40-0.50 | -0.10-0.00 |

During startup and recovery the beak stays back (z <= 0.6; it rests at 0.55).
That is purely visual, so wind-up and follow-through read clearly. It is not
what keeps hits to active frames: pushboxes keep grounded fighters at least
0.8 apart, and at that distance even the retracted beak overlaps the other
chicken's `hurt_body`. Hits land only on active frames because the sim tests a
move's hit sphere only during its active samples (`phases`). `hurt_body` is
vertical at rest, centered at y = 0.82 so its bottom touches the ground.
`tools/test/bake.test.ts` re-checks these ranges on the baked integers.
