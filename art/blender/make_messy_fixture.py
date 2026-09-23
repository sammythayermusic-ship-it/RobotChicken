"""Build a deliberately messy .blend: the placeholder chicken as a UI-authored file would arrive.

    Blender -b --factory-startup --python-exit-code 1 --python art/blender/make_messy_fixture.py -- \
        [--out art/blender/out/messy_chicken.blend] [--habits all | fixable | <habit>,<habit>,...]

The hero export (export_chicken.py) must fix each habit or fail with a hint
naming it; tools/test/heroImport.test.ts (local only: it needs Blender) runs
fixtures through `pnpm assets:import` and checks exactly that. art/blender/out/
is gitignored.

The placeholder is built in this same Blender process (build_placeholder_chicken.py
without --out), so the fixture always matches the committed contract.
"""

import argparse
import os
import runpy
import sys

import bpy
from bpy_extras.anim_utils import action_get_channelbag_for_slot
from mathutils import Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cf_common as cf  # noqa: E402

# Applied in this order: bones and re-timed clips first, so the frame-rate and
# frame-1 habits move their keys along with everything else.
HABITS = {
    "ctrl_bones": "non-deform IK/control bones (ctrl_*), keyed in idle, one IK constraint at zero influence",
    "attack_phases": "shove authored twice as long (54 frames) with cf_phases = [16, 6, 32]",
    "attack_len": "peck stretched to 18 frames and its cf_phases removed",
    "fps24": "the scene left at Blender's default 24 fps, every clip timed at 24 fps (keys scaled by 24/60)",
    "frame1": "every clip starts on frame 1 (Blender's default) with no manual frame range",
    "off_nla": "actions never pushed down to the NLA: they only have fake users",
    "active_action": "the last clip worked on (win) is still the active action: on no track, no fake user",
    "stray_action": "a leftover 'Action' from testing keys",
    "no_radius": "hitbox empties with a display size but no cf_radius",
    "hidden_helpers": "hitbox empties hidden in the viewport",
    "rest_position": "the armature left showing its Rest Position",
    "pose_mode": "saved in Pose mode",
}
# Every habit export_chicken.py fixes by itself (fps24 only with --retime).
FIXABLE = ["ctrl_bones", "attack_phases", "frame1", "off_nla", "active_action", "hidden_helpers", "rest_position", "pose_mode"]


def build_placeholder():
    """Run build_placeholder_chicken.py here with no arguments: build and check, no export."""
    argv = sys.argv
    sys.argv = [argv[0], "--"]
    try:
        runpy.run_path(os.path.join(HERE, "build_placeholder_chicken.py"), run_name="__main__")
    finally:
        sys.argv = argv
    return bpy.data.objects["Rig"]


def bone_actions():
    return [a for a in bpy.data.actions if cf._bone_slots(a)]


def free_handles(action):
    """Pin every Bezier handle where it is, so moving keys can't make Blender re-derive (and reshape) them."""
    for slot in action.slots:
        cb = action_get_channelbag_for_slot(action, slot)
        for fc in cb.fcurves if cb else []:
            for kp in fc.keyframe_points:
                kp.handle_left_type = kp.handle_right_type = "FREE"


def move_keys(action, scale=1.0, offset=0.0):
    """t -> t * scale + offset for every key, handle and the manual frame range."""
    free_handles(action)
    for slot in action.slots:
        cb = action_get_channelbag_for_slot(action, slot)
        for fc in cb.fcurves if cb else []:
            for kp in fc.keyframe_points:
                for p in (kp.co, kp.handle_left, kp.handle_right):
                    p.x = p.x * scale + offset
    if action.use_frame_range:
        action.frame_start, action.frame_end = action.frame_start * scale + offset, action.frame_end * scale + offset


def ctrl_bones(rig):
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    for name, head in (("ctrl_foot_L", (0.2, 0.0, 0.0)), ("ctrl_foot_R", (-0.2, 0.0, 0.0)), ("ctrl_look", (0.0, -1.2, 1.1))):
        b = eb.new(name)
        b.head = Vector(head)
        b.tail = b.head + Vector((0.0, -0.15, 0.0))
        b.parent = eb["root"]
        b.use_deform = False
    bpy.ops.object.mode_set(mode="OBJECT")
    ik = rig.pose.bones["shin_L"].constraints.new("IK")
    ik.target, ik.subtarget, ik.chain_count, ik.influence = rig, "ctrl_foot_L", 2, 0.0
    idle = bpy.data.actions["idle"]
    bag = action_get_channelbag_for_slot(idle, cf._bone_slots(idle)[0])
    fc = bag.fcurves.new('pose.bones["ctrl_look"].location', index=2, group_name="ctrl_look")
    fc.keyframe_points.add(3)
    fc.keyframe_points.foreach_set("co", [0.0, 0.0, 30.0, 0.1, 60.0, 0.0])
    fc.update()


def apply(habits, rig, contract):
    scn = bpy.context.scene
    helpers = [bpy.data.objects[name] for name in contract["helpers"]]
    frames = {c["name"]: c for c in contract["clips"]}
    ad = rig.animation_data
    if "ctrl_bones" in habits:
        ctrl_bones(rig)
    if "attack_phases" in habits:
        s, a, r = frames["shove"]["phases"]
        cf.resample_action(bpy.data.actions["shove"], [0, s, s + a, s + a + r], [0, 2 * s, 2 * (s + a), 2 * (s + a + r)])
        bpy.data.actions["shove"]["cf_phases"] = [2 * s, 2 * a, 2 * r]
    if "attack_len" in habits:
        peck = bpy.data.actions["peck"]
        cf.resample_action(peck, [0, frames["peck"]["frames"]], [0, 18])
        del peck["cf_phases"]
    if "fps24" in habits:
        scn.render.fps, scn.render.fps_base = 24, 1.0
        k = 24 / contract["fps"]
        for act in bone_actions():
            move_keys(act, scale=k)
            if "cf_phases" in act:
                act["cf_phases"] = [p * k for p in act["cf_phases"]]
    if "frame1" in habits:
        scn.frame_start = 1
        for act in bone_actions():
            move_keys(act, offset=1.0)
            act.use_frame_range = False
    if "off_nla" in habits:
        while ad.nla_tracks:
            ad.nla_tracks.remove(ad.nla_tracks[0])
    if "active_action" in habits:
        win = bpy.data.actions["win"]
        for track in [t for t in ad.nla_tracks if any(s.action == win for s in t.strips)]:
            ad.nla_tracks.remove(track)
        ad.action = win
        ad.action_slot = cf._bone_slots(win)[0]
        win.use_fake_user = False
    if "stray_action" in habits:
        act = bpy.data.actions.new("Action")
        act.use_fake_user = True
        slot = act.slots.new(id_type="OBJECT", name="Rig")
        bag = act.layers.new("Layer").strips.new(type="KEYFRAME").channelbag(slot, ensure=True)
        fc = bag.fcurves.new('pose.bones["head"].rotation_euler', index=0, group_name="head")
        fc.keyframe_points.add(2)
        fc.keyframe_points.foreach_set("co", [1.0, 0.0, 12.0, 0.4])
        fc.update()
    if "no_radius" in habits:
        for e in helpers:
            del e["cf_radius"]
    if "hidden_helpers" in habits:
        for e in helpers:
            e.hide_set(True)
    if "rest_position" in habits:
        rig.data.pose_position = "REST"
    if "pose_mode" in habits:
        for obj in bpy.context.view_layer.objects:
            obj.select_set(obj == rig)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode="POSE")


def parse_habits(spec):
    if spec == "all":
        return list(HABITS)
    if spec == "fixable":
        return list(FIXABLE)
    habits = [h.strip() for h in spec.split(",") if h.strip()]
    unknown = [h for h in habits if h not in HABITS]
    if unknown:
        raise cf.ExportError(f"unknown habits {unknown}; choose from all, fixable, {', '.join(HABITS)}")
    return habits


def main():
    ap = argparse.ArgumentParser(prog="make_messy_fixture.py")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "messy_chicken.blend"))
    ap.add_argument("--habits", default="all", help="all, fixable, or a comma list of: " + ", ".join(HABITS))
    ap.add_argument("--contract", default=cf.DEFAULT_CONTRACT)
    args = ap.parse_args(cf.script_args())
    habits = parse_habits(args.habits)
    contract = cf.load_contract(args.contract)
    rig = build_placeholder()
    apply([h for h in HABITS if h in habits], rig, contract)
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    for h in HABITS:
        if h in habits:
            print(f"CF_HABIT {h}: {HABITS[h]}", flush=True)
    print(f"CF_FIXTURE {out}", flush=True)


cf.run_main(main)
