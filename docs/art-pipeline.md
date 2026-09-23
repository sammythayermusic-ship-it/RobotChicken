# Art pipeline: Blender → glTF → game

Everything the game needs from a chicken is defined in
`packages/sim/data/chicken.contract.json`: the 21 clip names and frame counts, the two hitbox
helpers, the material slots and the budgets. The placeholder chicken is built from that same
contract by `art/blender/build_placeholder_chicken.py`, so the game is always playable.

## The one-command path (recommended)

```bash
pnpm assets:import --blend art/chicken.blend
```

This runs Blender headless with the scripted exporter (`art/blender/cf_common.py`), validates
the result against the contract and budgets, and bakes the hitboxes into
`packages/sim/data/hitboxes.json`. If anything is wrong it stops with a message that names the
clip, bone or helper and says how to fix it.

A hero chicken changes gameplay (its helpers are the hitboxes), so the import also changes the
rules hash: re-bless the golden replays in the same commit (`pnpm replay:golden --bless`).

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
  - `hurt_body` on the body bone — the capsule you can be hit on. Custom properties:
    `cf_shape = "capsule"`, `cf_radius` and `cf_half_height` (in units; the capsule's axis is the
    empty's local Y).
  - `hit_beak` on the head bone — the sphere that hits. Custom properties: `cf_shape = "sphere"`,
    `cf_radius`.
  Empties' display size isn't exported by glTF, which is why the sizes are custom properties.

## Animations

- 60 fps scene. One Action per clip, named exactly as the contract, each on its own NLA track of
  the same name (a stray Action — e.g. Blender's default `Action` — fails the export on purpose).
- Clip lengths: frame 0 is the pose *before* the move's first tick; a clip of N frames ends on
  frame N. For attacks, N must equal startup + active + recovery in `moves.json` **or** the Action
  carries a custom property `cf_phases = [startup, active, recovery]` describing your authored
  split, and the game retimes it piecewise. Either way you can retime moves in `moves.json`
  without re-exporting.
- During an attack's active frames the `hit_beak` helper must reach the opponent (it is what hits).
  `assets:validate` checks it is in front of the body during every attack's active window.

## Manual export (fallback)

File → Export → glTF 2.0 (.glb) with:

| Setting | Value |
|---|---|
| Format | glTF Binary (.glb) |
| Include | Selected Objects (select `Rig` and its children) · Custom Properties ✅ |
| Transform | +Y Up ✅ |
| Data → Armature | Use Rest Position ✅ · Export Deformation Bones Only ✅ |
| Animation | Mode: **Actions** · Export all Armature Actions ✅ · Always Sample Animations ✅ · Sampling Rate 1 · Set all glTF Animation Starting at 0 ✅ · Merge Animation: **NLA Track Names** · Optimize Animation Size ✅ |
| Compression | Draco ✅ · level 6 · quantization **position 14, normal 10, texcoord 12**, color 8, generic 12 |
| Textures | none embedded (convert with `pnpm textures`) |

"Group by NLA Track" (from older checklists) has done nothing since Blender 3.6; the settings above
replace it. Then run `pnpm assets:validate public/models/<file>.glb` and `pnpm assets:bake`.

## Textures (later)

Tier textures are 2k PBR sets (base color, packed metal/rough, normal, emissive) converted to
KTX2 with KTX-Software 4.4 (`ktx create`). Install it from the KTX-Software releases page, then
`pnpm textures`. The placeholder uses flat materials, so nothing needs converting yet.

## Budgets (checked by `assets:validate`)

| Asset | Budget |
|---|---|
| Chicken | ≤ 15k triangles, one skinned mesh, ≤ 40 joints |
| Chicken textures | 2k (2048) KTX2, one set per tier |
| Arena | ≤ 60k triangles, lightmap ≤ 4k (in `TEXCOORD_1`) |
| First load | ≤ 12 MB on the wire; non-Rust tiers and arena extras lazy-load |
