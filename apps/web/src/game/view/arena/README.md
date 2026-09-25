# Arena (`view/arena/`)

The fight scene's set. `createJunkyard(renderer)` builds the procedural junkyard pit (0 bytes of
assets) and returns an `ArenaView` (`../FightView.ts`): `root`, `envScene`, `setHype(h)`,
`update(dt, t)`, `setQuality(tier)`, `dispose()`. `FightView.setArena()` mounts it; the director
drives `setHype` (0.2 idle .. 1 on a KO). `/play?arena=0` skips the arena (placeholder floor only).

| File | What |
|---|---|
| `Junkyard.ts` | Assembles everything; `update()` writes uniforms + 2 light intensities only (no allocations). |
| `layout.ts` | Dimensions (ring edge, lip, drop-off, bleachers) and the **anchors**; `anchorsFromScene()` for a glb. |
| `lighting.ts` | Shared uniforms, the fire flicker, the static light bake (`bakeStatic`) and the GLSL light rig. |
| `builder.ts` | `GeoBuilder`: stamps transformed primitives into one geometry, baking attributes per vertex. |
| `floor.ts` | Pit floor, hazard band, striped lip at x = ±10, the drop-off beyond it. Per-pixel shader. |
| `props.ts` | Car walls, tire stacks, oil drums, bleachers, flood towers, string lights, junk: one mesh. |
| `crowd.ts` | ~240 robot chickens: Canvas2D atlas + one instanced draw, plus an additive camera-flash pass. |
| `fires.ts` | Flames, halos and embers (one instanced additive draw, looped in the shader) + 2 PointLights. |
| `beams.ts` | Floodlight shafts, lamp flares, bulbs, beacons and haze (one additive draw). |
| `sky.ts` | Smog gradient, junk-heap skyline, cranes with blinking lights (one draw, far plane). |
| `env.ts` | The small stand-in scene FightView renders into the PMREM env map (chrome/gold/diamond). |

**Budget:** 7 draw calls (sky, floor, props, crowd, crowd flashes, fire, beams) and ~17k rendered
triangles, against the arena's 60k. `arena.test.ts` checks the triangle budget and the ring-edge
contract; `e2e/arena.spec.ts` checks the whole fight frame (≤ 40 draws, ≤ 150k triangles).

**Quality 'low'** ("no particles, half-res") also drops the arena's own particles, with no
rebuild and no shader recompile: the fire smoke and embers (the flames and halos stay: an
instance-count prefix), the crowd's camera-flash pass (6 draw calls instead of 7) and the haze
sheet (a draw range). `e2e/arena.spec.ts` logs the arena's draws and triangles per tier.

## How it is lit

- **Baked** (vertex attributes, computed once at build): albedo × AO (`color`), and ambient +
  floodlight + string-light irradiance (`aLight`). No lightmap texture, no shadow maps.
- **Per pixel, animated:** the two fire clusters (`fireLight()` in `lighting.ts`) with the same
  flicker value that drives the fighters' two `PointLight`s, the flames and the hot drum rims.
- The fighters keep FightView's own lights, plus the two fire `PointLight`s from the arena root.
- All arena shaders include three's tone mapping, colour space and fog chunks, so they sit in the
  same ACES / sRGB / fog pipeline as the built-in materials. Additive fx output display colours.

## Swapping in Sammy's `arena.glb`

The game only depends on **anchors**, not on the procedural geometry. A glb replaces the
geometry and supplies the anchors as named empties:

| Empty | Meaning |
|---|---|
| `ringedge_L`, `ringedge_R` | The ring edges. **Must sit at x = −10 / +10** (the sim decides ring-outs at `ringEdge` = 10000 mu); `checkRingEdges()` rejects a glb that disagrees. Beyond them the floor must drop away (fighters fall to y = −20). |
| `fire_L*`, `fire_R*` | One per oil drum (base centre). Each side is one cluster: its `PointLight` and the surface fire light sit 2.1 above the drums' mean. Flames and embers spawn on top of each drum (0.95 up). |
| `crowd_<n>_a`, `crowd_<n>_b` | Endpoints of crowd row *n* (feet height). Custom property `count` (default 30). |
| `flood_<n>` + child `flood_<n>_target` | A floodlight bank and where its beam lands. |

Steps for the swap (not built yet; nothing in Phase 1 loads a glb arena):

1. Load `arena.glb` (Draco, lightmap in `TEXCOORD_1`, see `docs/art-pipeline.md` budgets: ≤ 60k
   triangles, lightmap ≤ 4k), then `const anchors = anchorsFromScene(gltf.scene)`.
2. Build `createUniforms(anchors)`, `buildCrowd(anchors.crowd, …)`, `buildFires(anchors.fires, …)`,
   `buildBeams(anchors.floods, [], …)`, `buildSky(…)` and `buildEnvScene(anchors)` exactly as
   `createJunkyard` does, and add `gltf.scene` instead of `buildFloor` / `buildProps`.
3. Give the glb's materials the lightmap (`MeshBasicMaterial` / `MeshLambertMaterial` with
   `lightMap`), or patch them with `LIGHT_GLSL` if they should also catch the fire flicker.
4. Return the same `ArenaView`; nothing outside `view/arena/` changes.
