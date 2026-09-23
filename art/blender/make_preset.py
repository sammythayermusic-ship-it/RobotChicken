"""Write presets/cockfight_glb.py, the glTF exporter UI preset, from EXPORT_KWARGS.

    pnpm --filter @cockfight/tools run blender art/blender/make_preset.py

Run it after changing EXPORT_KWARGS in cf_common.py, or after moving to a new
Blender (the preset sets every exporter setting, so a new exporter property
needs a new line). tools/test/heroImport.test.ts (with Blender) fails while the
committed preset differs from what this writes.
"""

import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_common as cf  # noqa: E402


def main():
    cf.warn_if_unexpected_blender()
    with open(cf.PRESET_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(cf.preset_source())
    print(f"CF_PRESET {cf.PRESET_PATH}: {len(cf.preset_values())} settings", flush=True)


cf.run_main(main)
