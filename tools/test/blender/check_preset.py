"""Check art/blender/presets/cockfight_glb.py inside Blender (used by tools/test/heroImport.test.ts).

    Blender -b --factory-startup placeholder.blend --python-exit-code 1 --python check_preset.py -- --out preset.glb

- The committed preset is exactly what art/blender/make_preset.py generates for
  this Blender (so it is regenerated whenever EXPORT_KWARGS or the exporter changes).
- Run against a stand-in for the export dialog's operator, every property it
  sets exists on the glTF exporter with a valid value, and it sets every
  property a preset can store (all but the file path): applying it leaves
  nothing from an earlier export or a remembered setting in the dialog. The
  values are EXPORT_KWARGS plus the exporter's defaults.
- Then it exports the open file with those values the way an artist would
  (select Rig and its children, File > Export), so the test can compare the
  bytes with the scripted export.
"""

import argparse
import os
import sys

import bpy

sys.dont_write_bytecode = True
ART = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "art", "blender"))
sys.path.insert(0, ART)
import cf_common as cf  # noqa: E402


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
        if key in self.values:
            raise cf.ExportError(f"the preset sets {key} twice")
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

    with open(cf.PRESET_PATH, encoding="utf-8") as f:
        src = f.read()
    if src != cf.preset_source():
        raise cf.ExportError(
            "art/blender/presets/cockfight_glb.py is not what make_preset.py generates for this Blender: "
            "run pnpm --filter @cockfight/tools run blender art/blender/make_preset.py"
        )

    rna = bpy.ops.export_scene.gltf.get_rna_type()
    rec = Recorder(rna)
    exec(compile(src.replace("bpy.context.active_operator", "__operator__"), cf.PRESET_PATH, "exec"), {"bpy": bpy, "__operator__": rec, "__name__": "__preset__"})

    base = set(bpy.types.Operator.bl_rna.properties.keys())
    storable = {pid for pid, p in rna.properties.items() if pid not in base and not p.is_skip_preset}
    missing = sorted(storable - set(rec.values) - set(cf.PRESET_SKIP))
    if missing:
        raise cf.ExportError(f"the preset leaves {missing} unset, so the dialog would keep whatever they were last")
    for key, value in cf.EXPORT_KWARGS.items():
        if key != "check_existing" and rec.values.get(key) != value:
            raise cf.ExportError(f"the preset sets {key} = {rec.values.get(key)!r}, but EXPORT_KWARGS has {value!r}")
    if rec.values != cf.preset_values():
        diff = sorted(set(map(repr, rec.values.items())) ^ set(map(repr, cf.preset_values().items())))
        raise cf.ExportError(f"the preset differs from EXPORT_KWARGS + the exporter defaults: {diff}")

    rig = bpy.data.objects["Rig"]
    for obj in bpy.context.view_layer.objects:
        obj.select_set(obj == rig or obj in rig.children_recursive)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.export_scene.gltf(filepath=os.path.abspath(args.out), check_existing=False, **rec.values)
    if result != {"FINISHED"}:
        raise cf.ExportError(f"export with the preset returned {result}")
    print(f"CF_PRESET_OK {len(rec.values)} settings", flush=True)


cf.run_main(main)
