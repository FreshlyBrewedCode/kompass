import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/map/manifest";
import { buildStyle, labelLanguage, OVERLAY_CASING, OVERLAY_LINE } from "../src/map/style";

const manifest = parseManifest({
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
    attributes: [{ key: "forest", label: "In forest", kind: "share", max: 1 }],
  },
});
const base = {
  dataUrl: "http://example.test/app/data/",
  theme: "light" as const,
  overlay: { mode: "plain" as const },
  assetsUrl: "http://example.test/app/map/",
};

describe("buildStyle", () => {
  test("PMTiles sources next to the manifest; glyphs and sprites self-hosted", () => {
    const style = buildStyle({ manifest, ...base });
    expect(style.sources.basemap).toMatchObject({
      url: "pmtiles://http://example.test/app/data/basemap.pmtiles",
    });
    expect(style.sources.overlay).toMatchObject({ minzoom: 8, maxzoom: 14 });
    expect(style.glyphs).toBe("http://example.test/app/map/fonts/{fontstack}/{range}.pbf");
    expect(style.sprite).toBe("http://example.test/app/map/sprites/v4/light");
    // nothing points at a third-party server
    expect(JSON.stringify(style)).not.toMatch(/openfreemap|protomaps\.github|tiles\.protomaps/);
  });

  test("the overlay sits above the base map's roads and below its labels", () => {
    const ids = buildStyle({ manifest, ...base }).layers.map((l) => l.id);
    const line = ids.indexOf(OVERLAY_LINE);
    expect(ids.indexOf(OVERLAY_CASING)).toBeLessThan(line);
    expect(ids.indexOf("roads_labels_major")).toBeGreaterThan(line);
    expect(ids.indexOf("roads_minor")).toBeLessThan(line);
  });

  test("the recorded rides sit with the overlay, above the roads and below the labels", () => {
    const ids = buildStyle({ manifest, ...base }).layers.map((l) => l.id);
    const rides = ids.indexOf("rides-line");
    expect(rides).toBeGreaterThan(ids.indexOf(OVERLAY_LINE));
    expect(rides).toBeLessThan(ids.indexOf("roads_labels_major"));
    const hidden = buildStyle({
      manifest,
      ...base,
      rides: { data: { type: "FeatureCollection", features: [] }, visible: false, selected: "abc" },
    });
    expect(hidden.layers.find((l) => l.id === "rides-line")?.layout).toMatchObject({ visibility: "none" });
    expect(
      JSON.stringify(
        (hidden.layers.find((l) => l.id === "rides-selected") as { filter?: unknown } | undefined)?.filter,
      ),
    ).toContain("abc");
  });

  test("without a base map the style is a plain background plus the overlay", () => {
    const style = buildStyle({ manifest: { ...manifest, basemap: null }, ...base });
    expect(Object.keys(style.sources)).toEqual(["overlay", "rides"]);
    expect(style.layers.map((l) => l.id)).toEqual([
      "background",
      "overlay-casing",
      "overlay-selected",
      "overlay-edges",
      "rides-casing",
      "rides-selected",
      "rides-line",
    ]);
  });

  test("the dark theme uses the dark flavour and sprite", () => {
    const style = buildStyle({ manifest, ...base, theme: "dark" });
    expect(style.sprite).toEndWith("/dark");
    expect(style.layers.find((l) => l.id === "background")).toMatchObject({ type: "background" });
  });

  test("the mode decides the overlay's visibility", () => {
    const attribute = manifest.overlay.attributes[0];
    const shown = buildStyle({ manifest, ...base, overlay: { mode: "attribute", attribute } });
    expect(shown.layers.find((l) => l.id === OVERLAY_LINE)?.layout?.visibility).toBe("visible");
    const hidden = buildStyle({ manifest, ...base });
    expect(hidden.layers.find((l) => l.id === OVERLAY_LINE)?.layout?.visibility).toBe("none");
  });
});

describe("labelLanguage", () => {
  test("the first supported browser language, else English", () => {
    expect(labelLanguage(["fr-CH", "en"])).toBe("fr");
    expect(labelLanguage(["xx"])).toBe("en");
    expect(labelLanguage([])).toBe("en");
  });
});
