// The region map: owns the MapLibre instance and wires data, style, modes, feature state and inspect.
// No React in here; `components/` renders chrome around it and calls these methods.
import "maplibre-gl/dist/maplibre-gl.css";
import { type GeoJSONSource, Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { ExploredStore } from "@/history/explored-store";
import type { RidesLayerData } from "@/rides/protocol";
import type { Bounds } from "@/rides/types";
import { COST_ARROW_LAYERS, COST_BAND_LAYERS } from "./cost";
import { ExploredLayer } from "./explored-layer";
import { infoLayerName, type MapLayers } from "./info";
import { type PickedEdge, pickEdge } from "./inspect";
import type { Manifest } from "./manifest";
import type { Theme } from "./palette";
import { registerPmtiles } from "./protocol";
import {
  buildStyle,
  CONTOUR_LABEL,
  CONTOUR_LINE,
  EXPLORED_LINE,
  HILLSHADE,
  INFO_LINE,
  labelLanguage,
  NO_RIDES,
  OVERLAY_SOURCE,
  RIDES_CASING,
  RIDES_LINE,
  RIDES_SELECTED,
  RIDES_SOURCE,
  type RidesLayerState,
} from "./style";
import { WAY_PICK_LAYERS, WAY_ROUTE } from "./ways";

/** The layers `setLayers` switches: their filter, colour, zoom range and visibility follow the state. */
const SWITCHED = [
  HILLSHADE,
  CONTOUR_LINE,
  CONTOUR_LABEL,
  WAY_ROUTE,
  INFO_LINE,
  EXPLORED_LINE,
  ...COST_BAND_LAYERS,
  ...COST_ARROW_LAYERS,
];

// MapLibre finds its worker next to its own module, which a bundle moves: point it at the copy Vite emits.
setWorkerUrl(workerUrl);

export type RegionMapOptions = {
  container: HTMLElement;
  manifest: Manifest;
  dataUrl: string;
  theme: Theme;
  layers: MapLayers;
  store: ExploredStore;
  /** an edge was picked (`null`: the tap hit nothing) */
  onPick: (edge: PickedEdge | null) => void;
  /** a source failed to load (not a missing glyph range) */
  onError: (message: string) => void;
};

/** Where the map opens: the region's centre, zoomed to what is useful (the overlay starts at its minzoom). */
export function initialView(manifest: Manifest): { center: [number, number]; zoom: number } {
  const [w, s, e, n] = manifest.bounds;
  const span = Math.max(e - w, n - s);
  const fit = Math.floor(Math.log2(360 / span));
  return { center: manifest.center, zoom: Math.min(14, Math.max(manifest.overlay.minzoom + 3, fit)) };
}

export class RegionMap {
  readonly map: MapLibreMap;
  readonly explored: ExploredLayer;
  readonly #options: RegionMapOptions;
  #theme: Theme;
  #layers: MapLayers;
  #selected: number | null = null;
  #ready = false;
  #rides: RidesLayerState = NO_RIDES;
  /** whether a tap inspects the way under it (the planner turns it on only on request) */
  #picking = true;

  constructor(options: RegionMapOptions) {
    registerPmtiles();
    this.#options = options;
    this.#theme = options.theme;
    this.#layers = options.layers;
    const { container, manifest } = options;
    const view = initialView(manifest);
    this.map = new MapLibreMap({
      container,
      style: this.#style(),
      center: view.center,
      zoom: view.zoom,
      attributionControl: { compact: true },
      // the tiles' own overzoom covers the rest; the engine only knows the region
      maxZoom: 19,
    });
    this.explored = new ExploredLayer(this.map, options.store, manifest.overlay.layer);
    container.dataset.loaded = "false";
    container.dataset.layer = infoLayerName(options.layers.info);
    container.dataset.idle = "false";

    this.map.once("load", () => {
      this.#ready = true;
      container.dataset.loaded = "true";
      // what arrived while the style was loading
      (this.map.getSource(RIDES_SOURCE) as GeoJSONSource | undefined)?.setData(this.#rides.data as never);
      this.setRidesVisible(this.#rides.visible);
      this.highlightRide(this.#rides.selected);
      void this.explored.reapply();
    });
    this.map.on("idle", () => {
      container.dataset.idle = "true";
    });
    this.map.on("dataloading", () => {
      container.dataset.idle = "false";
    });
    this.map.on("click", (event) => this.#click(event.point));
    this.map.on("error", (event) => {
      const message = String(event.error?.message ?? event.error);
      // harmless: glyph ranges are vendored for Latin scripts only (other ranges 404, the label lacks that
      // glyph), and a base map tileset without e.g. POIs has no such source layer
      if (
        /glyph|\/fonts\/|source layer .* does not exist/i.test(
          `${message} ${(event as { url?: string }).url ?? ""}`,
        )
      )
        return;
      options.onError(message);
    });
  }

  #style() {
    const { manifest, dataUrl } = this.#options;
    return buildStyle({
      manifest,
      dataUrl,
      theme: this.#theme,
      layers: this.#layers,
      rides: this.#rides,
      assetsUrl: new URL("map/", document.baseURI).href,
      lang: labelLanguage(navigator.languages ?? [navigator.language]),
    });
  }

  /** Replaces the recorded lines ("My rides"). */
  setRides(data: RidesLayerData) {
    this.#rides = { ...this.#rides, data };
    if (!this.#ready) return;
    (this.map.getSource(RIDES_SOURCE) as GeoJSONSource | undefined)?.setData(data as never);
  }

  setRidesVisible(visible: boolean) {
    this.#rides = { ...this.#rides, visible };
    if (!this.#ready) return;
    for (const id of [RIDES_CASING, RIDES_SELECTED, RIDES_LINE]) {
      this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }

  /** Highlights one ride's line (`null` clears). */
  highlightRide(id: string | null) {
    this.#rides = { ...this.#rides, selected: id };
    if (!this.#ready) return;
    this.map.setFilter(RIDES_SELECTED, ["==", ["get", "id"], id ?? ""]);
  }

  /** Zooms to a ride's bounds, leaving room for the panel (`padding` in px). */
  fitBounds(bounds: Bounds, padding: { top: number; right: number; bottom: number; left: number }) {
    const [w, s, e, n] = bounds;
    this.map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding, maxZoom: 16, duration: 600 },
    );
  }

  /**
   * Switches the information layer and the toggles. Only the layers that depend on them change (filter,
   * colour, zoom range, visibility): no tiles reload, the base style stays as it is.
   */
  setLayers(layers: MapLayers) {
    this.#layers = layers;
    if (!this.#ready) return;
    const { map } = this;
    const wanted = new Map(this.#style().layers.map((layer) => [layer.id, layer]));
    for (const id of SWITCHED) {
      const layer = wanted.get(id);
      if (!layer || !map.getLayer(id)) continue;
      map.setLayoutProperty(id, "visibility", layer.layout?.visibility ?? "visible");
      if (id !== INFO_LINE || layer.type !== "line") continue;
      map.setFilter(id, layer.filter ?? null);
      map.setLayerZoomRange(id, layer.minzoom ?? 0, layer.maxzoom ?? 24);
      map.setPaintProperty(id, "line-color", layer.paint?.["line-color"]);
    }
    this.#options.container.dataset.layer = infoLayerName(layers.info);
  }

  /** The whole style follows the theme; the new style drops feature state. */
  setTheme(theme: Theme) {
    if (theme === this.#theme) return;
    this.#theme = theme;
    if (!this.#ready) return;
    this.explored.suspend();
    this.map.once("style.load", () => {
      void this.explored.reapply();
      this.#markSelected(true);
    });
    this.map.setStyle(this.#style(), { diff: false });
  }

  /** Highlights an edge (and reports it); `null` clears. */
  select(edge: PickedEdge | null) {
    this.#markSelected(false);
    this.#selected = edge?.id ?? null;
    this.#markSelected(true);
    this.#options.onPick(edge);
  }

  #markSelected(on: boolean) {
    if (this.#selected === null || !this.map.getSource(OVERLAY_SOURCE)) return;
    const target = {
      source: OVERLAY_SOURCE,
      sourceLayer: this.#options.manifest.overlay.layer,
      id: this.#selected,
    };
    if (on) this.map.setFeatureState(target, { selected: true });
    else this.map.removeFeatureState(target, "selected");
  }

  /** Taps inspect ways (`true`) or are left to others, e.g. the planner's waypoints (`false`). */
  setPicking(on: boolean) {
    this.#picking = on;
    if (!on && this.#selected !== null) this.select(null);
  }

  #click(point: { x: number; y: number }) {
    if (!this.#picking) return;
    this.select(pickEdge(this.map, point, [...WAY_PICK_LAYERS, INFO_LINE]));
  }

  destroy() {
    this.explored.destroy();
    this.map.remove();
  }
}
