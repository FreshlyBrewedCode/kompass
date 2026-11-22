// Builds the e2e fixture region: a tiny invented place (a grid of streets around 0°N 0°E, open sea in
// reality) in the shape of a real build (docs/map.md, docs/graph-format.md): manifest.json,
// overlay.pmtiles (layer `edges`, integer feature ids = edge ids), a minimal basemap.pmtiles in the
// Protomaps schema (earth, water, roads, places), edges.parquet (the pipeline contract, written by
// edges-parquet.py with the pipeline's own writer) and the engine's graph compiled from it (graph/).
// Edge ids are the row numbers of the Hilbert-sorted edges, as in a real build, so the overlay, the
// parquet and the graph agree on them.
//
//   nix develop -c bun e2e/fixtures/build-region.ts
//   nix develop -c uv run --project pipeline python e2e/fixtures/build-terrain.py   (the relief)
//
// Deterministic: the committed outputs only change when this script does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { LADDER } from "../../web/test/synthetic";

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

// The pipeline's sort key (finalize.hilbert_order): the Hilbert index of the web-mercator z16 tile of
// the edge midpoint (by planar length), ties by way id. edges-parquet.py checks the order.
function z16Tile([lon, lat]: [number, number]): [number, number] {
  const n = 2 ** 16;
  const r = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.min(Math.max(x, 0), n - 1), Math.min(Math.max(y, 0), n - 1)];
}
function hilbert([tx, ty]: [number, number]): number {
  let [x, y] = [tx, ty];
  const n = 2 ** 16;
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) [x, y] = [n - 1 - x, n - 1 - y];
      [x, y] = [y, x];
    }
  }
  return d;
}
function midpoint(line: [number, number][]): [number, number] {
  const len = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  let left = line.slice(1).reduce((sum, p, i) => sum + len(line[i] as [number, number], p), 0) / 2;
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i] as [number, number], line[i + 1] as [number, number]];
    const l = len(a, b);
    if (left <= l) {
      const t = l > 0 ? left / l : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= l;
  }
  return line[line.length - 1] as [number, number];
}

type Feature = {
  type: "Feature";
  id?: number;
  properties: Record<string, unknown>;
  geometry: { type: "LineString" | "Polygon"; coordinates: unknown };
};

// the grid's streets, in generation order (`way` is the OSM-like way id the pipeline would carry)
type Line = { way: number; coordinates: [number, number][]; attrs?: Record<string, unknown> };
const lines: Line[] = [];
function line(a: [number, number], b: [number, number]) {
  const k = lines.length + 1;
  // a bent line: the middle vertex is nudged sideways, so the lines are not all straight
  const mid: [number, number] = [
    (a[0] + b[0]) / 2 + ((k % 3) - 1) * 0.0004,
    (a[1] + b[1]) / 2 + (((k >> 1) % 3) - 1) * 0.0004,
  ];
  lines.push({ way: k, coordinates: [a, mid, b] });
}
for (let j = 0; j < N; j++) for (let i = 0; i < N - 1; i++) line(node(i, j), node(i + 1, j));
for (let i = 0; i < N; i++) for (let j = 0; j < N - 1; j++) line(node(i, j), node(i, j + 1));
const GRID_EDGES = lines.length;
// The ladder, north-east of the grid and not joined to it (docs/planner.md, "Limits as trade-offs"):
// S — X ~ Y — T along one street, X ~ Y a 40 m gravel track, and round it a 2 km paved loop. A
// paved-only profile rides the loop; its trade-off offers the track. Its edges sort after the grid's
// (the Hilbert keys there are higher), so the grid's edge ids stay what they were.
{
  const street = {
    highway: code("highway", "residential"),
    surface_class: code("surface_class", "paved_smooth"),
  };
  const track = { highway: code("highway", "track"), surface_class: code("surface_class", "gravel") };
  const { s: ls, x, y, t } = LADDER;
  const a: [number, number] = [x[0], 0.0198];
  const b: [number, number] = [0.0125, 0.0198];
  const c: [number, number] = [0.0125, 0.018];
  const d: [number, number] = [y[0], 0.018];
  const ladder: [[number, number][], Record<string, unknown>][] = [
    [[[...ls], [...x]], street],
    [[[...x], [...y]], track],
    [[[...y], [...t]], street],
    [[[...x], a], street],
    [[a, b], street],
    [[b, c], street],
    [[c, d], street],
    [[d, [...y]], street],
  ];
  for (const [coordinates, attrs] of ladder) lines.push({ way: lines.length + 1, coordinates, attrs });
}
// edge ids: the row numbers after the pipeline's sort
const keyed = lines.map((l) => ({ ...l, key: hilbert(z16Tile(midpoint(l.coordinates))) }));
keyed.sort((p, q) => p.key - q.key || p.way - q.way);
if (keyed.slice(0, GRID_EDGES).some((l) => l.attrs))
  throw new Error("a ladder edge sorts among the grid's: the grid's edge ids would change");

const edges: Feature[] = [];
const roads: Feature[] = [];
keyed.forEach(({ way, coordinates, attrs }, id) => {
  // the attributes follow from the id, so the e2e can name them (edge 1: a compacted secondary road, ...)
  const seed = id;
  const properties: Record<string, unknown> = {
    highway: code("highway", HIGHWAYS[seed % HIGHWAYS.length] as string),
    surface_class: (seed * 3 + (seed >> 2)) % labels("surface_class").length,
    tracktype: seed % labels("tracktype").length,
    bike_access: seed % 13 === 0 ? code("bike_access", "private") : 0,
    cycleway_kind: seed % 11 === 0 ? code("cycleway_kind", "separate_path") : 0,
    route_level: seed % 6 === 0 ? code("route_level", "rcn") : 0,
    forest_share: Math.round((((seed * 7) % 11) / 10) * 100),
    road_near_share: (seed * 37) % 101,
    // not in the overlay (tippecanoe -x), only in edges.parquet
    way_id: way,
    oneway_bike: seed % 17 === 3 ? 1 : seed % 19 === 10 ? -1 : 0,
  };
  // the overlay's drawing properties (pipeline schema.OVERLAY_DRAWING), written only when not 0; drawing
  // only: edges.parquet keeps the neutral values, so routes in the e2e do not change
  if (seed % 23 === 5) Object.assign(properties, { bridge: 1, layer: 1 });
  if (seed % 29 === 7) Object.assign(properties, { tunnel: 1, layer: -1 });
  if (seed % 10 === 4) properties.service_kind = 1 + (seed % 20 === 4 ? 0 : 1); // parking_aisle, driveway
  // every seventh edge has no grade: "no value" is information too
  if (seed % 7 !== 0) properties.grade_max = (seed * 5) % 26;
  if (attrs)
    Object.assign(properties, {
      tracktype: 0,
      bike_access: 0,
      cycleway_kind: 0,
      route_level: 0,
      forest_share: 0,
      road_near_share: 0,
      oneway_bike: 0,
      grade_max: 0,
      ...attrs,
    });
  if (attrs) for (const k of ["service_kind", "bridge", "tunnel", "layer"]) delete properties[k];
  edges.push({ type: "Feature", id, properties, geometry: { type: "LineString", coordinates } });
  const kind = seed % 9 === 0 ? "major_road" : seed % 3 === 0 ? "medium_road" : "minor_road";
  const [a, b] = [coordinates[0], coordinates[coordinates.length - 1]];
  roads.push({
    type: "Feature",
    properties: { kind, kind_detail: kind === "major_road" ? "primary" : "residential", "pmap:level": 0 },
    geometry: { type: "LineString", coordinates: [a, b] },
  });
});

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
await $`tippecanoe ${common} -o ${join(out, "overlay.pmtiles")} -l edges -Z8 -z14 -x way_id -x oneway_bike --no-simplification-of-shared-nodes ${edgesFile}`;
await $`tippecanoe ${common} -o ${join(out, "basemap.pmtiles")} -Z0 -z14 -A ${"Synthetic fixture"} -L earth:${earthFile} -L water:${waterFile} -L landuse:${landuseFile} -L roads:${roadsFile} -L places:${placesFile}`;

const BUILD_ID = "fixture";
const enumAttribute = (key: keyof typeof ENUMS, label: string) => ({
  key,
  label,
  kind: "enum",
  values: labels(key).map((l, value) => ({ value, label: l })),
});
const manifest = {
  schemaVersion: 1,
  buildId: BUILD_ID,
  builtAt: "2000-01-01T00:00:00Z",
  bounds: [w, w, e, e],
  center: [0, 0],
  basemap: { file: "basemap.pmtiles", maxzoom: 14 },
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
      { key: "road_near_share", label: "Near a motor road", kind: "share", min: 0, max: 100 },
      { key: "grade_max", label: "Max grade", kind: "number", unit: "%", min: 0, max: 25 },
    ],
  },
  // built by build-terrain.py
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

// edges.parquet with the pipeline's writer, then the graph (adds the manifest's `graph` key)
const root = resolve(here, "../..");
await $`uv run --project ${join(root, "pipeline")} python ${join(here, "edges-parquet.py")} ${edgesFile} ${join(out, "edges.parquet")} ${BUILD_ID}`;
await $`cargo run --quiet --release --manifest-path ${join(root, "engine/Cargo.toml")} -p kompass-cli -- compile --build ${out}`;
// the repo's JSON style (the compiler writes one value per line)
await $`bunx biome format --write ${join(out, "manifest.json")}`.quiet();
console.log(`fixture region: ${edges.length} edges → ${resolve(out)}`);
