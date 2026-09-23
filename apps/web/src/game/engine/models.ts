import hitboxes from "@cockfight/sim/data/hitboxes.json" with { type: "json" };

/**
 * The chicken the game loads: whichever glb the committed hitboxes were baked
 * from (so visuals and hitboxes can't drift apart), with a content version
 * for cache busting. After `pnpm assets:import`, the hero replaces the
 * placeholder everywhere, the landing showcase included.
 */
export function chickenModelUrl(): string {
  const file = hitboxes.source.file || "apps/web/public/models/chicken_placeholder.glb";
  const path = file.replace(/^apps\/web\/public/, "");
  const v = hitboxes.source.sha256 ? `?v=${hitboxes.source.sha256.slice(0, 8)}` : "";
  return `${path}${v}`;
}
