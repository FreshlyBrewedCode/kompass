// The region manifest: what the pipeline writes next to the PMTiles (`manifest.json`). The app knows
// nothing about a region until it loads this; docs/map.md describes the contract.

export const SCHEMA_VERSION = 1;

export type EnumValue = { value: number; label: string };

export type EnumAttribute = { key: string; label: string; kind: "enum"; values: EnumValue[] };
export type ShareAttribute = { key: string; label: string; kind: "share"; max: number };
export type NumberAttribute = {
  key: string;
  label: string;
  kind: "number";
  unit?: string;
  min: number;
  max: number;
};
export type OverlayAttribute = EnumAttribute | ShareAttribute | NumberAttribute;

export type DemEncoding = "terrarium" | "mapbox";

/** The relief: raster-DEM tiles for the hillshade, and optionally contour lines as vector tiles. */
export type Terrain = {
  file: string;
  encoding: DemEncoding;
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  /** lines with an `ele` attribute (metres) */
  contours: { file: string; layer: string; minzoom: number; maxzoom: number } | null;
};

/**
 * A file next to the manifest (path relative to it) and its size in bytes; `gzip`: the size of its
 * gzip sibling `<file>.gz`, when the build wrote one (the graph files: the app fetches those).
 */
export type DataFile = { file: string; bytes: number; gzip?: number };

/** One graph tile: its web-mercator tile at `tileZoom`, its edge count, and its two files. */
export type GraphTile = { x: number; y: number; edges: number; graph: DataFile; geometry: DataFile };

/** The engine's routing graph (`kompass compile`, docs/graph-format.md). */
export type GraphFiles = {
  /** The binary format version; the engine refuses other versions. */
  formatVersion: number;
  buildId: string;
  tileZoom: number;
  nodes: number;
  edges: number;
  /** All files together. */
  bytes: number;
  /** All gzip siblings together (absent in builds without them). */
  gzipBytes?: number;
  index: DataFile;
  tiles: GraphTile[];
};

export type Manifest = {
  schemaVersion: number;
  /** The build that wrote the files (overlay, graph and edge ids belong together); absent in old builds. */
  buildId?: string;
  builtAt: string;
  /** west, south, east, north */
  bounds: [number, number, number, number];
  /** lon, lat */
  center: [number, number];
  /** `null`: no base map, the style falls back to a plain background. */
  basemap: { file: string; maxzoom: number } | null;
  overlay: {
    file: string;
    /** the vector layer holding the edges */
    layer: string;
    minzoom: number;
    maxzoom: number;
    attributes: OverlayAttribute[];
  };
  /** `null`: the build has no terrain, the map is drawn flat. */
  terrain: Terrain | null;
  /** Absent until the graph is compiled into the build. */
  graph?: GraphFiles;
};

export class ManifestError extends Error {
  constructor(message: string) {
    super(`Invalid region manifest: ${message}`);
    this.name = "ManifestError";
  }
}

type Obj = Record<string, unknown>;

function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(`${path} must be an object`);
  }
  return value as Obj;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "")
    throw new ManifestError(`${path} must be a non-empty string`);
  return value;
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ManifestError(`${path} must be a number`);
  return value;
}

function int(value: unknown, path: string): number {
  const n = num(value, path);
  if (!Number.isInteger(n)) throw new ManifestError(`${path} must be an integer`);
  return n;
}

function lonLat(lon: number, lat: number, path: string) {
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new ManifestError(`${path} is out of range`);
}

/** A file name next to the manifest: no path tricks, no other origin. */
function fileName(value: unknown, path: string): string {
  const name = str(value, path);
  if (/^[a-z][a-z0-9+.-]*:/i.test(name) || name.startsWith("/") || name.split("/").includes("..")) {
    throw new ManifestError(`${path} must be a relative file name`);
  }
  return name;
}

function count(value: unknown, path: string): number {
  const n = int(value, path);
  if (n < 0) throw new ManifestError(`${path} must not be negative`);
  return n;
}

function dataFile(value: unknown, path: string): DataFile {
  const f = obj(value, path);
  const file = { file: fileName(f.file, `${path}.file`), bytes: count(f.bytes, `${path}.bytes`) };
  return f.gzip === undefined ? file : { ...file, gzip: count(f.gzip, `${path}.gzip`) };
}

function graphFiles(value: unknown, buildId: string | undefined): GraphFiles {
  const g = obj(value, "graph");
  const graphBuild = str(g.buildId, "graph.buildId");
  if (buildId !== undefined && graphBuild !== buildId) {
    throw new ManifestError(`graph.buildId ${graphBuild} is not the manifest's build ${buildId}`);
  }
  const tileZoom = int(g.tileZoom, "graph.tileZoom");
  if (tileZoom < 0 || tileZoom > 16) throw new ManifestError("graph.tileZoom must be 0..16");
  if (!Array.isArray(g.tiles)) throw new ManifestError("graph.tiles must be a list");
  const tiles = g.tiles.map((t: unknown, i): GraphTile => {
    const path = `graph.tiles[${i}]`;
    const o = obj(t, path);
    return {
      x: count(o.x, `${path}.x`),
      y: count(o.y, `${path}.y`),
      edges: count(o.edges, `${path}.edges`),
      graph: dataFile(o.graph, `${path}.graph`),
      geometry: dataFile(o.geometry, `${path}.geometry`),
    };
  });
  return {
    formatVersion: int(g.formatVersion, "graph.formatVersion"),
    buildId: graphBuild,
    tileZoom,
    nodes: count(g.nodes, "graph.nodes"),
    edges: count(g.edges, "graph.edges"),
    bytes: count(g.bytes, "graph.bytes"),
    ...(g.gzipBytes === undefined ? {} : { gzipBytes: count(g.gzipBytes, "graph.gzipBytes") }),
    index: dataFile(g.index, "graph.index"),
    tiles,
  };
}

function attribute(value: unknown, path: string): OverlayAttribute {
  const a = obj(value, path);
  const key = str(a.key, `${path}.key`);
  const label = str(a.label, `${path}.label`);
  switch (a.kind) {
    case "enum": {
      if (!Array.isArray(a.values) || a.values.length === 0) {
        throw new ManifestError(`${path}.values must be a non-empty list`);
      }
      const values = a.values.map((v: unknown, i): EnumValue => {
        const o = obj(v, `${path}.values[${i}]`);
        return {
          value: int(o.value, `${path}.values[${i}].value`),
          label: str(o.label, `${path}.values[${i}].label`),
        };
      });
      if (new Set(values.map((v) => v.value)).size !== values.length) {
        throw new ManifestError(`${path}.values has a code twice`);
      }
      return { key, label, kind: "enum", values };
    }
    case "share": {
      const max = num(a.max, `${path}.max`);
      if (max <= 0) throw new ManifestError(`${path}.max must be positive`);
      return { key, label, kind: "share", max };
    }
    case "number": {
      const min = num(a.min, `${path}.min`);
      const max = num(a.max, `${path}.max`);
      if (max <= min) throw new ManifestError(`${path}.max must be greater than min`);
      const unit = a.unit === undefined ? undefined : str(a.unit, `${path}.unit`);
      return unit === undefined
        ? { key, label, kind: "number", min, max }
        : { key, label, kind: "number", unit, min, max };
    }
    default:
      throw new ManifestError(`${path}.kind must be "enum", "share" or "number"`);
  }
}

function zoomRange(o: Obj, path: string): { minzoom: number; maxzoom: number } {
  const minzoom = int(o.minzoom, `${path}.minzoom`);
  const maxzoom = int(o.maxzoom, `${path}.maxzoom`);
  if (minzoom < 0 || maxzoom < minzoom || maxzoom > 22)
    throw new ManifestError(`${path} zoom range is invalid`);
  return { minzoom, maxzoom };
}

function terrain(value: unknown): Terrain | null {
  if (value === null || value === undefined) return null;
  const t = obj(value, "terrain");
  if (t.encoding !== "terrarium" && t.encoding !== "mapbox") {
    throw new ManifestError('terrain.encoding must be "terrarium" or "mapbox"');
  }
  const tileSize = int(t.tileSize, "terrain.tileSize");
  if (tileSize !== 256 && tileSize !== 512) throw new ManifestError("terrain.tileSize must be 256 or 512");
  let contours: Terrain["contours"] = null;
  if (t.contours !== null && t.contours !== undefined) {
    const c = obj(t.contours, "terrain.contours");
    contours = {
      file: fileName(c.file, "terrain.contours.file"),
      layer: str(c.layer, "terrain.contours.layer"),
      ...zoomRange(c, "terrain.contours"),
    };
  }
  return {
    file: fileName(t.file, "terrain.file"),
    encoding: t.encoding,
    tileSize,
    ...zoomRange(t, "terrain"),
    contours,
  };
}

/** Checks the parsed JSON of a manifest and returns it typed; throws `ManifestError` naming what is wrong. */
export function parseManifest(json: unknown): Manifest {
  const m = obj(json, "the manifest");
  const schemaVersion = int(m.schemaVersion, "schemaVersion");
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new ManifestError(
      `schemaVersion ${schemaVersion} is not supported (this app reads ${SCHEMA_VERSION})`,
    );
  }
  const builtAt = str(m.builtAt, "builtAt");
  // the pipeline writes `null` when it has no build id
  const buildId = m.buildId === undefined || m.buildId === null ? undefined : str(m.buildId, "buildId");

  if (!Array.isArray(m.bounds) || m.bounds.length !== 4)
    throw new ManifestError("bounds must be [west, south, east, north]");
  const [w, s, e, n] = m.bounds.map((v: unknown, i) => num(v, `bounds[${i}]`)) as [
    number,
    number,
    number,
    number,
  ];
  lonLat(w, s, "bounds");
  lonLat(e, n, "bounds");
  if (w >= e || s >= n) throw new ManifestError("bounds must have west < east and south < north");

  if (!Array.isArray(m.center) || m.center.length !== 2) throw new ManifestError("center must be [lon, lat]");
  const [lon, lat] = m.center.map((v: unknown, i) => num(v, `center[${i}]`)) as [number, number];
  lonLat(lon, lat, "center");

  let basemap: Manifest["basemap"] = null;
  if (m.basemap !== null && m.basemap !== undefined) {
    const b = obj(m.basemap, "basemap");
    basemap = { file: fileName(b.file, "basemap.file"), maxzoom: int(b.maxzoom, "basemap.maxzoom") };
  }

  const o = obj(m.overlay, "overlay");
  const { minzoom, maxzoom } = zoomRange(o, "overlay");
  if (!Array.isArray(o.attributes)) throw new ManifestError("overlay.attributes must be a list");
  const attributes = o.attributes.map((a: unknown, i) => attribute(a, `overlay.attributes[${i}]`));
  if (new Set(attributes.map((a) => a.key)).size !== attributes.length) {
    throw new ManifestError("overlay.attributes has a key twice");
  }

  const graph = m.graph === undefined || m.graph === null ? undefined : graphFiles(m.graph, buildId);

  return {
    schemaVersion,
    ...(buildId === undefined ? {} : { buildId }),
    builtAt,
    bounds: [w, s, e, n],
    center: [lon, lat],
    basemap,
    overlay: {
      file: fileName(o.file, "overlay.file"),
      layer: str(o.layer, "overlay.layer"),
      minzoom,
      maxzoom,
      attributes,
    },
    terrain: terrain(m.terrain),
    ...(graph === undefined ? {} : { graph }),
  };
}
