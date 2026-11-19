// Builds the e2e fixture region: a tiny invented place (a grid of streets around 0°N 0°E, open sea in
// reality) as GeoJSON + tippecanoe → PMTiles, in the same shape the pipeline will produce
// (docs/map.md): manifest.json, overlay.pmtiles (layer `edges`, integer feature ids = edge ids) and a
// minimal basemap.pmtiles in the Protomaps schema (earth, water, roads, places).
//
//   nix develop -c bun e2e/fixtures/build-region.ts
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

const SURFACES = ["unknown", "paved smooth", "paved rough", "compacted", "gravel", "soft", "other"];
const HIGHWAYS = [
  "other",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "service",
  "track",
  "path",
  "cycleway",
];

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
    surface_class: (seed * 3 + (seed >> 2)) % SURFACES.length,
    highway: seed % HIGHWAYS.length,
    forest: Math.round((((seed * 7) % 11) / 10) * 100) / 100,
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
const landuseFile = write("landuse.geojson", [park]);
const roadsFile = write("roads.geojson", roads);
const placesFile = write("places.geojson", [place]);

const common = ["-q", "-f", "--no-feature-limit", "--no-tile-size-limit"];
await $`tippecanoe ${common} -o ${join(out, "overlay.pmtiles")} -l edges -Z8 -z14 --no-simplification-of-shared-nodes ${edgesFile}`;
await $`tippecanoe ${common} -o ${join(out, "basemap.pmtiles")} -Z0 -z14 -A ${"Synthetic fixture"} -L earth:${earthFile} -L water:${waterFile} -L landuse:${landuseFile} -L roads:${roadsFile} -L places:${placesFile}`;

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
      {
        key: "surface_class",
        label: "Surface",
        kind: "enum",
        values: SURFACES.map((label, value) => ({ value, label })),
      },
      {
        key: "highway",
        label: "Road class",
        kind: "enum",
        values: HIGHWAYS.map((label, value) => ({ value, label })),
      },
      { key: "forest", label: "In forest", kind: "share", max: 1 },
      { key: "grade_max", label: "Max grade", kind: "number", unit: "%", min: 0, max: 25 },
    ],
  },
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`fixture region: ${edges.length} edges → ${resolve(out)}`);
