"""Export the hero chicken from an artist's .blend to .glb.

    Blender -b --factory-startup art/chicken.blend --python-exit-code 1 \
        --python art/blender/export_chicken.py -- --out apps/web/public/models/chicken.glb [--retime]

Normally run through `pnpm assets:import --blend <file>` (tools/src/cli/import.ts),
which also validates the glb and bakes packages/sim/data/hitboxes.json.

The .blend is opened read-only in spirit: cf_common.prepare_scene() fixes UI
habits in memory (actions off the NLA, a file saved in Pose mode, clips that
start on frame 1, ...) and prints a CF_FIX line for each; problems that need an
artist's decision print one CF_ERROR line each and exit 1. The file itself is
never saved.

  --retime   the scene is not at 60 fps: scale every clip to 60 fps, keeping
             its real-time length, instead of failing
"""

import argparse
import os
import sys

import bpy

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_common as cf  # noqa: E402


def main():
    ap = argparse.ArgumentParser(prog="export_chicken.py")
    ap.add_argument("--out", required=True, help="glb to write")
    ap.add_argument("--retime", action="store_true", help="rescale a scene authored at another frame rate to 60 fps")
    ap.add_argument("--contract", default=cf.DEFAULT_CONTRACT)
    ap.add_argument("--moves", default=cf.DEFAULT_MOVES)
    args = ap.parse_args(cf.script_args())
    if not bpy.data.filepath:
        raise cf.ExportError("no .blend is open: put the file before --python on the Blender command line (pnpm assets:import --blend <file> does)")
    cf.warn_if_unexpected_blender()
    print(f"CF_SOURCE {bpy.data.filepath}", flush=True)
    cf.export_chicken(args.out, cf.load_contract(args.contract), cf.load_moves(args.moves), retime=args.retime)


cf.run_main(main)
