"""Check art/blender/presets/cockfight_glb.py inside Blender (used by tools/test/heroImport.test.ts).

    Blender -b --factory-startup placeholder.blend --python-exit-code 1 --python check_preset.py -- --out preset.glb

Runs the preset against a stand-in for the export dialog's operator, so every
property it sets must exist on the glTF exporter with a valid value, and the
values must equal EXPORT_KWARGS. Then exports the open file with those values
the way an artist would (select Rig and its children, File > Export), so the
test can compare the bytes with the scripted export.
"""

import argparse
import os
import sys

import bpy

sys.dont_write_bytecode = True
ART = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "art", "blender"))
sys.path.insert(0, ART)
import cf_common as cf  # noqa: E402

PRESET = os.path.join(ART, "presets", "cockfight_glb.py")


class Recorder:
    """Stands in for bpy.context.active_operator: validates each assignment against the exporter's RNA."""

    def __init__(self, rna):
        object.__setattr__(self, "rna", rna)
        object.__setattr__(self, "values", {})

    def __setattr__(self, key, value):
        prop = self.rna.properties.get(key)
        if prop is None:
            raise cf.ExportError(f"the preset sets {key}, which the glTF exporter does not have")
        if prop.is_skip_preset:
            raise cf.ExportError(f"the preset sets {key}, which Blender never stores in presets")
        # Dynamic enums (export_format) list no items here; the export below rejects a bad value anyway.
        items = [i.identifier for i in prop.enum_items] if prop.type == "ENUM" else []
        if items and value not in items:
            raise cf.ExportError(f"the preset sets {key} = {value!r}, not one of {items}")
        if prop.type in ("INT", "FLOAT") and not (prop.hard_min <= value <= prop.hard_max):
            raise cf.ExportError(f"the preset sets {key} = {value!r}, outside {prop.hard_min}..{prop.hard_max}")
        if prop.type == "BOOLEAN" and not isinstance(value, bool):
            raise cf.ExportError(f"the preset sets {key} = {value!r}, not a bool")
        self.values[key] = value


def main():
    ap = argparse.ArgumentParser(prog="check_preset.py")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(cf.script_args())

    rec = Recorder(bpy.ops.export_scene.gltf.get_rna_type())
    with open(PRESET, encoding="utf-8") as f:
        src = f.read().replace("bpy.context.active_operator", "__operator__")
    exec(compile(src, PRESET, "exec"), {"bpy": bpy, "__operator__": rec, "__name__": "__preset__"})
    want = {k: v for k, v in cf.EXPORT_KWARGS.items() if k != "check_existing"}
    if rec.values != want:
        diff = sorted(set(rec.values.items()) ^ set(want.items()))
        raise cf.ExportError(f"the preset differs from EXPORT_KWARGS: {diff}")

    rig = bpy.data.objects["Rig"]
    for obj in bpy.context.view_layer.objects:
        obj.select_set(obj == rig or obj in rig.children_recursive)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.export_scene.gltf(filepath=os.path.abspath(args.out), check_existing=False, **rec.values)
    if result != {"FINISHED"}:
        raise cf.ExportError(f"export with the preset returned {result}")
    print(f"CF_PRESET_OK {len(rec.values)} settings", flush=True)


cf.run_main(main)
