// A manifest shaped like the pipeline's (the enum tables of docs/edges-parquet.md, a subset of the
// attributes), for the style tests.
import { type Manifest, parseManifest } from "../src/map/manifest";

const ENUMS: Record<string, string> = {
  highway:
    "other trunk trunk_link primary primary_link secondary secondary_link tertiary tertiary_link unclassified residential living_street service road track path cycleway footway bridleway steps pedestrian ferry",
  surface_class: "unknown paved_smooth paved_rough compacted gravel soft other",
  tracktype: "unknown grade1 grade2 grade3 grade4 grade5",
  bike_access:
    "implicit yes designated permissive destination use_sidepath dismount foot_only agri_forestry private no",
  cycleway_kind: "none shared_lane lane track separate_path bicycle_road",
  route_level: "none lcn rcn ncn icn",
};

/** The code of an enum label, as the pipeline numbers it. */
export const code = (key: string, label: string) => (ENUMS[key] ?? "").split(" ").indexOf(label);

const enumAttribute = (key: string, label: string) => ({
  key,
  label,
  kind: "enum",
  values: (ENUMS[key] ?? "").split(" ").map((l, value) => ({ value, label: l })),
});

export function pipelineManifest(extra: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    schemaVersion: 1,
    builtAt: "2000-01-01T00:00:00Z",
    bounds: [-1, -1, 1, 1],
    center: [0, 0],
    basemap: { file: "basemap.pmtiles", maxzoom: 15 },
    overlay: {
      file: "overlay.pmtiles",
      layer: "edges",
      minzoom: 8,
      maxzoom: 14,
      drawing: ["bridge", "tunnel", "layer", "service_kind"],
      attributes: [
        enumAttribute("highway", "Road class"),
        enumAttribute("surface_class", "Surface"),
        enumAttribute("tracktype", "Track type"),
        enumAttribute("bike_access", "Bicycle access"),
        enumAttribute("cycleway_kind", "Cycle infrastructure"),
        enumAttribute("route_level", "Bicycle route"),
        { key: "forest_share", label: "In forest", kind: "share", min: 0, max: 100 },
        { key: "forest_edge_share", label: "Forest edge", kind: "share", min: 0, max: 100 },
        { key: "road_near_share", label: "Near a motor road", kind: "share", min: 0, max: 100 },
        { key: "road_near_traffic", label: "Traffic alongside", kind: "share", min: 0, max: 100 },
        { key: "grade_max", label: "Max grade", kind: "number", unit: "%", min: 0, max: 25 },
      ],
    },
    terrain: {
      file: "terrain.pmtiles",
      encoding: "terrarium",
      tileSize: 256,
      minzoom: 6,
      maxzoom: 12,
      contours: { file: "contours.pmtiles", layer: "contours", minzoom: 10, maxzoom: 14 },
    },
    ...extra,
  });
}
