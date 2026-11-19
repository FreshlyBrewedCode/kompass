// Builds the MapLibre style of a region: the Protomaps base map (or a plain background without one),
// the overlay (routing edges) between the base map's roads and its labels, and the self-hosted
// glyphs and sprites. Pure: no map instance needed.
import { language_script_pairs, namedFlavor, layers as protomapsLayers } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { type OverlayState, overlayPaint } from "./expressions";
import type { Manifest } from "./manifest";
import { SELECTED, type Theme } from "./palette";
import { dataFileUrl } from "./region";

export const BASEMAP_SOURCE = "basemap";
export const OVERLAY_SOURCE = "overlay";
export const OVERLAY_CASING = "overlay-casing";
export const OVERLAY_LINE = "overlay-edges";
export const OVERLAY_SELECTED = "overlay-selected";

export type StyleOptions = {
  manifest: Manifest;
  dataUrl: string;
  theme: Theme;
  overlay: OverlayState;
  /** where the vendored glyphs and sprites are served (absolute URL ending in a slash): `<app>/map/` */
  assetsUrl: string;
  /** label language (a code the Protomaps basemaps know), else English */
  lang?: string;
};

/** The label language: the browser's, if the Protomaps style supports it. */
export function labelLanguage(preferred: readonly string[]): string {
  const supported = new Set(language_script_pairs.map((p) => p.lang));
  for (const tag of preferred) {
    const lang = tag.toLowerCase().split("-")[0] ?? "";
    if (supported.has(lang)) return lang;
  }
  return "en";
}

export function overlayLayers(
  options: Pick<StyleOptions, "manifest" | "theme" | "overlay">,
): LayerSpecification[] {
  const { manifest, theme, overlay } = options;
  const paint = overlayPaint(overlay, theme);
  const source = { source: OVERLAY_SOURCE, "source-layer": manifest.overlay.layer } as const;
  const layout = {
    visibility: paint.visible ? "visible" : "none",
    "line-cap": "round",
    "line-join": "round",
  } as const;
  return [
    {
      id: OVERLAY_CASING,
      type: "line",
      ...source,
      layout,
      paint: {
        "line-color": paint.casingColor,
        "line-opacity": paint.casingOpacity,
        "line-width": paint.casingWidth,
      },
    },
    {
      // the edge the inspect panel shows: a halo under the line (its colour stays visible), by feature-state
      id: OVERLAY_SELECTED,
      type: "line",
      ...source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": SELECTED[theme],
        "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.9, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 4, 16, 8, 18, 12],
      },
    },
    {
      id: OVERLAY_LINE,
      type: "line",
      ...source,
      layout,
      paint: {
        "line-color": paint.lineColor,
        "line-opacity": paint.lineOpacity,
        "line-width": paint.lineWidth,
      },
    },
  ];
}

export function buildStyle(options: StyleOptions): StyleSpecification {
  const { manifest, dataUrl, theme, assetsUrl } = options;
  const flavor = namedFlavor(theme);
  const sources: StyleSpecification["sources"] = {
    [OVERLAY_SOURCE]: {
      type: "vector",
      url: `pmtiles://${dataFileUrl(dataUrl, manifest.overlay.file)}`,
      minzoom: manifest.overlay.minzoom,
      maxzoom: manifest.overlay.maxzoom,
      // integer feature ids are the edge ids; no `promoteId` needed
    },
  };

  let before: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": flavor.background } },
  ];
  let labels: LayerSpecification[] = [];
  if (manifest.basemap) {
    sources[BASEMAP_SOURCE] = {
      type: "vector",
      url: `pmtiles://${dataFileUrl(dataUrl, manifest.basemap.file)}`,
      maxzoom: manifest.basemap.maxzoom,
    };
    const lang = options.lang ?? "en";
    const all = protomapsLayers(BASEMAP_SOURCE, flavor, { lang });
    const labelIds = new Set(
      protomapsLayers(BASEMAP_SOURCE, flavor, { lang, labelsOnly: true }).map((l) => l.id),
    );
    before = all.filter((l) => !labelIds.has(l.id));
    labels = all.filter((l) => labelIds.has(l.id));
  }

  return {
    version: 8,
    // `{fontstack}` / `{range}` must stay literal braces: built as a string, not through `new URL`
    glyphs: `${assetsUrl}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assetsUrl}sprites/v4/${theme}`,
    sources,
    layers: [...before, ...overlayLayers(options), ...labels],
  };
}
