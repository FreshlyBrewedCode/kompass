// Builds the e2e fixture region: a tiny invented place (a grid of streets around 0°N 0°E, open sea in
// reality) in the shape of a real build (docs/map.md, docs/graph-format.md): manifest.json,
// overlay.pmtiles (layer `edges`, integer feature ids = edge ids), a minimal basemap.pmtiles in the
// Protomaps schema (earth, water, roads, places), edges.parquet (the pipeline contract, written by
// edges-parquet.py with the pipeline's own writer) and the engine's graph compiled from it (graph/).
// Edge ids are the row numbers of the Hilbert-sorted edges, as in a real build, so the overlay, the
// parquet and the graph agree on them.
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
// a selection of the schema's road classes, with their codes (pipeline/src/kompass_pipeline/schema.py)
const HIGHWAYS: [number, string][] = [
  [0, "other"],
  [1, "trunk"],
  [3, "primary"],
  [5, "secondary"],
  [7, "tertiary"],
  [10, "residential"],
  [12, "service"],
  [14, "track"],
  [15, "path"],
  [16, "cycleway"],
];

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
type Line = { way: number; coordinates: [number, number][] };
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
// edge ids: the row numbers after the pipeline's sort
const keyed = lines.map((l) => ({ ...l, key: hilbert(z16Tile(midpoint(l.coordinates))) }));
keyed.sort((p, q) => p.key - q.key || p.way - q.way);

const edges: Feature[] = [];
const roads: Feature[] = [];
keyed.forEach(({ way, coordinates }, id) => {
  // the attributes follow from the id, so the e2e can name them (edge 1: compacted trunk, ...)
  const seed = id;
  const highway = HIGHWAYS[seed % HIGHWAYS.length] as [number, string];
  const properties: Record<string, unknown> = {
    surface_class: (seed * 3 + (seed >> 2)) % SURFACES.length,
    highway: highway[0],
    forest: Math.round((((seed * 7) % 11) / 10) * 100) / 100,
    // not in the overlay (tippecanoe -x), only in edges.parquet
    way_id: way,
    oneway_bike: seed % 17 === 3 ? 1 : seed % 19 === 10 ? -1 : 0,
  };
  // every seventh edge has no grade: "no value" is information too
  if (seed % 7 !== 0) properties.grade_max = (seed * 5) % 26;
  edges.push({ type: "Feature", id, properties, geometry: { type: "LineString", coordinates } });
  const kind = seed % 9 === 0 ? "major_road" : seed % 3 === 0 ? "medium_road" : "minor_road";
  const [a, b] = [coordinates[0], coordinates[2]];
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
await $`tippecanoe ${common} -o ${join(out, "overlay.pmtiles")} -l edges -Z8 -z14 -x way_id -x oneway_bike --no-simplification-of-shared-nodes ${edgesFile}`;
await $`tippecanoe ${common} -o ${join(out, "basemap.pmtiles")} -Z0 -z14 -A ${"Synthetic fixture"} -L earth:${earthFile} -L water:${waterFile} -L landuse:${landuseFile} -L roads:${roadsFile} -L places:${placesFile}`;

const BUILD_ID = "fixture";
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
        values: HIGHWAYS.map(([value, label]) => ({ value, label })),
      },
      { key: "forest", label: "In forest", kind: "share", max: 1 },
      { key: "grade_max", label: "Max grade", kind: "number", unit: "%", min: 0, max: 25 },
    ],
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
