"""Build the placeholder robot chicken from chicken.contract.json and export it.

    Blender -b --factory-startup --python-exit-code 1 --python art/blender/build_placeholder_chicken.py -- \
        [--out apps/web/public/models/chicken_placeholder.glb] [--contract <json>] \
        [--blend art/blender/out/placeholder.blend] [--preview docs/captures/phase-0/placeholder_contact.png]

Normally run through `pnpm assets:placeholder` (tools/src/cli/placeholder.ts).

Everything is written in MODEL space, which is glTF space: x = the chicken's
left, y = up, z = forward. Blender space is (x, -z, y), so the chicken faces
Blender -Y. Every bone points up (+Z in Blender) with roll 0, which makes each
bone's local axes equal the model axes: pose locations are (side, up, forward)
and Euler rotations are (pitch, yaw, roll) in degrees, +pitch leaning forward.
The glTF joints therefore all have identity rest rotation.

No randomness and no clock: two runs give byte-identical glbs.
"""

import argparse
import math
import os
import sys
import tempfile

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_common as cf  # noqa: E402


def to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def to_model(v):
    return Vector((v[0], v[2], -v[1]))


# --------------------------------------------------------------------------- rig

# (bone, parent, pivot). 16 bones, all deforming, parents first.
BONES = [
    ("root", None, (0.0, 0.0, 0.0)),
    ("body", "root", (0.0, 0.55, 0.0)),
    ("neck", "body", (0.0, 0.90, 0.22)),
    ("head", "neck", (0.0, 1.06, 0.28)),
    ("jaw", "head", (0.0, 1.07, 0.44)),
    ("comb", "head", (0.0, 1.28, 0.27)),
    ("wattle", "head", (0.0, 1.02, 0.43)),
    ("wing_L", "body", (0.40, 0.92, 0.04)),
    ("wing_R", "body", (-0.40, 0.92, 0.04)),
    ("tail", "body", (0.0, 0.90, -0.40)),
    ("thigh_L", "body", (0.20, 0.52, 0.02)),
    ("thigh_R", "body", (-0.20, 0.52, 0.02)),
    ("shin_L", "thigh_L", (0.20, 0.30, -0.06)),
    ("shin_R", "thigh_R", (-0.20, 0.30, -0.06)),
    ("foot_L", "shin_L", (0.20, 0.07, 0.02)),
    ("foot_R", "shin_R", (-0.20, 0.07, 0.02)),
]
BONE_NAMES = [n for n, _, _ in BONES]
PIVOT = {n: Vector(p) for n, _, p in BONES}
PARENT = {n: parent for n, parent, _ in BONES}
BONE_LENGTH = 0.08  # display only; helpers are placed relative to the tail

# Rest positions of the hitbox helpers (sizes come from the contract).
HELPER_POS = {"hurt_body": (0.0, 0.82, 0.0), "hit_beak": (0.0, 1.11, 0.55)}

# hit_beak (z, y) ranges during each attack's ACTIVE samples, and the most
# forward the beak may be during startup and recovery. The sim reads these
# positions from hitboxes.json, so they are what makes frame data meaningful.
# RETRACTED_Z is visual only (wind-up and follow-through): the sim tests hit
# spheres only on active samples, and a retracted beak still reaches an
# opponent at pushbox contact.
ACTIVE_TARGETS = {
    "peck": ((0.85, 1.00), (0.75, 0.90)),
    "shove": ((0.70, 0.80), (0.55, 0.65)),
    "slam": ((0.80, 0.90), (0.10, 0.20)),
    "super": ((0.90, 1.00), (0.75, 0.85)),
    "dive_kick": ((0.40, 0.50), (-0.10, 0.00)),
}
RETRACTED_Z = 0.60

# --------------------------------------------------------------------------- look

MATERIALS = {  # linear base color, metallic, roughness; no textures
    "cf_shell": dict(color=(0.33, 0.055, 0.025), metallic=0.55, roughness=0.6),  # rusty red scrap metal
    "cf_trim": dict(color=(0.06, 0.06, 0.065), metallic=0.9, roughness=0.35),  # gunmetal
    "cf_eye": dict(color=(1.0, 0.62, 0.04), metallic=0.0, roughness=0.25, emission=1.0),  # amber lamp
    "cf_beak": dict(color=(0.70, 0.40, 0.06), metallic=0.85, roughness=0.3),  # brass
    "cf_comb": dict(color=(0.75, 0.02, 0.015), metallic=0.2, roughness=0.45),  # red
}


def part(bone, mat, center, size, rot=(0.0, 0.0, 0.0), taper=1.0):
    """A beveled box weighted 100% to `bone`. `taper` shrinks the front (+z) face."""
    return dict(bone=bone, mat=mat, center=center, size=size, rot=rot, taper=taper)


def _legs(side, x):
    return [
        part(f"thigh_{side}", "cf_trim", (x, 0.41, -0.02), (0.14, 0.27, 0.15), rot=(20.0, 0.0, 0.0)),
        part(f"shin_{side}", "cf_trim", (x, 0.185, -0.02), (0.06, 0.26, 0.06), rot=(-19.0, 0.0, 0.0)),
        part(f"foot_{side}", "cf_beak", (x, 0.03, 0.07), (0.15, 0.06, 0.24)),
        part(f"foot_{side}", "cf_beak", (x + 0.045, 0.02, 0.23), (0.035, 0.04, 0.10), taper=0.6),
        part(f"foot_{side}", "cf_beak", (x - 0.045, 0.02, 0.23), (0.035, 0.04, 0.10), taper=0.6),
        part(f"foot_{side}", "cf_beak", (x, 0.035, -0.09), (0.03, 0.03, 0.08)),
    ]


def _wing(side, x):
    s = 1.0 if x > 0 else -1.0
    return [
        part(f"wing_{side}", "cf_shell", (x, 0.76, -0.04), (0.07, 0.38, 0.62)),
        part(f"wing_{side}", "cf_trim", (x + s * 0.04, 0.68, -0.06), (0.02, 0.08, 0.50)),
        part(f"wing_{side}", "cf_trim", (x + s * 0.04, 0.84, -0.02), (0.02, 0.06, 0.40)),
    ]


def _tail_plate(pitch, x):
    r = math.radians(pitch)
    center = (x, 0.90 + 0.18 * math.cos(r), -0.40 + 0.18 * math.sin(r))
    return part("tail", "cf_shell", center, (0.03, 0.34, 0.11), rot=(pitch, 0.0, 0.0))


PARTS = [
    part("body", "cf_shell", (0.0, 0.74, -0.02), (0.78, 0.54, 0.84)),  # torso
    part("body", "cf_trim", (0.0, 0.70, 0.41), (0.50, 0.34, 0.05)),  # chest plate
    part("body", "cf_trim", (0.17, 1.02, -0.26), (0.12, 0.05, 0.22)),  # back vents
    part("body", "cf_trim", (-0.17, 1.02, -0.26), (0.12, 0.05, 0.22)),
    part("body", "cf_trim", (0.0, 0.48, -0.02), (0.62, 0.04, 0.66)),  # belly plate
    part("neck", "cf_trim", (0.0, 0.99, 0.25), (0.20, 0.24, 0.20)),
    part("head", "cf_shell", (0.0, 1.15, 0.28), (0.34, 0.30, 0.34)),
    part("head", "cf_eye", (0.172, 1.18, 0.35), (0.02, 0.08, 0.09)),
    part("head", "cf_eye", (-0.172, 1.18, 0.35), (0.02, 0.08, 0.09)),
    part("head", "cf_beak", (0.0, 1.115, 0.51), (0.15, 0.075, 0.14), taper=0.4),  # upper beak, tip z=.58
    part("jaw", "cf_beak", (0.0, 1.055, 0.49), (0.12, 0.045, 0.11), taper=0.5),  # lower beak
    part("comb", "cf_comb", (0.0, 1.35, 0.36), (0.06, 0.10, 0.08)),
    part("comb", "cf_comb", (0.0, 1.39, 0.27), (0.06, 0.18, 0.09)),
    part("comb", "cf_comb", (0.0, 1.36, 0.18), (0.06, 0.12, 0.08)),
    part("wattle", "cf_comb", (0.0, 0.98, 0.44), (0.05, 0.10, 0.05)),
    *_wing("L", 0.435),
    *_wing("R", -0.435),
    _tail_plate(-25.0, 0.0),
    _tail_plate(-50.0, 0.05),
    _tail_plate(-50.0, -0.05),
    _tail_plate(-75.0, 0.0),
    *_legs("L", 0.20),
    *_legs("R", -0.20),
]


# --------------------------------------------------------------------------- poses


def bn(loc=None, rot=None, scl=None):
    """One bone's pose: loc (side, up, fwd), rot (pitch, yaw, roll) in degrees, scale."""
    return {k: tuple(v) for k, v in (("loc", loc), ("rot", rot), ("scl", scl)) if v is not None}


def P(base=None, **bones):
    """A pose (bone -> bn). Starts from `base`; bones listed here replace theirs."""
    out = {k: dict(v) for k, v in (base or {}).items()}
    out.update({k: dict(v) for k, v in bones.items()})
    return out


def wings(pitch=0.0, yaw=0.0, roll=0.0, loc=(0.0, 0.0, 0.0)):
    """Mirrored wing pose; +roll lifts the wings out and up."""
    return {
        "wing_L": bn(loc=loc, rot=(pitch, yaw, roll)),
        "wing_R": bn(loc=(-loc[0], loc[1], loc[2]), rot=(pitch, -yaw, -roll)),
    }


def legs(thigh=0.0, shin=0.0, foot=0.0, spread=0.0):
    """Explicit (airborne) leg pose, both sides alike."""
    return {
        f"{k}_{s}": bn(rot=(a, 0.0, sgn * spread if k == "thigh" else 0.0))
        for s, sgn in (("L", 1.0), ("R", -1.0))
        for k, a in (("thigh", thigh), ("shin", shin), ("foot", foot))
    }


def fk(pose):
    """Model-space world matrices of every bone (the same math Blender's pose evaluation does)."""
    world = {}
    for name, parent, _ in BONES:
        p = pose.get(name, {})
        offset = PIVOT[name] - (PIVOT[parent] if parent else Vector((0.0, 0.0, 0.0)))
        rot = Euler(tuple(math.radians(a) for a in p.get("rot", (0.0, 0.0, 0.0))), "XYZ").to_matrix().to_4x4()
        local = Matrix.Translation(offset + Vector(p.get("loc", (0.0, 0.0, 0.0)))) @ rot
        local = local @ Matrix.Diagonal((*p.get("scl", (1.0, 1.0, 1.0)), 1.0))
        world[name] = world[parent] @ local if parent else local
    return world


def attached(world, bone, point):
    return world[bone] @ (Vector(point) - PIVOT[bone])


def reach(pose, bone, z, y):
    """Translate `bone` so hit_beak lands exactly on model (z, y). Exact: a translation moves the chain rigidly."""
    world = fk(pose)
    beak = attached(world, "head", HELPER_POS["hit_beak"])
    parent = PARENT[bone]
    rot = world[parent].to_3x3() if parent else Matrix.Identity(3)
    delta = rot.inverted() @ (Vector((beak.x, y, z)) - beak)
    loc = Vector(pose.get(bone, {}).get("loc", (0.0, 0.0, 0.0))) + delta
    return P(pose, **{bone: {**pose.get(bone, {}), "loc": tuple(loc)}})


def _psi(u, v):
    """Pitch angle (degrees) of a sagittal vector (forward u, up v), measured from +up toward +forward."""
    return math.degrees(math.atan2(u, v))


def _wrap(a):
    return (a + 180.0) % 360.0 - 180.0


def ground(pose, left=(0.0, 0.0), right=(0.0, 0.0), toe=0.0):
    """Two-bone IK: bend each leg so its ankle sits on its rest spot + (dz, dy), knee back, foot flat.

    Works in the sagittal plane and assumes the body only pitches (no yaw/roll).
    """
    world = fk(pose)
    body_pitch = pose.get("body", {}).get("rot", (0.0, 0.0, 0.0))[0]
    out = P(pose)
    for side, (dz, dy) in (("L", left), ("R", right)):
        h0, k0, a0 = PIVOT[f"thigh_{side}"], PIVOT[f"shin_{side}"], PIVOT[f"foot_{side}"]
        l1, l2 = (k0 - h0).yz.length, (a0 - k0).yz.length
        hip = world[f"thigh_{side}"].translation
        du, dv = a0.z + dz - hip.z, a0.y + dy - hip.y
        dist = min(max(math.hypot(du, dv), abs(l1 - l2) + 1e-6), l1 + l2 - 1e-6)
        bend = math.degrees(math.acos((l1 * l1 + dist * dist - l2 * l2) / (2.0 * l1 * dist)))
        thigh_w = _psi(du, dv) + bend
        knee_u = hip.z + l1 * math.sin(math.radians(thigh_w))
        knee_v = hip.y + l1 * math.cos(math.radians(thigh_w))
        scale = dist / max(math.hypot(du, dv), 1e-9)
        shin_w = _psi(hip.z + du * scale - knee_u, hip.y + dv * scale - knee_v)
        thigh_d = _wrap(thigh_w - _psi(k0.z - h0.z, k0.y - h0.y))
        shin_d = _wrap(shin_w - _psi(a0.z - k0.z, a0.y - k0.y))
        out[f"thigh_{side}"] = bn(rot=(_wrap(thigh_d - body_pitch), 0.0, 0.0))
        out[f"shin_{side}"] = bn(rot=(_wrap(shin_d - thigh_d), 0.0, 0.0))
        out[f"foot_{side}"] = bn(rot=(_wrap(toe - shin_d), 0.0, 0.0))
    return out


def G(**bones):
    """A grounded pose: feet planted on their rest spots."""
    return ground(P(**bones))


REST = P()


# ---- attacks: the strike keys are solved onto the target so the hitbox is exact


def clip_peck():
    windup = G(body=bn(rot=(-6, 0, 0), loc=(0, 0, -0.03)), neck=bn(rot=(-18, 0, 0)), head=bn(loc=(0, 0.03, -0.06), rot=(6, 0, 0)),
               tail=bn(rot=(-12, 0, 0)), **wings(roll=10))
    strike = dict(body=bn(rot=(16, 0, 0), loc=(0, -0.02, 0.06)), neck=bn(rot=(24, 0, 0)), head=bn(rot=(-10, 0, 0)),
                  jaw=bn(rot=(-20, 0, 0)), tail=bn(rot=(10, 0, 0)), **wings(roll=4, pitch=10))
    return [
        (0, REST),
        (2, G(body=bn(rot=(-3, 0, 0)), neck=bn(rot=(-10, 0, 0)), head=bn(loc=(0, 0.015, -0.03)), **wings(roll=6))),
        (4, windup),
        (5, ground(reach(P(**strike), "head", 0.90, 0.80))),
        (6, ground(reach(P(**{**strike, "body": bn(rot=(18, 0, 0), loc=(0, -0.02, 0.07))}), "head", 0.93, 0.79))),
        (7, G(body=bn(rot=(9, 0, 0), loc=(0, -0.02, 0.02)), neck=bn(rot=(-14, 0, 0)), head=bn(loc=(0, 0.01, -0.10), rot=(4, 0, 0)),
              tail=bn(rot=(14, 0, 0)), comb=bn(rot=(-10, 0, 0)), **wings(roll=8, pitch=6))),
        (10, G(body=bn(rot=(4, 0, 0), loc=(0, -0.01, 0)), neck=bn(rot=(-5, 0, 0)), head=bn(loc=(0, 0, -0.04)),
               tail=bn(rot=(-6, 0, 0)), comb=bn(rot=(6, 0, 0)))),
        (14, REST),
    ]


def clip_shove():
    coil = dict(body=bn(rot=(-14, 0, 0), loc=(0, -0.05, -0.08)), neck=bn(rot=(-12, 0, 0)), head=bn(loc=(0, 0, -0.04)),
                tail=bn(rot=(-10, 0, 0)), **wings(pitch=35, roll=25))
    lunge = dict(body=bn(rot=(24, 0, 0), loc=(0, -0.06, 0.04)), neck=bn(rot=(36, 0, 0)), head=bn(rot=(-16, 0, 0)),
                 tail=bn(rot=(12, 0, 0)), **wings(pitch=-70, roll=12, loc=(0, 0, 0.10)))
    return [
        (0, REST),
        (4, ground(P(**{**coil, "body": bn(rot=(-10, 0, 0), loc=(0, -0.03, -0.05))}))),
        (8, ground(P(**coil), left=(-0.04, 0), right=(0.02, 0))),
        (9, ground(reach(P(**lunge), "body", 0.75, 0.60), left=(0.10, 0), right=(-0.04, 0))),
        (10, ground(reach(P(**lunge), "body", 0.765, 0.595), left=(0.10, 0), right=(-0.04, 0))),
        (11, ground(reach(P(**lunge), "body", 0.775, 0.59), left=(0.10, 0), right=(-0.04, 0))),
        (12, ground(P(body=bn(rot=(12, 0, 0), loc=(0, -0.05, 0.03)), neck=bn(rot=(-22, 0, 0)), head=bn(loc=(0, 0.02, -0.08)),
                      tail=bn(rot=(16, 0, 0)), **wings(pitch=-40, roll=15, loc=(0, 0, 0.06))), left=(0.10, 0), right=(-0.04, 0))),
        (18, ground(P(body=bn(rot=(4, 0, 0), loc=(0, -0.02, 0.02)), neck=bn(rot=(-6, 0, 0)), **wings(pitch=-10, roll=8)),
                    left=(0.05, 0), right=(-0.02, 0))),
        (27, REST),
    ]


def clip_slam():
    rear = dict(neck=bn(rot=(-38, 0, 0)), head=bn(rot=(-18, 0, 0)), jaw=bn(rot=(-15, 0, 0)), tail=bn(rot=(-25, 0, 0)),
                **wings(roll=80, pitch=-10))
    impact = dict(body=bn(rot=(42, 0, 0)), neck=bn(rot=(44, 0, 0)), head=bn(rot=(4, 0, 0)), tail=bn(rot=(-30, 0, 0)),
                  comb=bn(rot=(15, 0, 0)), **wings(roll=-5, pitch=-40, loc=(0, 0, 0.06)))
    return [
        (0, REST),
        (5, ground(P(**rear, body=bn(rot=(-14, 0, 0), loc=(0, 0.02, -0.03))))),
        (10, ground(P(**rear, body=bn(rot=(-22, 0, 0), loc=(0, 0.05, -0.05))))),
        (14, ground(P(**{**rear, "neck": bn(rot=(-42, 0, 0))}, body=bn(rot=(-24, 0, 0), loc=(0, 0.06, -0.05))))),
        (15, ground(reach(P(**impact), "body", 0.85, 0.15), left=(0.06, 0), right=(0.06, 0))),
        (16, ground(reach(P(**{**impact, "body": bn(rot=(44, 0, 0))}), "body", 0.86, 0.14), left=(0.06, 0), right=(0.06, 0))),
        (18, ground(reach(P(**impact), "body", 0.85, 0.15), left=(0.06, 0), right=(0.06, 0))),
        (19, ground(P(body=bn(rot=(18, 0, 0), loc=(0, -0.10, -0.04)), neck=bn(rot=(-18, 0, 0)), head=bn(loc=(0, 0.02, -0.10)),
                      tail=bn(rot=(-10, 0, 0)), comb=bn(rot=(-12, 0, 0)), **wings(roll=30, pitch=-20)), left=(0.06, 0), right=(0.06, 0))),
        (26, ground(P(body=bn(rot=(6, 0, 0), loc=(0, -0.04, 0)), neck=bn(rot=(-4, 0, 0)), comb=bn(rot=(5, 0, 0)), **wings(roll=10)),
                    left=(0.03, 0), right=(0.03, 0))),
        (40, REST),
    ]


def clip_super():
    charge = dict(body=bn(rot=(-12, 0, 0), loc=(0, -0.11, -0.02)), neck=bn(rot=(-16, 0, 0)), jaw=bn(rot=(-28, 0, 0)),
                  tail=bn(rot=(-25, 0, 0)), comb=bn(rot=(-8, 0, 0)), **wings(roll=95, pitch=-10))
    rocket = dict(body=bn(rot=(76, 0, 0)), neck=bn(rot=(-40, 0, 0)), head=bn(rot=(-32, 0, 0)), jaw=bn(rot=(-20, 0, 0)),
                  tail=bn(rot=(-20, 0, 0)), **wings(roll=12, pitch=-15), **legs(thigh=24, shin=10, foot=20))
    jitter = [(0.95, 0.80, 0.0), (0.955, 0.805, 2.5), (0.945, 0.795, -2.5), (0.955, 0.80, 2.0), (0.95, 0.805, -2.0), (0.955, 0.80, 0.0)]
    keys = [
        (0, REST),
        (4, ground(P(**{**charge, "body": bn(rot=(-8, 0, 0), loc=(0, -0.07, -0.01))}))),
        (8, ground(P(**charge))),
        (10, ground(P(**{**charge, "neck": bn(rot=(-19, 0, 0))}))),
    ]
    for i, (z, y, wob) in enumerate(jitter):  # samples 11..16 = active
        keys.append((11 + i, reach(P(**{**rocket, "body": bn(rot=(76 + wob, 0, 0))}), "body", z, y)))
    keys += [
        (17, P(body=bn(rot=(28, 0, 0), loc=(0, 0.10, -0.06)), neck=bn(rot=(-34, 0, 0)), head=bn(loc=(0, 0.02, -0.06)),
               tail=bn(rot=(-15, 0, 0)), **wings(roll=60, pitch=-10), **legs(thigh=-20, shin=30, foot=-10))),
        (24, ground(P(body=bn(rot=(6, 0, 0), loc=(0, -0.08, -0.03)), neck=bn(rot=(-6, 0, 0)), head=bn(loc=(0, 0, -0.03)),
                      comb=bn(rot=(10, 0, 0)), **wings(roll=35)))),
        (34, ground(P(body=bn(rot=(-3, 0, 0), loc=(0, 0.01, 0)), comb=bn(rot=(-5, 0, 0)), **wings(roll=8)))),
        (46, REST),
    ]
    return keys


def clip_dive_kick():
    tuck = P(body=bn(rot=(-6, 0, 0)), **wings(roll=45), **legs(thigh=-50, shin=90, foot=-30))
    dive = dict(body=bn(rot=(106, 0, 0)), neck=bn(rot=(0, 0, 0)), head=bn(rot=(-60, 0, 0)), tail=bn(rot=(-10, 0, 0)),
                comb=bn(rot=(-10, 0, 0)), **wings(roll=8, pitch=-25), **legs(thigh=-10, shin=20, foot=40))
    keys = [
        (0, tuck),
        (3, P(body=bn(rot=(-12, 0, 0)), neck=bn(rot=(-10, 0, 0)), **wings(roll=85), **legs(thigh=-55, shin=95, foot=-30))),
        (6, P(body=bn(rot=(16, 0, 0)), neck=bn(rot=(-30, 0, 0)), head=bn(loc=(0, 0, -0.08)), **wings(roll=-10, pitch=-20),
              **legs(thigh=-30, shin=60, foot=-10))),
    ]
    flutter = [0, 6, -4, 5, -3, 6, -4, 5, -2, 4]
    for i, w in enumerate(flutter):  # samples 7..16 = active
        z = 0.45 + (0.01 if i % 2 else 0.0)
        pose = P(**{**dive, **wings(roll=8 + w, pitch=-25)})
        keys.append((7 + i, reach(pose, "body", z, -0.05)))
    keys += [
        (17, ground(P(body=bn(rot=(12, 0, 0), loc=(0, -0.15, -0.04)), neck=bn(rot=(0, 0, 0)), head=bn(loc=(0, 0, -0.10)),
                      comb=bn(rot=(20, 0, 0)), tail=bn(rot=(15, 0, 0)), **wings(roll=55, pitch=-10)))),
        (22, ground(P(body=bn(rot=(5, 0, 0), loc=(0, -0.07, -0.02)), neck=bn(rot=(-4, 0, 0)), head=bn(loc=(0, 0, -0.03)),
                      comb=bn(rot=(-8, 0, 0)), **wings(roll=20)))),
        (30, REST),
    ]
    return keys


# ---- movement and reactions


def _walk(frames, direction, lean):
    keys = []
    for f in range(0, frames + 1, 4):
        ph = 2.0 * math.pi * f / frames
        s, c2 = math.sin(ph), math.cos(2.0 * ph)
        stride = 0.16 * direction
        lift_l, lift_r = max(0.0, s) * 0.07, max(0.0, -s) * 0.07
        pose = P(body=bn(rot=(lean, 0, 3.0 * s), loc=(0, -0.015 * (1.0 - c2) - 0.02, 0)),
                 neck=bn(rot=(4.0 * c2, 0, 0)), head=bn(loc=(0, 0, 0.03 * c2 * direction)),
                 tail=bn(rot=(0, 8.0 * s, 0)), comb=bn(rot=(3.0 * c2, 0, 0)), **wings(roll=6.0 + 5.0 * c2))
        pose = ground(pose, left=(stride * -math.cos(ph), lift_l), right=(stride * math.cos(ph), lift_r))
        keys.append((f, pose))
    keys[-1] = (frames, keys[0][1])  # exact loop
    return keys


def clip_idle():
    return [
        (0, REST),
        (15, G(body=bn(loc=(0, -0.012, 0)), neck=bn(rot=(3, 0, 0)), head=bn(rot=(-3, 0, 0)), tail=bn(rot=(0, 6, 0)), **wings(roll=3))),
        (30, G(body=bn(loc=(0, -0.024, 0)), neck=bn(rot=(5, 0, 0)), head=bn(rot=(-5, 0, 0)), comb=bn(rot=(4, 0, 0)))),
        (45, G(body=bn(loc=(0, -0.012, 0)), neck=bn(rot=(3, 0, 0)), head=bn(rot=(-2, 0, 0)), tail=bn(rot=(0, -6, 0)), **wings(roll=3))),
        (60, REST),
    ]


def clip_dash():
    swept = G(body=bn(rot=(20, 0, 0), loc=(0, -0.04, 0)), neck=bn(rot=(-12, 0, 0)), head=bn(rot=(-6, 0, 0)),
              tail=bn(rot=(-15, 0, 0)), comb=bn(rot=(-15, 0, 0)), **wings(pitch=40, roll=20))
    return [(0, REST), (2, swept), (9, P(swept, **wings(pitch=45, roll=24))), (12, REST)]


def clip_jump():
    tuck = dict(**legs(thigh=-80, shin=140, foot=-60))
    return [
        (0, REST),
        (3, P(body=bn(rot=(-8, 0, 0)), neck=bn(rot=(-10, 0, 0)), **wings(roll=75), **legs(thigh=-50, shin=95, foot=-45))),
        (6, P(body=bn(rot=(-4, 0, 0)), **wings(roll=-5), **tuck)),
        (10, P(body=bn(rot=(-4, 0, 0)), **wings(roll=65), **tuck)),
        (14, P(body=bn(rot=(-2, 0, 0)), **wings(roll=0), **tuck)),
        (18, P(body=bn(rot=(0, 0, 0)), comb=bn(rot=(-8, 0, 0)), **wings(roll=60), **tuck)),
        (24, P(body=bn(rot=(4, 0, 0)), comb=bn(rot=(6, 0, 0)), **wings(roll=25), **legs(thigh=-40, shin=70, foot=-25))),
        (30, P(body=bn(rot=(2, 0, 0)), **wings(roll=40), **legs(thigh=-15, shin=25, foot=-5))),
        (33, P(neck=bn(rot=(6, 0, 0)), **wings(roll=45), **legs(thigh=0, shin=0, foot=10))),
        (36, P(**wings(roll=20))),
    ]


def clip_fall():
    dangle = dict(**legs(thigh=12, shin=-15, foot=15))
    up = P(body=bn(rot=(-5, 0, 0)), comb=bn(rot=(-6, 0, 0)), **wings(roll=65), **dangle)
    down = P(body=bn(rot=(-3, 0, 0)), comb=bn(rot=(6, 0, 0)), **wings(roll=-5), **dangle)
    return [(0, up), (5, down), (10, up), (15, down), (20, up)]


def clip_land():
    return [
        (0, P(**wings(roll=30), **legs(thigh=5, shin=-5, foot=10))),
        (1, G(body=bn(rot=(8, 0, 0), loc=(0, -0.12, 0)), neck=bn(rot=(8, 0, 0)), comb=bn(rot=(12, 0, 0)), **wings(roll=40))),
        (2, G(body=bn(rot=(6, 0, 0), loc=(0, -0.10, 0)), neck=bn(rot=(5, 0, 0)), comb=bn(rot=(-6, 0, 0)), **wings(roll=25))),
        (4, REST),
    ]


def block_pose(recoil=0.0):
    return ground(P(body=bn(rot=(8 - recoil, 0, 0), loc=(0, -0.08, -0.03 * recoil / 10.0)), neck=bn(rot=(18, 0, 0)),
                    head=bn(loc=(0, -0.02, -0.08), rot=(-12, 0, 0)), tail=bn(rot=(10, 0, 0)),
                    **wings(pitch=-15, yaw=-70, roll=20, loc=(-0.10, 0.02, 0.38))))


def clip_block():
    return [(0, REST), (3, P(block_pose(), **wings(pitch=-10, yaw=-50, roll=25, loc=(-0.06, 0.02, 0.28)))), (6, block_pose())]


def clip_block_hit():
    return [(0, block_pose()), (2, block_pose(recoil=10)), (5, block_pose(recoil=3)), (8, block_pose())]


def clip_hit_light():
    return [
        (0, REST),
        (3, G(body=bn(rot=(-8, 0, 0), loc=(0, 0, -0.03)), neck=bn(rot=(-10, 0, 0)), head=bn(rot=(-20, 0, 0)),
              comb=bn(rot=(-12, 0, 0)), **wings(roll=18))),
        (7, G(body=bn(rot=(-3, 0, 0)), neck=bn(rot=(-3, 0, 0)), head=bn(rot=(-6, 0, 0)), comb=bn(rot=(8, 0, 0)), **wings(roll=6))),
        (14, REST),
    ]


def clip_hit_heavy():
    return [
        (0, REST),
        (4, ground(P(body=bn(rot=(-25, 0, 0), loc=(0, 0.02, -0.08)), neck=bn(rot=(-35, 0, 0)), head=bn(rot=(-15, 0, 0)),
                     jaw=bn(rot=(-25, 0, 0)), comb=bn(rot=(-15, 0, 15)), wattle=bn(rot=(-15, 0, 0)), tail=bn(rot=(20, 0, 0)),
                     wing_L=bn(rot=(-20, 0, 70)), wing_R=bn(rot=(10, 0, -35))), left=(-0.06, 0), right=(-0.02, 0))),
        (8, ground(P(body=bn(rot=(-20, 0, 0), loc=(0, 0, -0.08)), neck=bn(rot=(-20, 0, 0)), head=bn(rot=(-8, 0, 0)),
                     jaw=bn(rot=(-10, 0, 0)), comb=bn(rot=(10, 0, -15)), wattle=bn(rot=(15, 0, 0)),
                     wing_L=bn(rot=(15, 0, 25)), wing_R=bn(rot=(-20, 0, -65))), left=(-0.06, 0), right=(-0.02, 0))),
        (14, ground(P(body=bn(rot=(-9, 0, 0), loc=(0, 0, -0.04)), neck=bn(rot=(-6, 0, 0)), comb=bn(rot=(-6, 0, 0)), **wings(roll=12)),
                    left=(-0.03, 0), right=(-0.01, 0))),
        (24, REST),
    ]


def lying(bounce=0.0, head_roll=0.0, jaw=0.0, legs_up=-70.0):
    return P(body=bn(rot=(-90, 0, 0), loc=(0, -0.11 + bounce, -0.05)), neck=bn(rot=(-15, 0, 0)), head=bn(rot=(-10, 0, head_roll)),
             jaw=bn(rot=(jaw, 0, 0)), tail=bn(rot=(70, 0, 0)), **wings(roll=80, pitch=10),
             **legs(thigh=legs_up, shin=40, foot=20, spread=10))


def clip_knockdown():
    return [
        (0, REST),
        (4, P(body=bn(rot=(-40, 0, 0), loc=(0, 0.06, -0.10)), neck=bn(rot=(-30, 0, 0)), head=bn(rot=(-15, 0, 0)), jaw=bn(rot=(-20, 0, 0)),
              **wings(roll=70), **legs(thigh=-50, shin=30, foot=10))),
        (10, P(body=bn(rot=(-82, 0, 0), loc=(0, 0.0, -0.08)), neck=bn(rot=(-20, 0, 0)), **wings(roll=85), **legs(thigh=-65, shin=35, foot=15))),
        (14, lying()),
        (18, lying(bounce=0.05, legs_up=-80)),
        (22, lying()),
        (40, lying(head_roll=8)),
    ]


def clip_getup():
    return [
        (0, lying(head_roll=8)),
        (6, P(body=bn(rot=(-50, 0, 0), loc=(0, -0.04, -0.04)), neck=bn(rot=(10, 0, 0)), **wings(roll=60, pitch=20),
              **legs(thigh=20, shin=-10, foot=-20))),
        (12, ground(P(body=bn(rot=(12, 0, 0), loc=(0, -0.12, 0)), neck=bn(rot=(8, 0, 0)), comb=bn(rot=(10, 0, 0)), **wings(roll=35)))),
        (16, ground(P(body=bn(rot=(-4, 0, 0), loc=(0, 0.0, 0)), neck=bn(rot=(-6, 0, 0)), comb=bn(rot=(-8, 0, 0)), **wings(roll=25)))),
        (20, REST),
    ]


def clip_ko():
    limp = lying(head_roll=28, jaw=-30, legs_up=-55)
    return [
        (0, REST),
        (6, P(body=bn(rot=(-48, 0, 0), loc=(0, 0.08, -0.15)), neck=bn(rot=(-35, 0, 0)), head=bn(rot=(-20, 0, 0)), jaw=bn(rot=(-30, 0, 0)),
              wing_L=bn(rot=(0, 0, 90)), wing_R=bn(rot=(0, 0, -60)), **legs(thigh=-50, shin=30))),
        (14, lying(jaw=-20)),
        (20, lying(bounce=0.08, jaw=-25, legs_up=-85)),
        (26, lying(jaw=-25)),
        (34, limp),
        (40, P(limp, **legs(thigh=-58, shin=45, foot=25, spread=12))),
        (60, limp),
    ]


def clip_win():
    crow = dict(body=bn(rot=(-10, 0, 0)), neck=bn(rot=(-30, 0, 0)), head=bn(rot=(-22, 0, 0)), jaw=bn(rot=(-30, 0, 0)),
                comb=bn(rot=(-10, 0, 0)), tail=bn(rot=(-15, 0, 0)))
    return [
        (0, REST),
        (10, G(**crow, **wings(roll=65))),
        (20, G(**{**crow, "jaw": bn(rot=(-12, 0, 0))}, **wings(roll=5))),
        (30, G(**crow, **wings(roll=75))),
        (40, G(body=bn(rot=(-4, 0, 0)), neck=bn(rot=(-12, 0, 0)), comb=bn(rot=(8, 0, 0)), **wings(roll=10))),
        (50, G(neck=bn(rot=(-4, 0, 0)), **wings(roll=30))),
        (60, REST),
    ]


def clip_entrance():
    wrapped = G(body=bn(rot=(28, 0, 0), loc=(0, -0.14, 0)), neck=bn(rot=(35, 0, 0)), head=bn(loc=(0, -0.02, -0.06), rot=(10, 0, 0)),
                tail=bn(rot=(20, 0, 0)), **wings(pitch=-20, yaw=-60, roll=10, loc=(-0.08, 0, 0.30)))
    crow = dict(body=bn(rot=(-12, 0, 0)), neck=bn(rot=(-40, 0, 0)), head=bn(rot=(-25, 0, 0)), jaw=bn(rot=(-35, 0, 0)),
                comb=bn(rot=(-10, 0, 0)), tail=bn(rot=(-20, 0, 0)))
    return [
        (0, wrapped),
        (12, P(wrapped, body=bn(rot=(26, 0, 1), loc=(0, -0.145, 0)))),
        (20, G(body=bn(rot=(-15, 0, 0), loc=(0, 0.02, 0)), neck=bn(rot=(-30, 0, 0)), head=bn(rot=(-10, 0, 0)), comb=bn(rot=(-15, 0, 0)),
               **wings(roll=110))),
        (30, G(body=bn(rot=(-6, 0, 0)), neck=bn(rot=(-10, 0, 0)), **wings(roll=0))),
        (38, G(body=bn(rot=(-8, 0, 0)), neck=bn(rot=(-14, 0, 0)), **wings(roll=90))),
        (46, G(body=bn(rot=(-4, 0, 0)), **wings(roll=5))),
        (60, G(**crow, **wings(roll=70))),
        (70, G(**{**crow, "jaw": bn(rot=(-5, 0, 0))}, **wings(roll=30))),
        (80, G(body=bn(rot=(-2, 0, 0)), **wings(roll=8))),
        (90, REST),
    ]


CLIP_KEYS = {
    "idle": clip_idle,
    "walk_fwd": lambda: _walk(32, 1.0, 6.0),
    "walk_back": lambda: _walk(36, -1.0, -4.0),
    "dash": clip_dash,
    "jump": clip_jump,
    "fall": clip_fall,
    "land": clip_land,
    "block": clip_block,
    "block_hit": clip_block_hit,
    "peck": clip_peck,
    "dive_kick": clip_dive_kick,
    "slam": clip_slam,
    "shove": clip_shove,
    "super": clip_super,
    "hit_light": clip_hit_light,
    "hit_heavy": clip_hit_heavy,
    "knockdown": clip_knockdown,
    "getup": clip_getup,
    "ko": clip_ko,
    "win": clip_win,
    "entrance": clip_entrance,
}


# --------------------------------------------------------------------------- scene


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.render.fps, scn.render.fps_base = 60, 1.0
    scn.frame_start, scn.frame_end = 0, 90
    return scn


def build_materials(contract):
    mats = {}
    for name in contract["materials"]:
        spec = MATERIALS[name]
        mat = bpy.data.materials.new(name)
        mat.use_backface_culling = True  # exports doubleSided: false
        mat.diffuse_color = (*spec["color"], 1.0)  # viewport / Workbench color
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*spec["color"], 1.0)
        bsdf.inputs["Metallic"].default_value = spec["metallic"]
        bsdf.inputs["Roughness"].default_value = spec["roughness"]
        if spec.get("emission"):
            bsdf.inputs["Emission Color"].default_value = (*spec["color"], 1.0)
            bsdf.inputs["Emission Strength"].default_value = spec["emission"]
        mats[name] = mat
    return mats


def build_rig(scn):
    arm = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", arm)
    scn.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, pivot in BONES:
        eb = arm.edit_bones.new(name)
        eb.head = to_blender(pivot)
        eb.tail = eb.head + Vector((0.0, 0.0, BONE_LENGTH))
        eb.roll = 0.0
        eb.use_connect = False
        eb.use_deform = True
        if parent:
            eb.parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
    return rig


def _box(spec):
    """One beveled box in model space; returns (verts, faces)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = spec["size"]
    for v in bm.verts:
        t = 1.0 - (1.0 - spec["taper"]) * (v.co.z + 0.5)
        v.co = Vector((v.co.x * sx * t, v.co.y * sy * t, v.co.z * sz))
    offset = min(0.018, 0.2 * min(spec["size"]))
    bmesh.ops.bevel(bm, geom=bm.verts[:] + bm.edges[:], offset=offset, segments=1, affect="EDGES", clamp_overlap=True)
    rot = Euler(tuple(math.radians(a) for a in spec["rot"]), "XYZ").to_matrix()
    center = Vector(spec["center"])
    bm.verts.index_update()
    verts = [tuple(to_blender(rot @ v.co + center)) for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return verts, faces


def build_mesh(scn, rig, mats, contract):
    verts, faces, face_mat, groups = [], [], [], {n: [] for n in BONE_NAMES}
    slot = {name: i for i, name in enumerate(contract["materials"])}
    for spec in PARTS:
        v, f = _box(spec)
        base = len(verts)
        verts.extend(v)
        faces.extend([i + base for i in face] for face in f)
        face_mat.extend([slot[spec["mat"]]] * len(f))
        groups[spec["bone"]].extend(range(base, base + len(v)))
    me = bpy.data.meshes.new("Chicken")
    me.from_pydata(verts, [], faces)
    me.polygons.foreach_set("material_index", face_mat)
    me.shade_flat()
    for name in contract["materials"]:
        me.materials.append(mats[name])
    me.validate()
    me.update()
    obj = bpy.data.objects.new("Chicken", me)
    scn.collection.objects.link(obj)
    obj.parent = rig
    obj.modifiers.new("Armature", "ARMATURE").object = rig
    for name in BONE_NAMES:
        if groups[name]:
            obj.vertex_groups.new(name=name).add(groups[name], 1.0, "REPLACE")
    return obj, sum(len(f) - 2 for f in faces)


def build_helpers(scn, rig, contract):
    helpers = {}
    for name, spec in contract["helpers"].items():
        e = bpy.data.objects.new(name, None)
        scn.collection.objects.link(e)
        e.empty_display_type = "SPHERE"
        e.empty_display_size = spec["radius"]  # visual only: glTF does not export it
        e.parent, e.parent_type, e.parent_bone = rig, "BONE", spec["bone"]
        bone = rig.data.bones[spec["bone"]]
        bone_tail = rig.matrix_world @ bone.matrix_local @ Matrix.Translation((0.0, bone.length, 0.0))
        e.matrix_parent_inverse = Matrix.Identity(4)
        e.matrix_basis = bone_tail.inverted() @ Matrix.Translation(to_blender(HELPER_POS[name]))
        e["cf_shape"] = spec["shape"]
        e["cf_radius"] = float(spec["radius"])
        if spec["shape"] == "capsule":
            e["cf_half_height"] = float(spec["halfHeight"])
        helpers[name] = e
    return helpers


def _channel(pose, bone, prop):
    p = pose.get(bone, {})
    if prop == "location":
        return p.get("loc", (0.0, 0.0, 0.0))
    if prop == "rotation_euler":
        return tuple(math.radians(a) for a in p.get("rot", (0.0, 0.0, 0.0)))
    return p.get("scl", (1.0, 1.0, 1.0))


def build_actions(rig, contract):
    """One action per contract clip, keyed through the Blender 5.x channelbag API, each on its own NLA track."""
    rig.animation_data_create()
    actions = {}
    for clip in contract["clips"]:
        name, frames = clip["name"], clip["frames"]
        keys = CLIP_KEYS[name]()
        if keys[0][0] != 0 or keys[-1][0] != frames or [f for f, _ in keys] != sorted({f for f, _ in keys}):
            raise cf.ExportError(f"placeholder clip '{name}': keys must run 0..{frames} in order")
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        slot = act.slots.new(id_type="OBJECT", name="Rig")
        bag = act.layers.new("Layer").strips.new(type="KEYFRAME").channelbag(slot, ensure=True)
        for bone in BONE_NAMES:  # every bone, every channel: crossfades never leave a bone stuck
            for prop in ("location", "rotation_euler", "scale"):
                values = [(f, _channel(pose, bone, prop)) for f, pose in keys]
                for i in range(3):
                    fc = bag.fcurves.new(f'pose.bones["{bone}"].{prop}', index=i, group_name=bone)
                    fc.keyframe_points.add(len(values))
                    fc.keyframe_points.foreach_set("co", [c for f, v in values for c in (float(f), float(v[i]))])
                    fc.update()
        act.use_frame_range = True
        act.frame_start, act.frame_end = 0, frames
        act.use_cyclic = clip["loop"]
        if "phases" in clip:
            act["cf_phases"] = list(clip["phases"])
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 0, act)
        if strip.action_slot is None:
            strip.action_slot = slot
        actions[name] = (act, slot)
    rig.animation_data.action = None
    return actions


# --------------------------------------------------------------------------- checks and preview


def show(rig, actions, clip, frame):
    """Evaluate one clip at one frame (NLA off so only this action applies)."""
    act, slot = actions[clip]
    ad = rig.animation_data
    ad.use_nla = False
    ad.action = act
    ad.action_slot = slot
    bpy.context.scene.frame_set(frame)


def helper_zy(helpers, name):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    p = to_model(helpers[name].evaluated_get(depsgraph).matrix_world.translation)
    return p.z, p.y


def check_hitboxes(rig, actions, helpers, contract):
    """Blender-evaluated hit_beak must hit the design targets (active) and stay back otherwise."""
    problems = []
    for clip in contract["clips"]:
        if clip["name"] not in ACTIVE_TARGETS:
            continue
        (z0, z1), (y0, y1) = ACTIVE_TARGETS[clip["name"]]
        s, a, _ = clip["phases"]
        row = []
        for f in range(clip["frames"] + 1):
            show(rig, actions, clip["name"], f)
            z, y = helper_zy(helpers, "hit_beak")
            active = s < f <= s + a
            row.append(f"{f}:{z:.3f},{y:.3f}{'*' if active else ''}")
            if active and not (z0 <= z <= z1 and y0 <= y <= y1):
                problems.append(f"{clip['name']} sample {f} (active): beak at z={z:.3f} y={y:.3f}, want z {z0}..{z1} y {y0}..{y1}")
            if not active and z > RETRACTED_Z:
                problems.append(f"{clip['name']} sample {f} (not active): beak z={z:.3f} > {RETRACTED_Z}")
        print(f"CF_BEAK {clip['name']} " + " ".join(row), flush=True)
    show(rig, actions, "idle", 0)
    hz, hy = helper_zy(helpers, "hurt_body")
    if abs(hz) > 1e-4 or abs(hy - HELPER_POS["hurt_body"][1]) > 1e-4:
        problems.append(f"hurt_body rest center is ({hz:.4f}, {hy:.4f}), want (0, {HELPER_POS['hurt_body'][1]})")
    rig.animation_data.action = None
    rig.animation_data.use_nla = True
    if problems:
        raise cf.ExportError("placeholder hitbox design check failed:\n  " + "\n  ".join(problems))


PREVIEW_PANELS = [
    ("idle", 0, "idle"),
    ("peck", 5, "peck 5 (active)"),
    ("shove", 9, "shove 9 (active)"),
    ("slam", 15, "slam 15 (active)"),
    ("super", 11, "super 11 (active)"),
    ("dive_kick", 10, "dive_kick 10 (active)"),
    ("block", 6, "block"),
    ("knockdown", 40, "knockdown"),
]


def _ring(name, radius, half, thickness, color, parent, depth):
    """A flat capsule/circle outline in the helper's sagittal plane, pushed toward the camera."""
    bm = bmesh.new()
    n = 24
    outline = []
    for i in range(n + 1):  # top arc
        a = math.pi * i / n
        outline.append((radius * math.cos(a), half + radius * math.sin(a)))
    for i in range(n + 1):  # bottom arc
        a = math.pi + math.pi * i / n
        outline.append((radius * math.cos(a), -half + radius * math.sin(a)))
    verts = []
    for u, v in outline:
        d = math.hypot(u, v - (half if v > 0 else -half)) or 1.0
        ku = u / d * thickness
        kv = (v - (half if v > 0 else -half)) / d * thickness
        verts.append((bm.verts.new((depth, -u, v)), bm.verts.new((depth, -(u - ku), v - kv))))
    for i in range(len(verts)):
        a, b = verts[i], verts[(i + 1) % len(verts)]
        bm.faces.new((a[0], b[0], b[1], a[1]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    return obj


def render_contact_sheet(path, rig, actions, helpers, contract):
    """Workbench side view (the sim plane) of key poses, hitboxes outlined, stitched into one PNG."""
    import numpy as np

    scn = bpy.context.scene
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "STUDIO"
    scn.display.shading.color_type = "MATERIAL"
    scn.display.shading.show_object_outline = True
    scn.display.shading.show_cavity = True
    scn.display.render_aa = "8"
    scn.view_settings.view_transform = "Standard"
    scn.world = bpy.data.worlds.new("cf_preview")
    scn.world.color = (0.62, 0.64, 0.68)
    size = 320  # 4x2 panels at 320 px keep the PNG under 500 KB
    scn.render.resolution_x = scn.render.resolution_y = size
    scn.render.resolution_percentage = 100
    scn.render.image_settings.file_format = "PNG"
    scn.render.image_settings.color_mode = "RGB"

    cam = bpy.data.objects.new("cf_preview_cam", bpy.data.cameras.new("cf_preview_cam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.5
    scn.collection.objects.link(cam)
    cam.location = to_blender((-5.0, 0.72, 0.05))  # on the chicken's right, looking across: forward is screen-right
    cam.rotation_euler = (math.radians(90), 0.0, math.radians(-90))
    scn.camera = cam

    ground_mat = bpy.data.materials.new("cf_preview_ground")
    ground_mat.diffuse_color = (0.18, 0.18, 0.2, 1.0)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(to_blender((0.0, -0.03, 0.0))) @ Matrix.Diagonal((1.0, 3.0, 0.06, 1.0)))
    ground = bpy.data.meshes.new("cf_preview_ground")
    bm.to_mesh(ground)
    bm.free()
    ground.materials.append(ground_mat)
    scn.collection.objects.link(bpy.data.objects.new("cf_preview_ground", ground))

    hurt, beak = contract["helpers"]["hurt_body"], contract["helpers"]["hit_beak"]
    _ring("cf_preview_hurt", hurt["radius"], hurt["halfHeight"], 0.012, (0.1, 0.85, 0.25), helpers["hurt_body"], -0.7)
    _ring("cf_preview_hit", beak["radius"], 0.0, 0.012, (1.0, 0.08, 0.45), helpers["hit_beak"], -0.75)

    label = bpy.data.objects.new("cf_preview_label", bpy.data.curves.new("cf_preview_label", "FONT"))
    label.data.size = 0.14
    label_mat = bpy.data.materials.new("cf_preview_label")
    label_mat.diffuse_color = (0.05, 0.05, 0.06, 1.0)
    label.data.materials.append(label_mat)
    scn.collection.objects.link(label)
    label.location = to_blender((-1.0, -0.40, -1.12))
    label.rotation_euler = Matrix(((0, 0, -1), (-1, 0, 0), (0, 1, 0))).to_euler()

    cols = 4
    rows = (len(PREVIEW_PANELS) + cols - 1) // cols
    sheet = np.zeros((rows * size, cols * size, 4), dtype=np.float32)
    with tempfile.TemporaryDirectory() as tmp:
        for i, (clip, frame, text) in enumerate(PREVIEW_PANELS):
            show(rig, actions, clip, frame)
            label.data.body = text
            scn.render.filepath = os.path.join(tmp, f"{i}.png")
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(scn.render.filepath)
            px = np.empty(size * size * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            bpy.data.images.remove(img)
            r, c = rows - 1 - i // cols, i % cols  # image rows start at the bottom
            sheet[r * size : (r + 1) * size, c * size : (c + 1) * size] = px.reshape(size, size, 4)
    out = bpy.data.images.new("cf_contact_sheet", cols * size, rows * size, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    scn.render.image_settings.compression = 100  # 8-bit RGB, smallest PNG
    scn.render.image_settings.color_depth = "8"
    out.save_render(os.path.abspath(path), scene=scn)
    print(f"CF_PREVIEW {os.path.abspath(path)}", flush=True)


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(prog="build_placeholder_chicken.py")
    ap.add_argument("--out", help="glb to write (omit to skip the export)")
    ap.add_argument("--contract", default=cf.DEFAULT_CONTRACT)
    ap.add_argument("--blend", help="also save the built scene as a .blend")
    ap.add_argument("--preview", help="also render a contact sheet PNG")
    args = ap.parse_args(cf.script_args())
    cf.warn_if_unexpected_blender()
    contract = cf.load_contract(args.contract)

    scn = reset_scene()
    mats = build_materials(contract)
    rig = build_rig(scn)
    _mesh, tris = build_mesh(scn, rig, mats, contract)
    helpers = build_helpers(scn, rig, contract)
    actions = build_actions(rig, contract)
    print(f"CF_BUILD bones={len(BONES)} parts={len(PARTS)} tris={tris} clips={len(actions)}", flush=True)
    check_hitboxes(rig, actions, helpers, contract)

    if args.out:
        cf.export_chicken(args.out, contract)
    if args.blend:
        os.makedirs(os.path.dirname(os.path.abspath(args.blend)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend), copy=True)
    if args.preview:
        render_contact_sheet(args.preview, rig, actions, helpers, contract)


cf.run_main(main)
