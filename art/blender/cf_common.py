"""Shared Blender-side code for exporting a COCKFIGHT chicken to .glb.

Both the placeholder build script and the hero export go through
`export_chicken()`, so the exporter settings live in exactly one place and the
manual UI checklist in README.md is only a fallback.

A hand-made .blend arrives with UI habits the scripted placeholder never has.
`prepare_scene()` fixes the ones with exactly one right answer (and prints a
`CF_FIX:` line for each) and reports every other problem at once, one
`CF_ERROR:` line each, with the exact change to make in Blender. The fixes
touch only the in-memory scene: the artist's .blend is never saved.

Runs inside Blender 5.2 (bpy); no third-party modules.
"""

import hashlib
import json
import math
import os
import re
import struct
import sys

import bpy
from bpy_extras.anim_utils import action_get_channelbag_for_slot

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "sim", "data"))
DEFAULT_CONTRACT = os.path.join(DATA, "chicken.contract.json")
DEFAULT_MOVES = os.path.join(DATA, "moves.json")

# The Blender/exporter version the committed placeholder glb was made with.
# Exporter output (including asset.generator) is only byte-stable per version.
EXPECTED_BLENDER = (5, 2)

# Verified against io_scene_gltf2 5.2.40 (docs/research/blender.md section 2),
# except export_def_bones=True: control/IK bones in a hero rig must not count
# toward the joint budget, so every exported bone (including `root`) has to be
# marked Deform. presets/cockfight_glb.py mirrors these for the UI (a vitest
# test keeps the two in sync).
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

# moves.json moves whose active window is open-ended (the dive kick lasts until
# it lands), so startup + active + recovery is not a clip length. Mirrors the
# exception in packages/sim/src/rules.ts validateRules and anim.ts clipSample.
OPEN_ACTIVE_MOVES = {"dive_kick"}

EPS = 1e-4


class ExportError(Exception):
    """Problems the artist has to fix; each is printed as one `CF_ERROR: ...` line, no traceback."""

    def __init__(self, *problems):
        super().__init__("\n".join(problems))
        self.problems = list(problems)


def script_args():
    """Arguments after `--` on the Blender command line."""
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def load_contract(path=None):
    with open(path or DEFAULT_CONTRACT, encoding="utf-8") as f:
        return json.load(f)


def load_moves(path=None):
    with open(path or DEFAULT_MOVES, encoding="utf-8") as f:
        return json.load(f)


def run_main(main):
    """Run `main()`, turning ExportError into `CF_ERROR: ...` lines and exit code 1."""
    try:
        main()
    except ExportError as e:
        for problem in e.problems:
            print(f"CF_ERROR: {problem}", file=sys.stderr, flush=True)
        sys.exit(1)


def note_fix(message):
    """Something prepare_scene() changed in memory so the export works (the .blend is untouched)."""
    print(f"CF_FIX: {message}", flush=True)


def note(message):
    print(f"CF_NOTE: {message}", flush=True)


def warn_if_unexpected_blender():
    if tuple(bpy.app.version[:2]) != EXPECTED_BLENDER:
        print(
            f"CF_WARNING: running Blender {bpy.app.version_string}; the committed glb was exported with "
            f"{EXPECTED_BLENDER[0]}.{EXPECTED_BLENDER[1]}.x, so its bytes (and hitboxes sha256) will differ.",
            flush=True,
        )


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _fmt(v):
    """A frame count or phase for messages: 14, 7.2 (never 14.000000001)."""
    return f"{round(v, 3):g}"


def _fmt_list(values):
    return "[" + ", ".join(_fmt(v) for v in values) + "]"


# --------------------------------------------------------------------------- actions


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


def _single_strip_tracks(rig, action):
    """NLA tracks the exporter reads `action` from: its only unmuted strip plays `action`."""
    ad = rig.animation_data
    out = []
    for track in ad.nla_tracks if ad else []:
        strips = [s for s in track.strips if s.action is not None and not s.mute]
        if len(strips) == 1 and strips[0].action == action:
            out.append(track)
    return out


def _clip_name_of(action, rig):
    """The glTF animation name the exporter will give `action` (ACTIONS mode, merge by NLA track)."""
    for track in _single_strip_tracks(rig, action):
        if not (track.name.startswith("NlaTrack") or track.name.startswith("[Action Stash]")):
            return track.name
    return action.name


def _normalized(name):
    return re.sub(r"[\s.\-]+", "_", name.strip().lower())


def _stray_hint(clip, action, want, seen, rig):
    """Why `clip` (from `action`) is not a contract clip, and exactly what to do about it."""
    label = f"'{clip}'" + (f" (action '{action.name}')" if action.name != clip else "")
    delete = "delete it (Outliner > Blender File > Actions > right-click > Delete, or clear its fake user)"
    # "Action" (Action Editor > New) and "<object>Action" (the first key on an object) are Blender's defaults.
    if re.fullmatch(rf"(Action|{re.escape(rig.name)}Action|ArmatureAction)(\.\d{{3}})?", clip):
        return (
            f"stray action {label}: '{clip}' is the name Blender gives a new action, and every armature action "
            f"exports as a clip; {delete}, or if it holds one of the contract clips, rename it (and its NLA track) to that clip"
        )
    copy = re.fullmatch(r"(.+)\.(\d{3})", clip)
    if copy and copy.group(1) in want:
        return (
            f"stray action {label}: a copy of '{copy.group(1)}' (Blender appends .001 when it duplicates); "
            f"{delete}, and keep exactly one action named '{copy.group(1)}'"
        )
    near = next((w for w in want if _normalized(clip) == w), None)
    if near is not None:
        if near in seen:
            return f"stray action {label}: it looks like '{near}', which exists too; {delete}"
        return f"action {label} should be named exactly '{near}' (clip names are lower case with underscores): rename it and its NLA track"
    return f"unexpected armature action {label}: {delete}, or rename it (and its NLA track) to one of the {len(want)} contract clips"


# --------------------------------------------------------------------------- resampling


def resample_action(action, src_breaks, dst_breaks):
    """Re-key every channel of `action` on whole frames 0..dst_breaks[-1].

    Output frame g reads the old curves at a source frame given by a
    piecewise-linear map through (dst_breaks[i] -> src_breaks[i]), so with
    breaks at the phase boundaries a startup maps onto a startup, and so on.
    Keys become LINEAR on every frame: exactly what export_force_sampling
    samples anyway, so the export shows the old curves at the mapped times.
    F-curve modifiers are baked in and removed (they would apply twice).
    """
    n = int(round(dst_breaks[-1]))

    def source(g):
        for i in range(len(dst_breaks) - 1):
            d0, d1 = dst_breaks[i], dst_breaks[i + 1]
            if g <= d1 or i == len(dst_breaks) - 2:
                if d1 == d0:
                    return src_breaks[i + 1]
                return src_breaks[i] + (g - d0) * (src_breaks[i + 1] - src_breaks[i]) / (d1 - d0)
        return src_breaks[-1]

    times = [source(g) for g in range(n + 1)]
    for slot in action.slots:
        cb = action_get_channelbag_for_slot(action, slot)
        for fc in cb.fcurves if cb else []:
            values = [fc.evaluate(t) for t in times]
            while fc.modifiers:
                fc.modifiers.remove(fc.modifiers[0])
            fc.keyframe_points.clear()
            fc.keyframe_points.add(n + 1)
            fc.keyframe_points.foreach_set("co", [c for g, v in enumerate(values) for c in (float(g), v)])
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
            fc.update()
    action.use_frame_range = True
    action.frame_start, action.frame_end = 0, n


# --------------------------------------------------------------------------- scene checks


def _ensure_object_mode():
    if bpy.context.mode == "OBJECT":
        return
    was = bpy.context.mode
    if bpy.context.view_layer.objects.active is not None:
        bpy.ops.object.mode_set(mode="OBJECT")
    if bpy.context.mode != "OBJECT":
        raise ExportError(f"Blender is in {was} mode; switch to Object mode before exporting")
    note_fix(f"left {was.replace('_', ' ').title()} mode for Object mode (the file was saved in it)")


def _check_fps(contract, retime, problems):
    """Returns the factor that converts authored frames to contract frames, or None if timing can't be checked."""
    scn = bpy.context.scene
    fps = scn.render.fps / scn.render.fps_base
    want = contract["fps"]
    if abs(fps - want) <= 1e-6:
        return 1.0
    factor = want / fps
    if retime:
        scn.render.fps, scn.render.fps_base = want, 1.0
        note_fix(f"--retime: the scene ran at {fps:g} fps; every clip is scaled by {want}/{fps:g} = {factor:g} to keep its real-time length")
        return factor
    problems.append(
        f"the scene runs at {fps:g} fps, but clips are authored at {want} fps (1 frame = 1 sim tick). "
        f"If your keys already sit on the contract's {want} fps frame counts, set Output Properties > Frame Rate to {want} and save. "
        f"If you animated at {fps:g} fps by eye, re-run with --retime: every action is scaled by {want}/{fps:g} = {factor:g} so it keeps "
        f"its real-time length (clip lengths are checked once the frame rate is fixed)"
    )
    return None


def _find_rig(contract):
    rig_name = contract["rig"]["armature"]
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    if len(arms) != 1 or arms[0].name != rig_name:
        raise ExportError(f"expected exactly one armature object named '{rig_name}', found {[o.name for o in arms]}")
    rig = arms[0]
    if rig.parent is not None or not _is_identity(rig.matrix_world):
        raise ExportError(f"'{rig_name}' must be unparented with identity transforms (Object > Apply > All Transforms)")
    return rig


def _check_rig(rig, contract, problems):
    if rig.data.pose_position != "POSE":
        rig.data.pose_position = "POSE"
        note_fix(f"'{rig.name}' was showing its Rest Position, which would export every clip as the rest pose; switched to Pose Position")
    root = rig.data.bones.get(contract["rig"]["rootBone"])
    if root is None or root.parent is not None:
        problems.append(f"'{rig.name}' needs a top-level bone named '{contract['rig']['rootBone']}'")
    else:
        if not root.use_deform:
            problems.append(f"bone '{root.name}' must be marked Deform (Bone Properties > Deform): export_def_bones drops non-deform bones")
        # Armature space is world space here (Rig is identity). The sim places the fighter by the origin.
        if root.head_local.length > 1e-4:
            x, y, z = root.head_local
            problems.append(
                f"bone '{root.name}' must sit at the origin, but its head is at ({x:.3f}, {y:.3f}, {z:.3f}); "
                "move the whole chicken (mesh and rig) there, then apply transforms"
            )
    deform = [b.name for b in rig.data.bones if b.use_deform]
    other = [b.name for b in rig.data.bones if not b.use_deform]
    if len(deform) > contract["budgets"]["joints"]:
        problems.append(
            f"{len(deform)} bones are marked Deform, over the budget of {contract['budgets']['joints']}; untick Deform on "
            "control/IK/mechanism bones (Bone Properties > Deform) so they stay out of the export"
        )
    if other:
        note(f"{len(other)} non-deform bones stay in Blender and are not exported (control/IK bones are fine): {', '.join(sorted(other))}")

    meshes = [o for o in rig.children_recursive if o.type == "MESH"]
    skinned = [o for o in meshes if any(m.type == "ARMATURE" and m.object == rig for m in o.modifiers)]
    if len(skinned) != 1:
        problems.append(f"expected exactly one mesh with an Armature modifier on '{rig.name}', found {[o.name for o in skinned]}")
    else:
        extra = [o.name for o in meshes if o not in skinned]
        if extra:
            # Every exported mesh is drawn and counts toward the triangle budget; the spec allows one skinned mesh.
            problems.append(
                f"the chicken must be one skinned mesh, but {extra} are also under '{rig.name}': join them into "
                f"'{skinned[0].name}' (Ctrl+J) and weight them to their bones"
            )
        if not _is_identity(skinned[0].matrix_world):
            problems.append(f"mesh '{skinned[0].name}' must have identity transforms (Object > Apply > All Transforms)")


def _check_helpers(rig, contract, problems):
    helpers = {}
    for name, spec in contract["helpers"].items():
        obj = bpy.data.objects.get(name)
        if obj is None or obj not in rig.children_recursive:
            problems.append(
                f"missing hitbox helper '{name}': add an Empty named '{name}' and parent it to bone '{spec['bone']}' of "
                f"'{rig.name}' (select the empty, then the armature in Pose mode with '{spec['bone']}' active, Ctrl+P > Bone)"
            )
            continue
        if obj.type != "EMPTY":
            problems.append(f"hitbox helper '{name}' must be an Empty, not a {obj.type}")
            continue
        if obj.parent != rig or obj.parent_type != "BONE":
            problems.append(
                f"'{name}' is parented to the object '{obj.parent.name if obj.parent else None}', not to a bone, so it would not "
                f"follow the animation: parent it to bone '{spec['bone']}' (Ctrl+P > Bone)"
            )
        else:
            bone = rig.data.bones.get(obj.parent_bone)
            if bone is None or not bone.use_deform:
                problems.append(f"'{name}' hangs off bone '{obj.parent_bone}', which is missing or not Deform (the export drops non-deform bones)")
        shape = obj.get("cf_shape")
        if shape != spec["shape"]:
            problems.append(
                f"'{name}' needs custom property cf_shape = \"{spec['shape']}\" (Object Properties > Custom Properties, type String; "
                f"found {'nothing' if shape is None else repr(shape)})"
            )
        radius = obj.get("cf_radius")
        if not _num(radius) or radius <= 0:
            what = "has no custom property cf_radius" if radius is None else f"has cf_radius = {radius!r}, not a positive number"
            problems.append(
                f"'{name}' {what}. glTF does not export an empty's display size, so the hitbox radius must be a custom property: "
                f"add cf_radius = {obj.empty_display_size:g} (its display size) as a Float in Object Properties > Custom Properties"
            )
        if spec["shape"] == "capsule":
            hh = obj.get("cf_half_height")
            if not _num(hh) or hh < 0:
                what = "has no custom property cf_half_height" if hh is None else f"has cf_half_height = {hh!r}, not a number >= 0"
                problems.append(
                    f"'{name}' {what}: add cf_half_height as a Float, half the length of the capsule's straight middle along the "
                    f"empty's local Z (the placeholder uses {spec.get('halfHeight', 0):g})"
                )
        helpers[name] = obj
    return helpers


def _collect_clips(rig, contract, problems):
    """Map each contract clip name to its action. Strays, duplicates, multi-slot actions and missing clips are problems."""
    want = [c["name"] for c in contract["clips"]]
    seen = {}
    multi_slot = set()
    for action in bpy.data.actions:
        slots = _bone_slots(action)
        if not slots:
            continue
        if len(slots) > 1:
            problems.append(
                f"action '{action.name}' animates bones through {len(slots)} slots ({', '.join(s.name_display for s in slots)}) and would "
                f"export as '{action.name}-<slot>'; keep one slot per action"
            )
            multi_slot.add(action.name)  # reported here, not again as a missing clip
            continue
        tracks = _single_strip_tracks(rig, action)
        if len(tracks) > 1:
            problems.append(
                f"action '{action.name}' is the only strip on {len(tracks)} NLA tracks ({', '.join(t.name for t in tracks)}) and would "
                "export once per track; keep one"
            )
        clip = _clip_name_of(action, rig)
        if clip != action.name:
            note(f"action '{action.name}' exports as clip '{clip}' (the name of its NLA track)")
        if clip in seen:
            problems.append(f"actions '{seen[clip].name}' and '{action.name}' would both export as clip '{clip}'; rename one")
            continue
        seen[clip] = action
    renamed = set()  # clips a stray's hint already says to rename it to
    for clip, action in seen.items():
        if clip not in want:
            problems.append(_stray_hint(clip, action, want, seen, rig))
            renamed.update(w for w in want if _normalized(clip) == w and w not in seen)
    missing = [c for c in want if c not in seen and c not in multi_slot and c not in renamed]
    if missing:
        problems.append(
            "missing clips: " + ", ".join(f"'{c}'" for c in missing) + " (every contract clip needs an armature action of exactly that name)"
        )
    return {c: a for c, a in seen.items() if c in want}


def _attack_split(name, action, factor, clip, move, fps, problems):
    """The authored [startup, active, recovery] of an attack action, in its own frames, or None (problem reported).

    From its cf_phases when it has them; otherwise the clip must be as long as
    the move in moves.json (or, for an open-ended move, the contract clip) and
    is taken to be split the same way. `factor` converts authored frames to
    contract frames (it is not 1 only under --retime).
    """
    start, end = action.frame_range
    authored = end - start
    raw = action.get("cf_phases")
    if raw is not None:
        try:
            split = [float(x) for x in raw]
        except (TypeError, ValueError):
            split = []
        if len(split) != 3 or not all(_num(v) for v in split) or split[0] < 0 or split[1] <= 0 or split[2] < 0:
            shown = list(raw) if hasattr(raw, "__len__") and not isinstance(raw, str) else raw
            problems.append(f"action '{name}' has cf_phases = {shown!r}; it must be three numbers [startup, active, recovery] with active > 0")
            return None
        if abs(sum(split) - authored) > 1e-3:
            problems.append(
                f"action '{name}' has cf_phases = {_fmt_list(split)}, which adds up to {_fmt(sum(split))}, but the action spans "
                f"frames {_fmt(start)}..{_fmt(end)} ({_fmt(authored)} frames); make them agree"
            )
            return None
        return split

    length = authored * factor
    tol = factor if factor != 1.0 else 1e-3  # under --retime: within one authored frame
    n = clip["frames"]
    s, a, r = move["startup"], move["active"], move["recovery"]
    total = s + a + r

    def frames(k):
        return f"{_fmt(k)} frames" + (f" at {fps} fps ({_fmt(k / factor)} at the file's rate)" if factor != 1.0 else "")

    fix = (
        "or add a custom property cf_phases = [startup, active, recovery] to the action (Action Properties > Custom Properties): "
        f"three numbers adding up to {_fmt(authored)} that say where your wind-up, hit and recovery are, and the export retimes "
        f"it to the contract's {n} frames"
    )
    if name in OPEN_ACTIVE_MOVES:
        if abs(length - n) <= tol:
            return [p * authored / n for p in clip["phases"]]
        problems.append(
            f"attack clip '{name}' is {frames(length)}, but the contract needs {n} = {' + '.join(str(p) for p in clip['phases'])} "
            f"(moves.json leaves its active window open, so the clip is timed to the contract) and the action has no cf_phases. "
            f"Make the action last {frames(n)}, {fix}"
        )
        return None
    if abs(length - total) <= tol:
        return [p * authored / total for p in (s, a, r)]
    problems.append(
        f"attack clip '{name}' is {frames(length)}, but moves.json {name} lasts {s} + {a} + {r} = {total} frames and the "
        f"action has no cf_phases. Make the action last {frames(total)}, {fix}"
    )
    return None


def _conform_timing(clips, contract, moves, factor, problems):
    """Check every clip's length; retime (resample) the ones whose timing is known but differs from the contract."""
    move_table = (moves or {}).get("moves", {})
    retimed = []
    for clip in contract["clips"]:
        name = clip["name"]
        action = clips.get(name)
        if action is None:
            continue
        n = clip["frames"]
        start, end = action.frame_range
        length = (end - start) * factor
        move = move_table.get(name) if "phases" in clip else None

        if move is None:
            if factor == 1.0:
                if abs(length - n) > EPS:
                    problems.append(
                        f"clip '{name}' spans frames {_fmt(start)}..{_fmt(end)} ({_fmt(length)} frames); the contract needs exactly {n}. "
                        f"Set the action's frame range to {n} frames (Action Editor > Manual Frame Range, e.g. 0..{n})"
                    )
                elif abs(start - round(start)) > EPS:  # the exporter truncates the start frame to an int
                    resample_action(action, [start, end], [0, n])
                    retimed.append(name)
            elif abs(length - n) <= factor + 1e-6:
                resample_action(action, [start, end], [0, n])
                retimed.append(name)
            else:
                problems.append(
                    f"clip '{name}' is {_fmt(end - start)} frames at the file's frame rate = {_fmt(length)} frames at {contract['fps']} fps; "
                    f"the contract needs {n} ({_fmt(n / factor)} at the file's rate): fix its length"
                )
            continue

        split = _attack_split(name, action, factor, clip, move, contract["fps"], problems)
        if split is None:
            continue
        want = clip["phases"]
        same = factor == 1.0 and abs(start - round(start)) <= EPS and all(abs(p - w) <= EPS for p, w in zip(split, want))
        if same:
            if action.get("cf_phases") is None:
                action["cf_phases"] = list(want)
                note_fix(f"set cf_phases = {want} on action '{name}' (it is timed exactly like moves.json)")
            continue
        src = [start, start + split[0], start + split[0] + split[1], end]
        dst = [0, want[0], want[0] + want[1], n]
        resample_action(action, src, dst)
        action["cf_phases"] = list(want)
        scaled = [p * factor for p in split]
        if all(abs(p - w) <= 1e-3 for p, w in zip(scaled, want)):
            retimed.append(name)  # only the frame rate (or a fractional start) changed
        else:
            note_fix(
                f"retimed attack '{name}' from its authored split {_fmt_list(scaled)} ({_fmt(length)} frames) "
                f"to the contract's {want} ({n} frames), phase by phase"
            )
    if retimed:
        note_fix(f"retimed {len(retimed)} clips to their contract lengths: {', '.join(retimed)}")


def _ensure_tracks(rig, clips):
    """Put every clip action that no single-strip NLA track plays onto its own track named after the clip.

    The exporter would still export an off-track action, but only while
    something keeps it alive: an active-only action has no other user once
    export_chicken() clears the active slot, and a strip is what names the clip
    and gives it its own slide-to-zero.
    """
    ad = rig.animation_data
    made = []
    for clip, action in clips.items():
        if _single_strip_tracks(rig, action):
            continue
        track = ad.nla_tracks.new()
        track.name = clip
        strip = track.strips.new(clip, int(round(action.frame_range[0])), action)
        if strip.action_slot is None:
            strip.action_slot = _bone_slots(action)[0]
        made.append(clip)
    if made:
        note_fix(f"put {len(made)} actions that were not on NLA tracks onto tracks named after them: {', '.join(made)}")


def prepare_scene(contract, moves=None, retime=False):
    """Check the open scene against the contract, fixing what has one right answer.

    Returns (rig, helpers). Raises ExportError listing every problem left.
    `moves` (moves.json) adds the attack-length rules; `retime` rescales a
    scene authored at another frame rate instead of failing on it.
    """
    problems = []
    _ensure_object_mode()
    rig = _find_rig(contract)
    _check_rig(rig, contract, problems)
    helpers = _check_helpers(rig, contract, problems)
    for obj in [rig, *rig.children_recursive]:
        if obj.name not in bpy.context.view_layer.objects:
            problems.append(f"'{obj.name}' is in a collection excluded from the view layer (unticked in the Outliner), so it can't be exported: include it")

    ad = rig.animation_data
    if ad is None:
        if not any(_bone_slots(a) for a in bpy.data.actions):
            raise ExportError(f"'{rig.name}' has no animation; nothing to export")
        ad = rig.animation_data_create()
    if ad.use_tweak_mode:
        ad.use_tweak_mode = False
        note_fix("left NLA tweak mode (the file was saved while editing a strip)")

    factor = _check_fps(contract, retime, problems)
    clips = _collect_clips(rig, contract, problems)
    if factor is not None:
        _conform_timing(clips, contract, moves, factor, problems)
    _ensure_tracks(rig, clips)
    if problems:
        raise ExportError(*problems)
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


def export_chicken(out, contract, moves=None, retime=False):
    """Prepare the scene, export Rig + descendants to `out` atomically, verify, print CF_REPORT."""
    out = os.path.abspath(out)
    rig, _helpers = prepare_scene(contract, load_moves() if moves is None else moves, retime)

    export_set = [rig, *rig.children_recursive]
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    unhidden = []
    for obj in export_set:
        if obj.hide_get() or obj.hide_viewport:
            obj.hide_set(False)
            obj.hide_viewport = False
            unhidden.append(obj.name)
        obj.select_set(True)
    if unhidden:
        note_fix(f"unhid {', '.join(unhidden)} for the export (hidden objects can't be selected)")
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
