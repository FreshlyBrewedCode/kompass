// Builds the MapLibre style of a region, bottom to top:
//
//   ground      background, land cover and land use                 (basemap.ts, Protomaps tiles)
//   relief      hillshade, contour lines                            (the manifest's `terrain`, optional)
//   water       lakes and the sea, above the relief
//   features    rivers, buildings
//   routes      the soft band of signed cycle routes                (ways.ts, overlay)
//   ways        the overlay's roads, tracks and paths, every zoom   (ways.ts); between their rims and
//               their fills: the one information layer, the explored band or the cost layer
//   top         motorways, railways, borders                        (basemap.ts)
//   rides       the recorded tracks
//   labels      contour heights, then the Protomaps labels
//
// Pure: no map instance needed. Colours: carto.ts (the map) and palette.ts (what lies on top).
import { language_script_pairs } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";
import type { RidesLayerData } from "@/rides/protocol";
import { type BaseLayers, baseLayers, oldOverlayTracks } from "./basemap";
import { type Carto, cartoFor } from "./carto";
import { costArrowLayers, costLayers } from "./cost";
import { infoSpec, type MapLayers } from "./info";
import { DEFAULT_LOOK, type MapLook, WEIGHT_SCALE } from "./look";
import type { Manifest } from "./manifest";
import { CASING, EXPLORED, RIDES, SELECTED, type Theme } from "./palette";
import { dataFileUrl } from "./region";
import { routeLayer, underlayWidth, wayClasses, wayLayers } from "./ways";

type Expr = ExpressionSpecification;

export const BASEMAP_SOURCE = "basemap";
export const OVERLAY_SOURCE = "overlay";
export const TERRAIN_SOURCE = "terrain";
export const CONTOUR_SOURCE = "contours";
export const HILLSHADE = "hillshade";
export const CONTOUR_LINE = "contour-line";
export const CONTOUR_LABEL = "contour-label";
export const INFO_LINE = "info-line";
export const EXPLORED_LINE = "explored-line";
export const RIDES_SOURCE = "rides";
export const RIDES_CASING = "rides-casing";
export const RIDES_SELECTED = "rides-selected";
export const RIDES_LINE = "rides-line";

/** The "My rides" layer's state: the lines, whether it shows, and the ride it highlights. */
export type RidesLayerState = { data: RidesLayerData; visible: boolean; selected: string | null };
export const NO_RIDES: RidesLayerState = {
  data: { type: "FeatureCollection", features: [] },
  visible: true,
  selected: null,
};

export const DEFAULT_LAYERS: MapLayers = { info: { kind: "none" }, terrain: true, routes: true };

export type StyleOptions = {
  manifest: Manifest;
  dataUrl: string;
  theme: Theme;
  layers: MapLayers;
  /** the map style options (track style, line weight, ground, relief, contours); the defaults if absent */
  look?: MapLook;
  /** where the vendored glyphs and sprites are served (absolute URL ending in a slash): `<app>/map/` */
  assetsUrl: string;
  /** label language (a code the Protomaps basemaps know), else English */
  lang?: string;
  /** the recorded rides; none by default */
  rides?: RidesLayerState;
};

const visibility = (visible: boolean) => (visible ? "visible" : "none") as "visible" | "none";

const rideWidth = (scale: number) =>
  ["interpolate", ["linear"], ["zoom"], 8, 1 * scale, 12, 2.2 * scale, 16, 4 * scale] as const;

/** The recorded tracks (a GeoJSON source) above everything but the labels. */
export function ridesLayers(theme: Theme, state: RidesLayerState): LayerSpecification[] {
  const layout = {
    visibility: visibility(state.visible),
    "line-cap": "round",
    "line-join": "round",
  } as const;
  const source = { source: RIDES_SOURCE } as const;
  return [
    {
      id: RIDES_CASING,
      type: "line",
      ...source,
      layout,
      paint: { "line-color": CASING[theme], "line-opacity": 0.55, "line-width": rideWidth(2.2) as never },
    },
    {
      id: RIDES_SELECTED,
      type: "line",
      ...source,
      layout,
      filter: ["==", ["get", "id"], state.selected ?? ""],
      paint: { "line-color": SELECTED[theme], "line-opacity": 0.9, "line-width": rideWidth(2.6) as never },
    },
    {
      id: RIDES_LINE,
      type: "line",
      ...source,
      layout,
      paint: { "line-color": RIDES[theme], "line-opacity": 0.8, "line-width": rideWidth(1.3) as never },
    },
  ];
}

/** The label language: the browser's, if the Protomaps style supports it. */
export function labelLanguage(preferred: readonly string[]): string {
  const supported = new Set(language_script_pairs.map((p) => p.lang));
  for (const tag of preferred) {
    const lang = tag.toLowerCase().split("-")[0] ?? "";
    if (supported.has(lang)) return lang;
  }
  return "en";
}

/** Hillshade and contour lines; the contour heights go with the labels. */
export function terrainLayers(
  manifest: Manifest,
  c: Carto,
  visible: boolean,
  /** the contour lines and their heights (with the relief) */
  contours = true,
): { relief: LayerSpecification[]; labels: LayerSpecification[] } {
  const terrain = manifest.terrain;
  if (!terrain) return { relief: [], labels: [] };
  const layout = { visibility: visibility(visible) };
  const relief: LayerSpecification[] = [
    {
      id: HILLSHADE,
      type: "hillshade",
      source: TERRAIN_SOURCE,
      layout,
      paint: {
        "hillshade-exaggeration": c.hillshadeStrength,
        "hillshade-shadow-color": c.shade,
        "hillshade-highlight-color": c.highlight,
        "hillshade-accent-color": c.shade,
        "hillshade-illumination-direction": 315,
      },
    },
  ];
  const labels: LayerSpecification[] = [];
  if (terrain.contours) {
    const source = { source: CONTOUR_SOURCE, "source-layer": terrain.contours.layer } as const;
    const index: Expr = ["==", ["%", ["get", "ele"], 100], 0];
    const shown = { visibility: visibility(visible && contours) };
    relief.push({
      id: CONTOUR_LINE,
      type: "line",
      ...source,
      minzoom: 11,
      layout: { ...shown, "line-join": "round" },
      paint: {
        "line-color": c.contour,
        // faint at the overview zooms, where they would read as tracks
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          ["case", index, 0.14, 0.07],
          13,
          ["case", index, 0.3, 0.11],
          15,
          ["case", index, 0.35, 0.21],
        ],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          0.5,
          14,
          ["case", index, 1.1, 0.6],
          17,
          ["case", index, 1.6, 0.9],
        ],
      },
    });
    labels.push({
      id: CONTOUR_LABEL,
      type: "symbol",
      ...source,
      minzoom: 13,
      filter: index,
      layout: {
        ...shown,
        "symbol-placement": "line",
        "symbol-spacing": 320,
        "text-field": ["to-string", ["get", "ele"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-max-angle": 25,
        "text-padding": 6,
      },
      paint: {
        "text-color": c.contourLabel,
        "text-halo-color": c.labelHalo,
        "text-halo-width": 1.2,
      },
    });
  }
  return { relief, labels };
}

/**
 * An information layer's filter: only the edges the ways draw at this zoom (never a ferry: a band
 * would draw a ring on the lake; no car-park aisle or pavement before its way shows).
 */
export function infoFilter(manifest: Manifest, filter: Expr): Expr {
  return ["all", wayClasses(manifest.overlay.attributes).shown, filter];
}

/**
 * The information layer: a coloured band under the edges an attribute's defaults pick (`info.ts`). The
 * map's line styles stay readable on it: a gravel track is still a dashed line, now on orange.
 */
export function infoLayers(
  manifest: Manifest,
  theme: Theme,
  layers: MapLayers,
  /** the line weight (`WEIGHT_SCALE`) */
  weight = 1,
): LayerSpecification[] {
  const { info } = layers;
  const spec = info.kind === "attribute" ? infoSpec(info.attribute, theme) : null;
  return [
    {
      id: INFO_LINE,
      type: "line",
      source: OVERLAY_SOURCE,
      "source-layer": manifest.overlay.layer,
      minzoom: spec?.minzoom ?? 0,
      filter: infoFilter(manifest, spec?.filter ?? ["literal", false]) as never,
      layout: { "line-cap": "round", "line-join": "round", visibility: visibility(spec !== null) },
      paint: {
        "line-color": spec?.color ?? CASING[theme],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.95, 14, 0.82],
        "line-width": underlayWidth(manifest.overlay.attributes, 1, undefined, weight),
      },
    },
  ];
}

/**
 * The explored band: a highlighter over the ridden edges; the rest of the map stays as it is. Edges
 * ridden more often are a little stronger (the `count` of their feature state, explored-layer.ts).
 */
export function exploredLayer(
  manifest: Manifest,
  theme: Theme,
  layers: MapLayers,
  weight = 1,
): LayerSpecification {
  return {
    id: EXPLORED_LINE,
    type: "line",
    source: OVERLAY_SOURCE,
    "source-layer": manifest.overlay.layer,
    // every ridden way but a ferry (a band would draw a ring on the lake); what you rode shows even
    // where the map leaves the way out at this zoom (a driveway, a pavement)
    filter: ["!", wayClasses(manifest.overlay.attributes).ferry],
    layout: {
      "line-cap": "round",
      "line-join": "round",
      visibility: visibility(layers.info.kind === "explored"),
    },
    paint: {
      "line-color": EXPLORED[theme],
      // three calm steps of intensity: ridden once, a few times (2 to 4), often (5 or more)
      "line-opacity": [
        "case",
        ["boolean", ["feature-state", "ridden"], false],
        ["step", ["to-number", ["feature-state", "count"], 1], 0.5, 2, 0.7, 5, 0.9],
        0,
      ],
      "line-width": underlayWidth(manifest.overlay.attributes, 1.1, undefined, weight),
    },
  };
}

const NO_BASE: BaseLayers = { ground: [], water: [], features: [], top: [], labels: [] };

export function buildStyle(options: StyleOptions): StyleSpecification {
  const { manifest, dataUrl, theme, assetsUrl, layers } = options;
  const look = options.look ?? DEFAULT_LOOK;
  const c = cartoFor(theme, look);
  const weight = WEIGHT_SCALE[look.weight];
  const rides = options.rides ?? NO_RIDES;
  const pmtiles = (file: string) => `pmtiles://${dataFileUrl(dataUrl, file)}`;
  const sources: StyleSpecification["sources"] = {
    [OVERLAY_SOURCE]: {
      type: "vector",
      url: pmtiles(manifest.overlay.file),
      minzoom: manifest.overlay.minzoom,
      maxzoom: manifest.overlay.maxzoom,
      // integer feature ids are the edge ids; no `promoteId` needed
    },
    [RIDES_SOURCE]: { type: "geojson", data: rides.data as never },
  };

  let base = NO_BASE;
  if (manifest.basemap) {
    sources[BASEMAP_SOURCE] = {
      type: "vector",
      url: pmtiles(manifest.basemap.file),
      maxzoom: manifest.basemap.maxzoom,
    };
    base = baseLayers(BASEMAP_SOURCE, theme, c, options.lang ?? "en");
  } else {
    base = {
      ...NO_BASE,
      ground: [{ id: "background", type: "background", paint: { "background-color": c.land } }],
    };
  }
  if (manifest.terrain) {
    const t = manifest.terrain;
    sources[TERRAIN_SOURCE] = {
      type: "raster-dem",
      url: pmtiles(t.file),
      encoding: t.encoding,
      tileSize: t.tileSize,
      minzoom: t.minzoom,
      maxzoom: t.maxzoom,
    };
    if (t.contours) {
      sources[CONTOUR_SOURCE] = {
        type: "vector",
        url: pmtiles(t.contours.file),
        minzoom: t.contours.minzoom,
        maxzoom: t.contours.maxzoom,
      };
    }
  }
  const terrain = terrainLayers(manifest, c, layers.terrain, look.contours);
  const way = {
    source: OVERLAY_SOURCE,
    sourceLayer: manifest.overlay.layer,
    colors: c,
    routes: layers.routes,
    weight,
  };
  const attributes = manifest.overlay.attributes;
  const ways = wayLayers(attributes, way);

  return {
    version: 8,
    // `{fontstack}` / `{range}` must stay literal braces: built as a string, not through `new URL`
    glyphs: `${assetsUrl}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assetsUrl}sprites/v4/${theme}`,
    sources,
    layers: [
      ...base.ground,
      ...terrain.relief,
      ...base.water,
      ...base.features,
      routeLayer(attributes, way),
      ...(manifest.basemap && manifest.overlay.drawing.length === 0
        ? oldOverlayTracks(BASEMAP_SOURCE, c)
        : []),
      // halo and casing, then the bands, then the ways' own lines and fills on top of them
      ...ways.under,
      ...infoLayers(manifest, theme, layers, weight),
      exploredLayer(manifest, theme, layers, weight),
      ...costLayers(manifest, theme, layers.info.kind === "cost", weight),
      ...ways.over,
      ...costArrowLayers(manifest, theme, layers.info.kind === "cost"),
      ...base.top,
      ...ridesLayers(theme, rides),
      ...terrain.labels,
      ...base.labels,
    ],
  };
}
