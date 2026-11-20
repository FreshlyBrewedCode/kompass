// Builds the e2e fixture region: a tiny invented place (a grid of streets around 0°N 0°E, open sea in
// reality) as GeoJSON + tippecanoe → PMTiles, in the same shape the pipeline will produce
// (docs/map.md): manifest.json, overlay.pmtiles (layer `edges`, integer feature ids = edge ids) and a
// minimal basemap.pmtiles in the Protomaps schema (earth, water, roads, places).
//
//   nix develop -c bun e2e/fixtures/build-region.ts
//   nix develop -c uv run --project pipeline python e2e/fixtures/build-terrain.py   (the relief)
//
// Deterministic: the committed outputs only change when this script does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const here = import.meta.dirname;
const src = join(here, "src");
const out = join(here, "region");
mkdirSync(src, { recursive: true });
mkdirSync(out, { recursive: true });

const N = 6; // nodes per side → 2 * N * (N - 1) = 60 edges
const STEP = 0.0045; // degrees (~500 m)
const ORIGIN = -((N - 1) * STEP) / 2;
const node = (i: number, j: number): [number, number] => [ORIGIN + i * STEP, ORIGIN + j * STEP];

// The pipeline's enum tables (docs/edges-parquet.md): the label's position is its code.
const ENUMS = {
  highway:
    "other trunk trunk_link primary primary_link secondary secondary_link tertiary tertiary_link unclassified residential living_street service road track path cycleway footway bridleway steps pedestrian ferry",
  surface_class: "unknown paved_smooth paved_rough compacted gravel soft other",
  tracktype: "unknown grade1 grade2 grade3 grade4 grade5",
  bike_access:
    "implicit yes designated permissive destination use_sidepath dismount foot_only agri_forestry private no",
  cycleway_kind: "none shared_lane lane track separate_path bicycle_road",
  route_level: "none lcn rcn ncn icn",
} as const;
const labels = (key: keyof typeof ENUMS) => ENUMS[key].split(" ");
const code = (key: keyof typeof ENUMS, label: string) => labels(key).indexOf(label);
/** the road classes the grid cycles through: every line style of the map occurs */
const HIGHWAYS = "primary secondary tertiary residential service track track path cycleway footway".split(
  " ",
);

type Feature = {
  type: "Feature";
  id?: number;
  properties: Record<string, unknown>;
  geometry: { type: "LineString" | "Polygon"; coordinates: unknown };
};

const edges: Feature[] = [];
const roads: Feature[] = [];
let id = 1;
function edge(a: [number, number], b: [number, number], seed: number) {
  // a bent line: the middle vertex is nudged sideways, so the lines are not all straight
  const mid: [number, number] = [
    (a[0] + b[0]) / 2 + ((seed % 3) - 1) * 0.0004,
    (a[1] + b[1]) / 2 + (((seed >> 1) % 3) - 1) * 0.0004,
  ];
  const properties: Record<string, unknown> = {
    highway: code("highway", HIGHWAYS[seed % HIGHWAYS.length] as string),
    surface_class: (seed * 3 + (seed >> 2)) % labels("surface_class").length,
    tracktype: seed % labels("tracktype").length,
    bike_access: seed % 13 === 0 ? code("bike_access", "private") : 0,
    cycleway_kind: seed % 11 === 0 ? code("cycleway_kind", "separate_path") : 0,
    route_level: seed % 6 === 0 ? code("route_level", "rcn") : 0,
    forest_share: Math.round((((seed * 7) % 11) / 10) * 100),
    road_near_share: (seed * 37) % 101,
  };
  // every seventh edge has no grade: "no value" is information too
  if (seed % 7 !== 0) properties.grade_max = (seed * 5) % 26;
  edges.push({ type: "Feature", id, properties, geometry: { type: "LineString", coordinates: [a, mid, b] } });
  const kind = seed % 9 === 0 ? "major_road" : seed % 3 === 0 ? "medium_road" : "minor_road";
  roads.push({
    type: "Feature",
    properties: { kind, kind_detail: kind === "major_road" ? "primary" : "residential", "pmap:level": 0 },
    geometry: { type: "LineString", coordinates: [a, b] },
  });
  id++;
}
for (let j = 0; j < N; j++) for (let i = 0; i < N - 1; i++) edge(node(i, j), node(i + 1, j), id);
for (let i = 0; i < N; i++) for (let j = 0; j < N - 1; j++) edge(node(i, j), node(i, j + 1), id);

// the manifest's bounds hug the grid; the invented earth reaches further, so the map has no edge in view
const w = ORIGIN - STEP * 2;
const e = -ORIGIN + STEP * 2;
const sea = 0.08;
const square = (x0: number, y0: number, x1: number, y1: number) => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ],
];
const poly = (properties: Record<string, unknown>, ring: unknown): Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "Polygon", coordinates: ring },
});
const earth = poly({ kind: "earth" }, square(-sea, -sea, sea, sea));
const lake = poly(
  { kind: "lake", "pmap:level": 0 },
  square(ORIGIN + STEP * 1.2, ORIGIN + STEP * 3.1, ORIGIN + STEP * 2.3, ORIGIN + STEP * 3.8),
);
const forest = poly(
  { kind: "forest" },
  square(ORIGIN - STEP * 1.5, ORIGIN + STEP * 1.2, ORIGIN + STEP * 0.8, ORIGIN + STEP * 4.4),
);
const town = poly(
  { kind: "residential" },
  square(ORIGIN + STEP * 2.6, ORIGIN + STEP * 2.2, ORIGIN + STEP * 5.4, ORIGIN + STEP * 4.9),
);
const park = poly(
  { kind: "park" },
  square(ORIGIN + STEP * 3.2, ORIGIN + STEP * 0.2, ORIGIN + STEP * 4.8, ORIGIN + STEP * 1.8),
);
const place: Feature = {
  type: "Feature",
  properties: { kind: "locality", kind_detail: "city", name: "Fixtown", population_rank: 9, min_zoom: 8 },
  geometry: { type: "Point" as never, coordinates: [0, 0.4 * STEP] },
};

const collection = (features: Feature[]) => JSON.stringify({ type: "FeatureCollection", features });
const write = (name: string, features: Feature[]) => {
  writeFileSync(join(src, name), collection(features));
  return join(src, name);
};
const edgesFile = write("edges.geojson", edges);
const earthFile = write("earth.geojson", [earth]);
const waterFile = write("water.geojson", [lake]);
const landuseFile = write("landuse.geojson", [forest, town, park]);
const roadsFile = write("roads.geojson", roads);
const placesFile = write("places.geojson", [place]);

const common = ["-q", "-f", "--no-feature-limit", "--no-tile-size-limit"];
await $`tippecanoe ${common} -o ${join(out, "overlay.pmtiles")} -l edges -Z8 -z14 --no-simplification-of-shared-nodes ${edgesFile}`;
await $`tippecanoe ${common} -o ${join(out, "basemap.pmtiles")} -Z0 -z14 -A ${"Synthetic fixture"} -L earth:${earthFile} -L water:${waterFile} -L landuse:${landuseFile} -L roads:${roadsFile} -L places:${placesFile}`;

const enumAttribute = (key: keyof typeof ENUMS, label: string) => ({
  key,
  label,
  kind: "enum",
  values: labels(key).map((l, value) => ({ value, label: l })),
});
// the terrain (terrain.pmtiles, contours.pmtiles) is built by build-terrain.py
const manifest = {
  schemaVersion: 1,
  builtAt: "2000-01-01T00:00:00Z",
  bounds: [w, w, e, e],
  center: [0, 0],
  basemap: { file: "basemap.pmtiles", maxzoom: 14 },
  overlay: {
    file: "overlay.pmtiles",
    layer: "edges",
    minzoom: 8,
    maxzoom: 14,
    attributes: [
      enumAttribute("highway", "Road class"),
      enumAttribute("surface_class", "Surface"),
      enumAttribute("tracktype", "Track type"),
      enumAttribute("bike_access", "Bicycle access"),
      enumAttribute("cycleway_kind", "Cycle infrastructure"),
      enumAttribute("route_level", "Bicycle route"),
      { key: "forest_share", label: "In forest", kind: "share", min: 0, max: 100 },
      { key: "road_near_share", label: "Near a motor road", kind: "share", min: 0, max: 100 },
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
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`fixture region: ${edges.length} edges → ${resolve(out)}`);
