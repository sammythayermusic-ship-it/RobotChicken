"""COCKFIGHT chicken: Blender glTF exporter preset (File > Export > glTF 2.0 > Operator Presets).

The same settings as EXPORT_KWARGS in art/blender/cf_common.py (a test keeps
the two in sync). Install by copying this file to
  macOS:   ~/Library/Application Support/Blender/5.2/scripts/presets/operator/export_scene.gltf/
  Windows: %APPDATA%\\Blender Foundation\\Blender\\5.2\\scripts\\presets\\operator\\export_scene.gltf\\
  Linux:   ~/.config/blender/5.2/scripts/presets/operator/export_scene.gltf/
then pick "cockfight_glb" from the dialog's preset menu. It exports the
selection: select Rig and everything parented to it first.

This is the manual fallback. `pnpm assets:import --blend <file>` exports with
the same settings and also fixes or explains the usual problems, validates the
glb and bakes the hitboxes.
"""

import bpy

op = bpy.context.active_operator

op.export_format = "GLB"
op.use_selection = True
op.export_yup = True
op.export_apply = True
op.export_texcoords = True
op.export_normals = True
op.export_tangents = False
op.export_materials = "EXPORT"
op.export_image_format = "NONE"
op.export_cameras = False
op.export_lights = False
op.export_morph = False
op.export_extras = True
op.export_skins = True
op.export_def_bones = True
op.export_influence_nb = 4
op.export_rest_position_armature = True
op.export_animations = True
op.export_animation_mode = "ACTIONS"
op.export_anim_single_armature = True
op.export_force_sampling = True
op.export_frame_step = 1
op.export_merge_animation = "NLA_TRACK"
op.export_optimize_animation_size = True
op.export_optimize_animation_keep_anim_armature = True
op.export_reset_pose_bones = True
op.export_anim_slide_to_zero = True
op.export_frame_range = False
op.export_bake_animation = False
op.export_draco_mesh_compression_enable = True
op.export_draco_mesh_compression_level = 6
op.export_draco_position_quantization = 14
op.export_draco_normal_quantization = 10
op.export_draco_texcoord_quantization = 12
op.export_draco_color_quantization = 8
op.export_draco_generic_quantization = 12
