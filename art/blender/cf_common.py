"""Shared Blender-side code for exporting a COCKFIGHT chicken to .glb.

Both the placeholder build script and the hero export go through
`export_chicken()`, so the exporter settings live in exactly one place and the
manual UI checklist in README.md is only a fallback.

Runs inside Blender 5.2 (bpy); no third-party modules.
"""

import hashlib
import json
import os
import struct
import sys

import bpy
from bpy_extras.anim_utils import action_get_channelbag_for_slot

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONTRACT = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "sim", "data", "chicken.contract.json"))

# The Blender/exporter version the committed placeholder glb was made with.
# Exporter output (including asset.generator) is only byte-stable per version.
EXPECTED_BLENDER = (5, 2)

# Verified against io_scene_gltf2 5.2.40 (docs/research/blender.md section 2),
# except export_def_bones=True: control/IK bones in a hero rig must not count
# toward the joint budget, so every exported bone (including `root`) has to be
# marked Deform.
EXPORT_KWARGS = dict(
    export_format="GLB",
    check_existing=False,
    use_selection=True,  # Rig + descendants only; the caller selects them
    export_yup=True,
    export_apply=True,  # applies modifiers (not the armature), never object transforms
    export_texcoords=True,
    export_normals=True,
    export_tangents=False,
    export_materials="EXPORT",
    export_image_format="NONE",  # hero textures ship separately as KTX2
    export_cameras=False,
    export_lights=False,
    export_morph=False,
    export_extras=True,  # REQUIRED: helper sizes and cf_phases travel as extras
    export_skins=True,
    export_def_bones=True,
    export_influence_nb=4,
    export_rest_position_armature=True,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_anim_single_armature=True,  # "Export all Armature Actions"
    export_force_sampling=True,  # one key per frame, so sim frame f == clip sample f
    export_frame_step=1,
    export_merge_animation="NLA_TRACK",  # clip name = NLA track name
    export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=True,
    export_reset_pose_bones=True,
    export_anim_slide_to_zero=True,  # a clip authored from frame 1 still starts at t=0
    export_frame_range=False,
    export_bake_animation=False,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14,
    export_draco_normal_quantization=10,
    export_draco_texcoord_quantization=12,  # 8 bits is ~8 texels of error on a 2k map
    export_draco_color_quantization=8,
    export_draco_generic_quantization=12,
)


class ExportError(Exception):
    """A problem the artist has to fix; printed as one readable line, no traceback."""


def script_args():
    """Arguments after `--` on the Blender command line."""
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def load_contract(path=None):
    with open(path or DEFAULT_CONTRACT, encoding="utf-8") as f:
        return json.load(f)


def run_main(main):
    """Run `main()`, turning ExportError into `CF_ERROR: ...` and exit code 1."""
    try:
        main()
    except ExportError as e:
        print(f"CF_ERROR: {e}", file=sys.stderr, flush=True)
        sys.exit(1)


def warn_if_unexpected_blender():
    if tuple(bpy.app.version[:2]) != EXPECTED_BLENDER:
        print(
            f"CF_WARNING: running Blender {bpy.app.version_string}; the committed glb was exported with "
            f"{EXPECTED_BLENDER[0]}.{EXPECTED_BLENDER[1]}.x, so its bytes (and hitboxes sha256) will differ.",
            flush=True,
        )


# --------------------------------------------------------------------------- checks


def _is_identity(m, eps=1e-5):
    return all(abs(m[r][c] - (1.0 if r == c else 0.0)) <= eps for r in range(4) for c in range(4))


def _bone_slots(action):
    """OBJECT slots of `action` that animate at least one pose bone (the exporter's own test)."""
    slots = []
    for slot in action.slots:
        if slot.target_id_type != "OBJECT":
            continue
        cb = action_get_channelbag_for_slot(action, slot)
        if cb and any(fc.data_path.startswith("pose.bones[") for fc in cb.fcurves):
            slots.append(slot)
    return slots


def _clip_name_of(action, rig):
    """The glTF animation name the exporter will give `action` (ACTIONS mode, merge by NLA track)."""
    ad = rig.animation_data
    for track in ad.nla_tracks if ad else []:
        strips = [s for s in track.strips if s.action is not None and not s.mute]
        if len(strips) == 1 and strips[0].action == action:
            if not (track.name.startswith("NlaTrack") or track.name.startswith("[Action Stash]")):
                return track.name
    return action.name


def check_scene(contract):
    """Validate the scene against the contract before exporting. Returns (rig, helpers)."""
    scn = bpy.context.scene
    fps = scn.render.fps / scn.render.fps_base
    if abs(fps - contract["fps"]) > 1e-6:
        raise ExportError(
            f"scene runs at {fps:g} fps; author at {contract['fps']} fps (Output Properties > Frame Rate). "
            "Changing fps after animating retimes every clip, so fix the animation too."
        )

    if bpy.context.mode != "OBJECT":
        if bpy.context.view_layer.objects.active is not None:
            bpy.ops.object.mode_set(mode="OBJECT")
        if bpy.context.mode != "OBJECT":
            raise ExportError(f"Blender is in {bpy.context.mode} mode; switch to Object mode before exporting")

    rig_name = contract["rig"]["armature"]
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    if len(arms) != 1 or arms[0].name != rig_name:
        raise ExportError(f"expected exactly one armature object named '{rig_name}', found {[o.name for o in arms]}")
    rig = arms[0]
    if rig.parent is not None or not _is_identity(rig.matrix_world):
        raise ExportError(f"'{rig_name}' must be unparented with identity transforms (Object > Apply > All Transforms)")

    root = rig.data.bones.get(contract["rig"]["rootBone"])
    if root is None or root.parent is not None:
        raise ExportError(f"'{rig_name}' needs a top-level bone named '{contract['rig']['rootBone']}'")
    if not root.use_deform:
        raise ExportError(f"bone '{root.name}' must be marked Deform (export_def_bones drops non-deform bones)")

    meshes = [o for o in rig.children_recursive if o.type == "MESH"]
    skinned = [o for o in meshes if any(m.type == "ARMATURE" and m.object == rig for m in o.modifiers)]
    if len(skinned) != 1:
        raise ExportError(f"expected exactly one mesh with an Armature modifier on '{rig_name}', found {[o.name for o in skinned]}")
    extra = [o.name for o in meshes if o not in skinned]
    if extra:
        # Every exported mesh is drawn and counts toward the triangle budget; the spec allows one skinned mesh.
        raise ExportError(
            f"the chicken must be one skinned mesh, but {extra} are also under '{rig_name}': join them into "
            f"'{skinned[0].name}' (Ctrl+J) and weight them to their bones"
        )
    if not _is_identity(skinned[0].matrix_world):
        raise ExportError(f"mesh '{skinned[0].name}' must have identity transforms (Object > Apply > All Transforms)")

    helpers = {}
    for name, spec in contract["helpers"].items():
        obj = bpy.data.objects.get(name)
        if obj is None or obj not in rig.children_recursive:
            raise ExportError(f"missing hitbox helper '{name}': an empty parented to bone '{spec['bone']}' of '{rig_name}'")
        if obj.type != "EMPTY":
            raise ExportError(f"hitbox helper '{name}' must be an Empty, not a {obj.type}")
        if obj.parent_type == "BONE":
            bone = rig.data.bones.get(obj.parent_bone)
            if bone is None or not bone.use_deform:
                raise ExportError(f"'{name}' hangs off bone '{obj.parent_bone}', which is missing or not Deform")
        shape = obj.get("cf_shape")
        if shape != spec["shape"]:
            raise ExportError(f"'{name}' needs custom property cf_shape = '{spec['shape']}' (found {shape!r})")
        props = ["cf_radius"] + (["cf_half_height"] if spec["shape"] == "capsule" else [])
        for prop in props:
            value = obj.get(prop)
            if not isinstance(value, (int, float)) or value < 0 or (prop == "cf_radius" and value <= 0):
                raise ExportError(
                    f"'{name}' needs a numeric custom property {prop} (found {value!r}); glTF does not export "
                    f"an empty's display size (currently {obj.empty_display_size:g}), so the size must be a property"
                )
        helpers[name] = obj

    if rig.animation_data is None:
        raise ExportError(f"'{rig_name}' has no animation data; nothing to export")
    want = {c["name"]: c for c in contract["clips"]}
    seen = {}
    for action in bpy.data.actions:
        slots = _bone_slots(action)
        if not slots:
            continue
        if len(slots) > 1:
            raise ExportError(
                f"action '{action.name}' animates bones through {len(slots)} slots and would export as "
                f"'{action.name}-<slot>'; keep one slot per action"
            )
        clip = _clip_name_of(action, rig)
        if clip in seen:
            raise ExportError(f"actions '{seen[clip].name}' and '{action.name}' would both export as clip '{clip}'")
        seen[clip] = action
    extra = sorted(set(seen) - set(want))
    missing = [c for c in want if c not in seen]
    if extra or missing:
        parts = []
        if extra:
            parts.append(
                "unexpected armature actions (delete them, or rename them to a contract clip): "
                + ", ".join(f"'{c}'" + (f" (action '{seen[c].name}')" if seen[c].name != c else "") for c in extra)
            )
        if missing:
            parts.append("missing clips: " + ", ".join(f"'{c}'" for c in missing))
        raise ExportError("; ".join(parts))
    for clip, action in seen.items():
        start, end = action.frame_range
        frames = want[clip]["frames"]
        if abs(start - round(start)) > 1e-6 or abs(end - round(end)) > 1e-6 or round(end - start) != frames:
            raise ExportError(
                f"clip '{clip}' spans frames {start:g}..{end:g} ({end - start:g} frames); the contract needs "
                f"exactly {frames} (set the action's Manual Frame Range)"
            )
    return rig, helpers


# --------------------------------------------------------------------------- export


def read_glb_json(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise ExportError(f"{path} is not a valid GLB 2.0 file")
    json_len, json_type = struct.unpack_from("<I4s", data, 12)
    if json_type != b"JSON":
        raise ExportError(f"{path}: first GLB chunk is not JSON")
    return json.loads(data[20 : 20 + json_len]), data


def _triangles(g, prim):
    """Triangles one glTF primitive draws (0 for points and lines)."""
    mode = prim.get("mode", 4)
    accessor = prim["indices"] if "indices" in prim else prim["attributes"]["POSITION"]
    count = g["accessors"][accessor]["count"]
    if mode == 4:  # TRIANGLES
        return count // 3
    if mode in (5, 6):  # TRIANGLE_STRIP, TRIANGLE_FAN
        return max(count - 2, 0)
    return 0


def verify_export(path, contract):
    """Re-read the exported glb and check the contract; returns the CF_REPORT dict."""
    g, data = read_glb_json(path)
    nodes = g.get("nodes", [])
    names = [a.get("name") for a in g.get("animations", [])]
    want = [c["name"] for c in contract["clips"]]
    if sorted(names) != sorted(want):
        raise ExportError(f"exported clips {sorted(names)} != contract clips {sorted(want)}")
    frames = {c["name"]: c["frames"] for c in contract["clips"]}
    for a in g["animations"]:
        t_max = max(g["accessors"][s["input"]]["max"][0] for s in a["samplers"])
        if abs(t_max * contract["fps"] - frames[a["name"]]) > 1e-3:
            raise ExportError(f"clip '{a['name']}' exported {t_max * contract['fps']:.3f} frames, want {frames[a['name']]}")

    for name, spec in contract["helpers"].items():
        found = [n for n in nodes if n.get("name") == name]
        extras = found[0].get("extras", {}) if len(found) == 1 else {}
        if extras.get("cf_shape") != spec["shape"] or "cf_radius" not in extras:
            raise ExportError(f"helper '{name}' is missing from the glb or lost its extras (export_extras must be on)")

    mesh_nodes = [n for n in nodes if "mesh" in n]
    skinned = [n for n in mesh_nodes if "skin" in n]
    if len(skinned) != 1:
        raise ExportError(f"expected one skinned mesh node, found {len(skinned)}")
    if len(mesh_nodes) != 1:
        names = [n.get("name") for n in mesh_nodes if "skin" not in n]
        raise ExportError(f"the chicken must be one skinned mesh; the glb also has mesh nodes {names}")
    # Count every mesh node the game would draw, not just the skinned one.
    tris = sum(_triangles(g, p) for n in mesh_nodes for p in g["meshes"][n["mesh"]]["primitives"])
    joints = g["skins"][skinned[0]["skin"]]["joints"]
    joint_names = [nodes[j].get("name") for j in joints]
    budgets = contract["budgets"]
    if tris > budgets["chickenTriangles"]:
        raise ExportError(f"{tris} triangles exceeds the budget of {budgets['chickenTriangles']}")
    if len(joints) > budgets["joints"]:
        raise ExportError(f"{len(joints)} joints exceeds the budget of {budgets['joints']}")
    if contract["rig"]["rootBone"] not in joint_names:
        raise ExportError(f"'{contract['rig']['rootBone']}' is not a skin joint (mark it Deform)")
    if "KHR_draco_mesh_compression" not in g.get("extensionsUsed", []):
        raise ExportError("the glb is not Draco-compressed")
    materials = sorted(m.get("name", "") for m in g.get("materials", []))
    if materials != sorted(contract["materials"]):
        raise ExportError(f"materials {materials} != contract slots {sorted(contract['materials'])}")

    return {
        "file": path,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "tris": tris,
        "joints": len(joints),
        "clips": len(names),
        "materials": materials,
        "generator": g.get("asset", {}).get("generator"),
    }


def export_chicken(out, contract):
    """Check the scene, export Rig + descendants to `out` atomically, verify, print CF_REPORT."""
    out = os.path.abspath(out)
    rig, _helpers = check_scene(contract)

    export_set = [rig, *rig.children_recursive]
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    for obj in export_set:
        if obj.hide_get():
            obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    # An action left active in the Action Editor would also be exported as-is.
    rig.animation_data.action = None

    os.makedirs(os.path.dirname(out), exist_ok=True)
    stem = os.path.splitext(os.path.basename(out))[0]
    tmp = os.path.join(os.path.dirname(out), f".{stem}.{os.getpid()}.tmp.glb")
    try:
        result = bpy.ops.export_scene.gltf(filepath=tmp, **EXPORT_KWARGS)
        if result != {"FINISHED"}:
            raise ExportError(f"glTF exporter returned {result}")
        report = verify_export(tmp, contract)
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    report["file"] = out
    print("CF_REPORT " + json.dumps(report, sort_keys=True), flush=True)
    return report
