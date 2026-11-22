import { describe, expect, test } from "bun:test";
import { expression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification } from "maplibre-gl";
import { infoLayerFromName } from "../src/map/info";
import { DEFAULT_LOOK } from "../src/map/look";
import { parseManifest } from "../src/map/manifest";
import { buildStyle, DEFAULT_LAYERS, labelLanguage } from "../src/map/style";
import { code, pipelineManifest } from "./pipeline-manifest";

const manifest = pipelineManifest();
const base = {
  dataUrl: "http://example.test/app/data/",
  theme: "light" as const,
  layers: DEFAULT_LAYERS,
  assetsUrl: "http://example.test/app/map/",
};
const ids = (style: { layers: { id: string }[] }) => style.layers.map((l) => l.id);
const layer = (style: { layers: { id: string }[] }, id: string) =>
  style.layers.find((l) => l.id === id) as
    | { layout?: { visibility?: string }; filter?: unknown; minzoom?: number; maxzoom?: number }
    | undefined;

describe("buildStyle", () => {
  test("PMTiles sources next to the manifest; glyphs and sprites self-hosted", () => {
    const style = buildStyle({ manifest, ...base });
    expect(style.sources.basemap).toMatchObject({
      url: "pmtiles://http://example.test/app/data/basemap.pmtiles",
    });
    expect(style.sources.overlay).toMatchObject({ minzoom: 8, maxzoom: 14 });
    expect(style.sources.terrain).toMatchObject({
      type: "raster-dem",
      url: "pmtiles://http://example.test/app/data/terrain.pmtiles",
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 12,
    });
    expect(style.sources.contours).toMatchObject({ type: "vector", maxzoom: 14 });
    expect(style.glyphs).toBe("http://example.test/app/map/fonts/{fontstack}/{range}.pbf");
    expect(style.sprite).toBe("http://example.test/app/map/sprites/v4/light");
    // nothing points at a third-party server
    expect(JSON.stringify(style)).not.toMatch(/openfreemap|protomaps\.github|tiles\.protomaps/);
  });

  test.each([
    ["light", "none"],
    ["dark", "none"],
    ["light", "surface_class"],
    ["dark", "forest_edge_share"],
    ["light", "grade_max"],
    ["light", "explored"],
  ] as const)("the %s style with layer %s is valid for MapLibre", (theme, name) => {
    const info = infoLayerFromName(name, manifest.overlay.attributes);
    const style = buildStyle({ manifest, ...base, theme, layers: { ...DEFAULT_LAYERS, info } });
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
    expect(new Set(ids(style)).size).toBe(style.layers.length);
  });

  test("the map style options: contour lines off, a stronger relief, the same layers", () => {
    const style = buildStyle({
      manifest,
      ...base,
      look: { ...DEFAULT_LOOK, contours: false, relief: "strong", weight: "bold" },
    });
    const layer = (id: string) => style.layers.find((l) => l.id === id) as LayerSpecification;
    expect(layer("contour-line").layout?.visibility).toBe("none");
    expect(layer("contour-label").layout?.visibility).toBe("none");
    expect(layer("hillshade").layout?.visibility).toBe("visible");
    expect(ids(style)).toEqual(ids(buildStyle({ manifest, ...base })));
  });

  test("the order: ground, relief, water, the ways with the bands inside, motorways, rides, labels", () => {
    const order = ids(buildStyle({ manifest, ...base }));
    const sequence = [
      "land-cover",
      "hillshade",
      "contour-line",
      "water",
      "buildings",
      "way-route",
      "way-halo",
      "way-casing",
      "way-casing-dashed",
      "info-line",
      "explored-line",
      "cost-line",
      "way-solid",
      "way-band",
      "way-bridge",
      "way-ferry",
      "base-motorway",
      "rides-line",
      "contour-label",
      "peaks",
      "places_locality",
    ];
    expect(sequence.map((id) => order.indexOf(id))).toEqual(
      [...sequence.map((id) => order.indexOf(id))].sort((a, b) => a - b),
    );
    expect(sequence.every((id) => order.includes(id))).toBe(true);
  });

  test("the overlay draws every road, track and path at every zoom; the base tiles none of them", () => {
    const style = buildStyle({ manifest, ...base });
    for (const id of ["way-casing", "way-halo", "way-band", "way-solid", "way-dash-long", "way-dots"]) {
      expect(layer(style, id)?.minzoom).toBeUndefined();
    }
    expect(ids(style)).not.toContain("base-road");
    // an overlay from before the drawing properties has no tracks below z13: the base tiles hint at z12
    expect(ids(style)).not.toContain("base-track");
    const old = buildStyle({
      manifest: { ...manifest, overlay: { ...manifest.overlay, drawing: [] } },
      ...base,
    });
    expect(layer(old, "base-track")).toMatchObject({ minzoom: 12, maxzoom: 13 });
    expect(validateStyleMin(old as never)).toEqual([]);
    // motorways and railways are not in the overlay: the base tiles draw them at every zoom
    expect(layer(style, "base-motorway")?.maxzoom).toBeUndefined();
    // none of the package's own road or land layers is left
    expect(ids(style).filter((id) => /^roads_(?!labels|shields|oneway)|^landuse_/.test(id))).toEqual([]);
  });

  test("the bands on top never draw a ferry (no rings on the lakes)", () => {
    const style = buildStyle({
      manifest,
      ...base,
      layers: { ...DEFAULT_LAYERS, info: infoLayerFromName("forest_share", manifest.overlay.attributes) },
    });
    const passes = (id: string, properties: Record<string, number>) => {
      const compiled = expression.createExpression(layer(style, id)?.filter ?? true, "test", {
        type: "boolean",
      } as never);
      if (compiled.result !== "success") throw new Error(JSON.stringify(compiled.value));
      return compiled.value.evaluate({ zoom: 14 }, { type: 2, properties } as never);
    };
    const ferry = { highway: code("highway", "ferry"), forest_share: 90, route_level: 2 };
    const track = { ...ferry, highway: code("highway", "track") };
    for (const id of ["info-line", "explored-line", "cost-line", "way-route"]) {
      expect([id, passes(id, ferry)]).toEqual([id, false]);
      expect([id, passes(id, track)]).toEqual([id, true]);
    }
  });

  test("the information layer: off by default, an attribute's band, or the explored band", () => {
    const off = buildStyle({ manifest, ...base });
    expect(layer(off, "info-line")?.layout?.visibility).toBe("none");
    expect(layer(off, "explored-line")?.layout?.visibility).toBe("none");
    const attributes = manifest.overlay.attributes;
    const surface = buildStyle({
      manifest,
      ...base,
      layers: { ...DEFAULT_LAYERS, info: infoLayerFromName("surface_class", attributes) },
    });
    expect(layer(surface, "info-line")?.layout?.visibility).toBe("visible");
    expect(JSON.stringify(layer(surface, "info-line")?.filter)).toContain("surface_class");
    expect(layer(surface, "explored-line")?.layout?.visibility).toBe("none");
    const explored = buildStyle({
      manifest,
      ...base,
      layers: { ...DEFAULT_LAYERS, info: { kind: "explored" } },
    });
    expect(layer(explored, "info-line")?.layout?.visibility).toBe("none");
    expect(layer(explored, "explored-line")?.layout?.visibility).toBe("visible");
  });

  test("the toggles hide the relief and the cycle routes", () => {
    const style = buildStyle({
      manifest,
      ...base,
      layers: { ...DEFAULT_LAYERS, terrain: false, routes: false },
    });
    for (const id of ["hillshade", "contour-line", "contour-label", "way-route"]) {
      expect(layer(style, id)?.layout?.visibility).toBe("none");
    }
  });

  test("the recorded rides sit above the ways and below the labels", () => {
    const hidden = buildStyle({
      manifest,
      ...base,
      rides: { data: { type: "FeatureCollection", features: [] }, visible: false, selected: "abc" },
    });
    expect(layer(hidden, "rides-line")?.layout).toMatchObject({ visibility: "none" });
    expect(JSON.stringify(layer(hidden, "rides-selected")?.filter)).toContain("abc");
  });

  test("without terrain the map is flat; without a base map it is a plain background plus the overlay", () => {
    const flat = buildStyle({ manifest: { ...manifest, terrain: null }, ...base });
    expect(Object.keys(flat.sources)).toEqual(["overlay", "rides", "basemap"]);
    expect(ids(flat)).not.toContain("hillshade");
    const bare = buildStyle({ manifest: { ...manifest, terrain: null, basemap: null }, ...base });
    expect(Object.keys(bare.sources)).toEqual(["overlay", "rides"]);
    expect(ids(bare)).toEqual([
      "background",
      "way-route",
      "way-halo",
      "way-casing",
      "way-casing-dashed",
      "way-selected",
      "info-line",
      "explored-line",
      "cost-line",
      "cost-closed",
      "cost-selected",
      "way-solid",
      "way-band",
      "way-bridge",
      "way-ferry",
      "cost-arrow-along",
      "cost-arrow-against",
      "rides-casing",
      "rides-selected",
      "rides-line",
    ]);
    expect(validateStyleMin(bare as never)).toEqual([]);
  });

  test("the cost layer: bands under the ways' lines, chevrons above them, only while it is on", () => {
    const on = buildStyle({ manifest, ...base, layers: { ...DEFAULT_LAYERS, info: { kind: "cost" } } });
    expect(validateStyleMin(on as never)).toEqual([]);
    for (const id of ["cost-line", "cost-closed", "cost-selected", "cost-arrow-along"])
      expect(layer(on, id)?.layout).toMatchObject({ visibility: "visible" });
    expect(ids(on).indexOf("cost-line")).toBeLessThan(ids(on).indexOf("way-band"));
    expect(ids(on).indexOf("cost-arrow-along")).toBeGreaterThan(ids(on).indexOf("way-band"));
    const off = buildStyle({ manifest, ...base });
    expect(layer(off, "cost-line")?.layout).toMatchObject({ visibility: "none" });
  });

  test("a hand-made manifest (other labels, few attributes) still gives a valid style", () => {
    const small = parseManifest({
      schemaVersion: 1,
      builtAt: "2000-01-01T00:00:00Z",
      bounds: [-1, -1, 1, 1],
      center: [0, 0],
      overlay: {
        file: "overlay.pmtiles",
        layer: "edges",
        minzoom: 8,
        maxzoom: 14,
        attributes: [{ key: "forest", label: "In forest", kind: "share", max: 1 }],
      },
    });
    expect(validateStyleMin(buildStyle({ manifest: small, ...base }) as never)).toEqual([]);
  });

  test("the dark theme uses the dark sprite and its own colours", () => {
    const style = buildStyle({ manifest, ...base, theme: "dark" });
    expect(style.sprite).toEndWith("/dark");
    expect(JSON.stringify(style)).not.toBe(JSON.stringify(buildStyle({ manifest, ...base })));
  });
});

describe("labelLanguage", () => {
  test("the first supported browser language, else English", () => {
    expect(labelLanguage(["fr-CH", "en"])).toBe("fr");
    expect(labelLanguage(["xx"])).toBe("en");
    expect(labelLanguage([])).toBe("en");
  });
});
