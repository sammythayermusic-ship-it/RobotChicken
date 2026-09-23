Blender 5.2.1 headless verified: layered actions on name-matched NLA tracks export as named glTF clips, and the bone-parented empties follow the bones with no keys of their own. Probe written only to the scratchpad; probe.glb is 7,748 B and passes gltf-validator with 0 errors. The spec's export checklist was written for an older exporter: its "group by NLA track" box now does nothing, and the checklist is missing two settings (custom properties and slide-to-zero).

## 1. What to reuse from ~/soltendogs/art/blender/build_dog.py
Reuse:
- The data-first build: named constants for dimensions, and every part built with `bmesh` so each part's vertex index range is known.
- Rigid skinning: `vertex_groups.new(bone).add(indices, 1.0, 'REPLACE')`.
- Edit bones set with `mode_set('EDIT')` and `roll = 0`.
- A materials helper like its `flat_material()`.
- The script returns a JSON summary: triangles, dimensions, KB.

Do not reuse:
- **Operators that need a live Blender window.** It relies on `parent_set(type='ARMATURE_AUTO')`, `object.join` and `uv.smart_project`, and it was run through a connected Blender, not headless. Use `mesh.parent = rig` plus `modifiers.new('Armature','ARMATURE').object = rig` instead. `mode_set` does work headless.
- **Its scene reset.** `wipe()` keeps the scene and deletes named objects. Start from a clean scene with `bpy.ops.wm.read_factory_settings(use_empty=True)`; the glTF add-on stays enabled.
- **`use_nodes = True`.** Not needed: new materials in 5.2 already come with Principled BSDF and Material Output.
- **It exports no animation**, so none of its export settings cover clips.

## 2. Exporter settings (read from the local 5.2.1 exporter, add-on v5.2.40), verified
```python
EXPORT_KWARGS = dict(
  export_format='GLB', check_existing=False, use_selection=True,        # Selected Objects
  export_yup=True, export_apply=True,                                    # +Y up; apply modifiers (except armature)
  export_texcoords=True, export_normals=True, export_tangents=False,
  export_materials='EXPORT', export_image_format='NONE',                 # hero: textures ship separately as KTX2
  export_cameras=False, export_lights=False, export_morph=False,
  export_extras=True,                                                    # REQUIRED: helper sizes and clip phases
  export_skins=True, export_def_bones=False, export_influence_nb=4, export_rest_position_armature=True,
  export_animations=True, export_animation_mode='ACTIONS',
  export_anim_single_armature=True,        # "Export all Armature Actions"   = "export all actions"
  export_force_sampling=True, export_frame_step=1,   # "Always Sample Animations" = "sampling on"
  export_merge_animation='NLA_TRACK',      # "Merge Animation: NLA Track Names" = "group by NLA track"
  export_optimize_animation_size=True,     # "Optimize Animation Size" = "optimize keyframes"
  export_optimize_animation_keep_anim_armature=True,
  export_reset_pose_bones=True, export_anim_slide_to_zero=True, export_frame_range=False, export_bake_animation=False,
  export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
  export_draco_position_quantization=14, export_draco_normal_quantization=10,
  export_draco_texcoord_quantization=12, export_draco_color_quantization=8, export_draco_generic_quantization=12,
)
```
- **The "Group by NLA Track" checkbox (`export_nla_strips`) does nothing.** The source says: "This option does nothing… removed in 3.6". Its current equivalent is `export_animation_mode='ACTIONS'` plus `export_merge_animation='NLA_TRACK'`. Sammy's checklist should read: Mode = Actions, Export all Armature Actions on, Always Sample on, Merge Animation = NLA Track Names, Optimize on, Set All glTF Animation Starting at 0 on, Custom Properties on.
- **Why not `NLA_TRACKS` mode:** the probe showed it silently drops any action that isn't on an NLA track (walk_fwd was lost). `ACTIONS` with `NLA_TRACK` exports every armature action, and names each clip after its track when there is one.
- **"14/10/8" is ambiguous.** The exporter has five quantization fields: position (default 14), normal (10), texcoord (12), color (10), generic (12). Read literally as position/normal/texcoord, 8-bit texture coordinates give 256 steps across the UV range, which is about 8 texels of error on a 2k map. That breaks seams. My recommendation is position 14, normal 10, texcoord 12, color 8, generic 12. Log this in the decisions doc and ask Sammy to confirm. It makes no difference for the placeholder, which has no textures.
- **Other exporter support:**
  - The 5.2 exporter also has meshopt compression (`export_meshopt_compression_enable`) and gltfpack/KTX2 options (`export_use_gltfpack`, which needs a gltfpack binary). Not needed, since the spec locks Draco.
  - `KHR_materials_variants` is supported, but only when the add-on preference `KHR_materials_variants_ui` is on and per-mesh `gltf2_variant_mesh_data` is filled in.

## 3. Blender 5.x animation API (verified)
In 5.x, `Action.fcurves` and `Action.groups` no longer exist; keys go into a channelbag. `pose_bone.keyframe_insert()` still works and creates the slot `OBRig` automatically.
```python
def make_action(name, dur, keys, loop=False):          # keys: {bone:{prop:[(frame,(x,y,z))]}}
    act = bpy.data.actions.new(name); act.use_fake_user = True
    slot = act.slots.new(id_type='OBJECT', name='Rig')
    cb = act.layers.new('Layer').strips.new(type='KEYFRAME').channelbag(slot, ensure=True)
    for b in BONES:                                     # key EVERY bone/channel (rest if unspecified)
        rig.pose.bones[b].rotation_mode = 'XYZ'
        for prop, rest in (('location',(0,0,0)),('rotation_euler',(0,0,0)),('scale',(1,1,1))):
            kl = keys.get(b,{}).get(prop) or [(0,rest),(dur,rest)]
            for i in range(3):
                fc = cb.fcurves.new(f'pose.bones["{b}"].{prop}', index=i, group_name=b)
                fc.keyframe_points.add(len(kl))
                fc.keyframe_points.foreach_set('co', [c for f,v in kl for c in (float(f), float(v[i]))])
                fc.update()
    act.use_frame_range = True; act.frame_start = 0; act.frame_end = dur; act.use_cyclic = loop
    return act, slot
rig.animation_data_create()                 # the exporter needs animation_data for "all actions"
tr = rig.animation_data.nla_tracks.new(); tr.name = clip
st = tr.strips.new(clip, 0, act)            # action_slot is auto-assigned (verified); set it if None
rig.animation_data.action = None
```
Verified behaviour:
- **Clip names come from the track.** An action named `act_peck` on track `peck` exports as glTF animation `peck`. Name both the action and the track after the clip so either route gives the right name.
- **Every clip gets every bone.** Sampling bakes translation, rotation and scale for all joints even when only one bone is keyed, so crossfades never leave a bone stuck.
- **Output shape.** Constant channels become 2-key STEP samplers; animated channels are LINEAR with one sample per frame, so frame 14 is 0.2333 s at 60 fps.
- **Active action.** Leaving an action active in the Action Editor while it is also on NLA does not duplicate the clip.
- **Stray actions leak into the export.** A leftover action named `Action` is exported as a clip. The export helper must fail if the set of armature actions is not exactly the 21 clips.
- **Tracks that are ignored or skipped:**
  - Tracks named `NlaTrack*` or `[Action Stash]` are not used for naming.
  - Tracks with more than one strip are skipped, with a warning.
  - Strips with no `action_slot` are skipped.
- **Clip timing metadata survives.** Custom properties on an action become `animation.extras`, and they survive the NLA_TRACK merge. three.js copies them to `AnimationClip.userData` (GLTFLoader line 4142). Tested: `act["cf_phases"] = [4,2,8]` came through intact. Use this so the renderer can map the moves.json phases onto the authored clip piecewise, which lets Code retime moves without a re-export.

## 4. Hitbox empties (verified)
Parent each empty to a bone. With `parent_type='BONE'` the empty's origin is the bone's tail, so set its transform from the bone:
```python
e = bpy.data.objects.new(name, None); scn.collection.objects.link(e)
e.parent, e.parent_type, e.parent_bone = rig, 'BONE', bone_name
b = arm.bones[bone_name]
pw = rig.matrix_world @ b.matrix_local @ Matrix.Translation((0, b.length, 0))
e.matrix_parent_inverse = Matrix.Identity(4)
e.matrix_basis = pw.inverted() @ Matrix.Translation(world_pos)
e['cf_shape'] = 'capsule'; e['cf_radius'] = 0.40; e['cf_half_height'] = 0.42
e.empty_display_type = 'SPHERE'; e.empty_display_size = 0.40   # visual only, not exported
```
- **Where they land in the file.** Each empty exports as a child node of its joint node (e.g. `body` → children `[head, hurt_body]`). Its custom properties become `node.extras` (three.js: `userData`), and its local rotation is identity.
- **No keys needed.** The empties follow the bones in every clip automatically. hit_beak's position rebuilt from the glTF node chain plus the sampled `peck` data matched Blender's evaluated `matrix_world` to 1e-4 at frames 0 and 4.
- **Optional per-clip keys.** Keys on the empty itself (for example a scale squash) on an NLA track with the same clip name merge into that clip in ACTIONS + NLA_TRACK mode (verified). With merge = ACTION they become a separate clip `peck_hurt`, which is wrong.
- **Size contract.** Sizes live in extras, in node-local units, multiplied by the node's world scale (radius × max(sx, sz); half-height × sy). The validator requires rest scale = 1 and checks the extras are present.
- **Selection.** With `use_selection=True` the empties must be selected too. The export helper selects Rig and all its descendants.

## 5. Probe results
Probe: `…/scratchpad/blender_probe.py`, output `probe.glb`.
- **Size and compression.** 7,748 B; the Draco mesh went from 3,960 B raw to 627 B. `extensionsUsed` and `extensionsRequired` are both `["KHR_draco_mesh_compression"]`.
- **Skin and nodes.** Draco carries POSITION, NORMAL, TEXCOORD_0, JOINTS_0 and WEIGHTS_0. The node tree is `Rig` → [`Chicken` (mesh + skin), `root` → `body` → (`head` → `hit_beak`), `hurt_body`]. Skin joints are `[root, body, head]`, all with identity rest rotation.
- **gltf-transform 4.5.0 `validate`:**
  - 0 errors.
  - 1 harmless warning, `NODE_SKINNED_MESH_NON_ROOT`: the mesh sits under `Rig`, whose transform is identity.
  - Info notes that TEXCOORD_0 is unused.
- **Draco index data.** The `indices` accessor keeps its `count` even with Draco, so triangles = count / 3 without decoding. POSITION keeps min/max.
- **Materials.** They export `doubleSided: true` by default. Set `mat.use_backface_culling = True`.
- **Axes.** Blender (x, y, z) becomes glTF (x, z, −y). A chicken facing Blender −Y faces glTF +Z.

## 6. Running the script: headless, repeatable, same bytes every time
`<Blender> -b --factory-startup [hero.blend] --python-exit-code 1 --python tools/blender/build_placeholder_chicken.py -- --out apps/web/public/models/chicken_placeholder.glb [--blend out.blend] [--preview dir]`
- **`--python-exit-code 1` is mandatory.** Verified: without it a Python exception exits with 0.
- **Argument order.** `--factory-startup` goes before the .blend file. Script arguments go after `--`: use `sys.argv[sys.argv.index('--')+1:]` with argparse.
- **Clean start.** The script calls `read_factory_settings(use_empty=True)` first, uses no randomness (or a seeded `random.Random(1337)`), writes to a temp file and then `os.replace`.
- **Deterministic output.** Two runs gave byte-identical GLBs (same SHA-1). Bytes only change with the Blender version, which is stored in `asset.generator`.
- **Node wrapper `tools/blender/run.mjs`.** Finds Blender via `$BLENDER`, then the Mac default path, then `blender` on PATH. Runs it with `spawnSync` and passes the exit code through.
- **Commit the placeholder GLB,** so CI never needs Blender; CI runs `assets:validate` only.
- **Timing.** About 1 s per run. `--preview` renders a Workbench contact sheet of key frames per clip; a headless Workbench render worked in 1.5 s.

## 7. Placeholder design
**Coordinates.** All bones point +Z with roll 0, so every bone's local frame is aligned with the world. Keyframe values then read as (side, up, forward) for location and (pitch, yaw, roll) for rotation, and they equal the glTF joint-local values.
- +pitch = nose-down / lean forward.
- +roll on `wing_L` = flap out.
- `_R` bones mirror `_L`: negate x, yaw and roll.
- Units are Blender coordinates; the feet are at z = 0.

**Bones (16, all deforming).** Each is listed at its pivot point, with its parent:
- `root` (0,0,0), keyed at rest in every clip.
- `body` (0,0,.62) ← root
- `neck` (0,−.30,1.02) ← body
- `head` (0,−.36,1.28) ← neck
- `jaw` (0,−.58,1.30) ← head
- `comb` (0,−.36,1.52) ← head
- `wattle` (0,−.60,1.20) ← head
- `wing_L/R` (±.40,−.05,1.02) ← body
- `tail` (0,.45,.95) ← body
- `thigh_L/R` (±.20,.02,.62) ← body
- `shin_L/R` (±.20,.06,.36) ← thigh
- `foot_L/R` (±.20,0,.08) ← shin

**Parts.** Beveled boxes (`bmesh.ops.bevel`, 1 segment, about 44 triangles each), each weighted 100% to one bone, flat shaded:

| Part | Center | Size | Bone / material |
|---|---|---|---|
| torso | (0,.02,.85) | .76×.95×.62 | body / shell |
| chest plate + 2 back vents | — | — | body / trim |
| neck | — | .26×.26×.30 | neck / trim |
| head | (0,−.40,1.38) | .42×.46×.40 | head / shell |
| eyes | (±.215,−.52,1.42) | — | head / eye |
| upper beak | (0,−.72,1.36) | .16×.26×.09, tapered | head / beak |
| lower beak | — | — | jaw / beak |
| comb | — | 3 stacked boxes | comb / comb |
| wattle | — | — | wattle / comb |
| wings | (±.43,.02,.86) | .08×.62×.42 | wing / shell |
| tail | — | 3 fanned plates | tail / shell |
| thighs | — | — | thigh / shell |
| shins | — | — | shin / trim |
| feet | — | toe prongs | foot / beak |

This comes to about 2k triangles. Overall size is about 0.95 wide, 1.6 long (beak to tail) and 1.72 tall, with a torso about 1 unit long.

**Helpers:**
- `hurt_body`: capsule, parented to body. Center (0,0,.86), which is glTF (0,.86,0). Vertical axis, radius .40, half-height .42.
- `hit_beak`: sphere, parented to head, at the beak tip (0,−.84,1.36), which is glTF (0,1.36,.84). Radius .14.

Every attack animates so the beak leads, because hit_beak is the only hit helper:
- dive_kick is a 45° beak-first dive.
- slam drives the beak into the ground in front.
- shove is a chest-and-beak lunge with the wings forward.
- super is a horizontal rocket, though its hitbox is screen-wide anyway.

**Clips.** 60 fps, 1 frame = 1 tick. `cf_phases` values are written as action extras.

| Clip | Frames | Key poses (the frames where the pose must land exactly) |
|---|---|---|
| idle | 60, loop | body bob −.02 at 30, tail yaw ±6° |
| walk_fwd / walk_back | 30, loop | generated from sine waves: thighs ±25°, body bob ×2, head-bob forward ±.05; back = reversed phase, lean −4° |
| dash | 12, phases [3,4,5] | lean 20° by 2, wings swept back, hold to 9 |
| jump | 36 (the full airborne time) | crouch 3, extend 6, tuck 12–24 with wing flaps, legs down 33 |
| fall | 20, loop | flapping, legs dangling |
| land | 8 | squash −.14 at 3 |
| block | 6, hold last frame | crouch −.08, wings forward (yaw ∓120°, roll ±25), head tucked |
| block_hit | 10 | block pose, recoil −10° at 2 |
| peck | 14, [4,2,8] | wind-up 2, strike 4–6 (neck +35°, head forward +.30), back to rest at 14 |
| dive_kick | 24, [6,18,0] | dive pose at 6: body +45°, wings back, legs trailing; hold |
| slam | 40, [14,4,22] | wind-up 10 (up +.15, neck −40°, wings up), impact 14–18 (body −.20, +35°, neck +60°, beak at ground), back to rest at 40 |
| shove | 26, [8,4,14] | wind-up 5, thrust 8–12 (lean +15°, wings forward ±80°) |
| super | 60, [10,30,20] | charge 8 (crouch, wings up, jaw open), launch 10 (body +80°), hold with ±3° jitter to 40, back to rest at 60 |
| hit_light | 12 | head −20°, body −8° at 3 |
| hit_heavy | 20 | body −25°, neck −35°, wings flail, comb/wattle ±15° at 4 |
| knockdown | 30, hold | on its back by 14 (body −90°, −.30 down, legs up) |
| getup | 30 | knockdown end pose back to rest, overshoot at 22 |
| ko | 45, hold | knockdown with a bounce at 26, limp head, jaw open |
| win | 60, loop | crowing, flaps |
| entrance | 90 | wrapped crouch, burst 20, flaps, crow 60, rest at 90 |

- **Keying.** BEZIER interpolation, CONSTANT for snaps. Rest pose is at frames 0 and end, and loop clips have first key = last key (verified 61 samples for 60 frames).
- **The validator rejects:**
  - a clip whose duration × 60 is not a whole number (this catches a hero .blend left at 24 fps);
  - a moving `root` channel (root motion must stay off).

## 8. Tier materials: swap at runtime in three.js
- **Why not `KHR_materials_variants`.** The Blender exporter can write it, but three's GLTFLoader does not apply it; its own header lists it as a third-party plugin (takahirox/three-gltf-extensions). It would also pack all four tiers' textures into one GLB, which breaks "lazy-load non-Rust tiers".
- **Material slot contract** (shared with Sammy's hero model):
  - Swapped per tier: `cf_shell`, `cf_trim`, `cf_eye`.
  - Fixed: `cf_beak`, `cf_comb`.
- **What the GLB ships.** Rust-look Principled defaults with backface culling on. The game builds the Chrome/Gold/Diamond materials; Diamond uses `MeshPhysicalMaterial` with iridescence.
- **Two fighters.** Clone the model with `SkeletonUtils.clone`, give each fighter its own materials, and set `frustumCulled = false`.

## 9. Script layout
- `packages/shared/assets/chicken.contract.json`: the 21 clips (name, frames, loop, phases), the helpers and shapes, the material slots, and the budgets (15k triangles, 40 bones). Both Blender and the TypeScript validator read it.
- `tools/blender/cf_common.py`: `EXPORT_KWARGS` and `export_chicken(out)`. It asserts fps = 60 and object mode, checks the action set equals the 21 clips, checks both helpers and their extras exist, selects Rig and its descendants, clears the active action, exports, then reads the GLB back and asserts 21 names, 2 helpers, Draco, triangles ≤ 15k and joints ≤ 40. It prints `CF_REPORT {json}`.
- `tools/blender/build_placeholder_chicken.py`: builds the armature, parts, helpers, materials and clips from the contract, then calls `export_chicken`. Optional `--blend` saves a template .blend for Sammy; optional `--preview` renders the contact sheet.
- `tools/blender/export_chicken.py`: the hero export, `<Blender> -b --factory-startup art/chicken.blend --python-exit-code 1 --python … -- --out …`. The same code path means the manual UI checklist becomes the fallback. Optionally also ship `presets/cockfight_glb.py` as a UI preset.
- **Scripts:**
  - `assets:placeholder` and `assets:export` run through run.mjs.
  - `assets:validate` reads the GLB's JSON and binary chunks with `@gltf-transform/core@4.5.0` and `/extensions@4.5.0` plus `draco3dgltf@1.5.7` (the decoder is only needed to open the file; animation data is not compressed). A hand-written chunk parser also works.
  - The hitbox build step samples each clip per tick (STEP and LINEAR samplers only) and writes fixed-point hitbox tables (units × 1000) for `packages/sim`.
- **Draco decoder for the web app.** three 0.186.0 is the latest release and still ships `examples/jsm/libs/draco/gltf/*`; copy those files to `public/draco/`.

## 10. Other pitfalls
- **Name characters.** Use underscore names only. three's `sanitizeNodeName` strips `.[]:/`, so `wing.L` would become `wingL`.
- **Frame 1 starts.** Blender scenes default to frame 1; `export_anim_slide_to_zero` fixes the 1/60 s lead-in, and all phase frames count from the clip start.
- **Helpers must hang off deforming bones.** If Sammy adds control bones and turns on `export_def_bones`, helpers parented to non-deforming bones would break.
- **Constraints.** IK and other constraints are baked in by sampling.
- **Unapplied transforms.** `export_apply` applies modifiers only. Object transforms must be identity; the validator checks that `Rig` and the mesh node have no translation, rotation or scale.

Probe files (all in the scratchpad):
- `/private/tmp/claude-501/-Users-samthayer-Library-Application-Support-Claude-scratch-workspaces-91621548-4b89-4455-b3f7-36c68eaadb27-a5528d0a-317c-4efc-9ddf-27b3781fafdc-scratch-2026-09-23-c83513/d6dfe493-e1d7-4cf7-bd2b-2427ead14763/scratchpad/blender_probe.py`
- `blender_probe2.py`, `blender_probe3.py`, `blender_probe4.py`
- `probe.glb`, `probe_run2.glb`, `probe2_*.glb`, `probe2_*.log`, `probe3.glb`, `probe4.glb`, `wb_test.png`
