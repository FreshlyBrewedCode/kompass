import { describe, expect, test } from "bun:test";
import { ManifestError, parseManifest } from "../src/map/manifest";

const valid = () => ({
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
    attributes: [
      { key: "surface_class", label: "Surface", kind: "enum", values: [{ value: 0, label: "unknown" }] },
      { key: "forest", label: "In forest", kind: "share", max: 1 },
      { key: "grade_max", label: "Max grade", kind: "number", unit: "%", min: 0, max: 25 },
    ],
  },
});

/** The manifest with one path replaced (`undefined` removes it). */
function mutate(path: string[], value: unknown) {
  const m = valid() as Record<string, unknown>;
  let node = m;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return m;
}

describe("parseManifest", () => {
  test("accepts the pipeline's manifest", () => {
    const m = parseManifest(valid());
    expect(m.overlay.attributes.map((a) => a.kind)).toEqual(["enum", "share", "number"]);
    expect(m.basemap?.file).toBe("basemap.pmtiles");
  });

  test("reads the build id and the graph files", () => {
    const graph = {
      formatVersion: 1,
      buildId: "abc",
      tileZoom: 11,
      nodes: 36,
      edges: 60,
      bytes: 1700,
      index: { file: "graph/index.kmpg", bytes: 352 },
      tiles: [
        {
          x: 1023,
          y: 1023,
          edges: 13,
          graph: { file: "graph/tiles/11-1023-1023.kmpg", bytes: 1024 },
          geometry: { file: "graph/geometry/11-1023-1023.kmpg", bytes: 320 },
        },
      ],
    };
    const m = parseManifest({ ...valid(), buildId: "abc", graph });
    expect(m.buildId).toBe("abc");
    expect(m.graph).toEqual(graph);
    // optional: absent (not compiled yet) or a manifest without a build id
    expect(parseManifest(valid()).graph).toBeUndefined();
    expect(parseManifest({ ...valid(), buildId: null }).buildId).toBeUndefined();
    expect(parseManifest({ ...valid(), graph }).graph?.buildId).toBe("abc");
    // the graph must be of the manifest's build, with relative paths and sizes
    expect(() => parseManifest({ ...valid(), buildId: "other", graph })).toThrow(/not the manifest's build/);
    const tile = graph.tiles[0] as (typeof graph.tiles)[0];
    const bad = { ...graph, tiles: [{ ...tile, graph: { file: "/abs.kmpg", bytes: 1 } }] };
    expect(() => parseManifest({ ...valid(), graph: bad })).toThrow(/graph.tiles\[0\].graph.file/);
    expect(() => parseManifest({ ...valid(), graph: { ...graph, bytes: -1 } })).toThrow(/graph.bytes/);
    expect(() => parseManifest({ ...valid(), graph: { ...graph, tiles: {} } })).toThrow(/graph.tiles/);
  });

  test("a region without a base map is fine (basemap: null or absent)", () => {
    expect(parseManifest(mutate(["basemap"], null)).basemap).toBeNull();
    expect(parseManifest(mutate(["basemap"], undefined)).basemap).toBeNull();
  });

  test("the terrain is optional; with it, the contours are too", () => {
    expect(parseManifest(valid()).terrain).toBeNull();
    expect(parseManifest(mutate(["terrain"], null)).terrain).toBeNull();
    const dem = { file: "terrain.pmtiles", encoding: "terrarium", tileSize: 256, minzoom: 6, maxzoom: 12 };
    expect(parseManifest(mutate(["terrain"], dem)).terrain).toEqual({ ...dem, contours: null } as never);
    const contours = { file: "contours.pmtiles", layer: "contours", minzoom: 10, maxzoom: 14 };
    expect(parseManifest(mutate(["terrain"], { ...dem, contours })).terrain?.contours).toEqual(contours);
    expect(() =>
      parseManifest(mutate(["terrain"], { ...dem, contours: { ...contours, layer: "" } })),
    ).toThrow("terrain.contours.layer");
  });

  test("rejects what is not an object, and other schema versions", () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest([])).toThrow(ManifestError);
    expect(() => parseManifest(mutate(["schemaVersion"], 2))).toThrow(/schemaVersion 2/);
  });

  test.each([
    [["bounds"], [1, 2, 3], "bounds"],
    [["bounds"], [1, -1, -1, 1], "west < east"],
    [["bounds"], [-1, -1, 1, 95], "out of range"],
    [["center"], [0], "center"],
    [["basemap", "file"], "https://elsewhere.example/b.pmtiles", "relative file name"],
    [["overlay", "file"], "../overlay.pmtiles", "relative file name"],
    [["overlay", "layer"], "", "overlay.layer"],
    [["overlay", "maxzoom"], 6, "zoom range"],
    [["terrain"], { file: "t.pmtiles", encoding: "raw", tileSize: 256, minzoom: 6, maxzoom: 12 }, "encoding"],
    [
      ["terrain"],
      { file: "/t.pmtiles", encoding: "mapbox", tileSize: 256, minzoom: 6, maxzoom: 12 },
      "relative",
    ],
    [
      ["terrain"],
      { file: "t.pmtiles", encoding: "mapbox", tileSize: 300, minzoom: 6, maxzoom: 12 },
      "tileSize",
    ],
    [
      ["terrain"],
      { file: "t.pmtiles", encoding: "mapbox", tileSize: 256, minzoom: 9, maxzoom: 3 },
      "zoom range",
    ],
    [["overlay", "attributes"], "none", "overlay.attributes"],
    [["overlay", "attributes"], [{ key: "a", label: "A", kind: "colour" }], "kind"],
    [["overlay", "attributes"], [{ key: "a", label: "A", kind: "enum", values: [] }], "values"],
    [["overlay", "attributes"], [{ key: "a", label: "A", kind: "share", max: 0 }], "positive"],
    [
      ["overlay", "attributes"],
      [{ key: "a", label: "A", kind: "number", min: 5, max: 5 }],
      "greater than min",
    ],
  ])("rejects %j = %j", (path, value, message) => {
    expect(() => parseManifest(mutate(path as string[], value))).toThrow(message as string);
  });

  test("rejects duplicate attribute keys and enum codes", () => {
    const dup = valid();
    dup.overlay.attributes.push(dup.overlay.attributes[1] as never);
    expect(() => parseManifest(dup)).toThrow(/key twice/);
    const codes = valid();
    (codes.overlay.attributes[0] as { values: unknown[] }).values.push({ value: 0, label: "again" });
    expect(() => parseManifest(codes)).toThrow(/code twice/);
  });

  test("names the failing path", () => {
    expect(() =>
      parseManifest(mutate(["overlay", "attributes"], [{ key: "a", label: "A", kind: "share" }])),
    ).toThrow("overlay.attributes[0].max");
  });
});
