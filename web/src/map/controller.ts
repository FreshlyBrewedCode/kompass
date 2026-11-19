// The region map: owns the MapLibre instance and wires data, style, modes, feature state and inspect.
// No React in here; `components/` renders chrome around it and calls these methods.
import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { ExploredStore } from "@/history/explored-store";
import { ExploredLayer } from "./explored-layer";
import { type OverlayState, overlayPaint } from "./expressions";
import { type PickedEdge, pickEdge } from "./inspect";
import type { Manifest } from "./manifest";
import type { Theme } from "./palette";
import { registerPmtiles } from "./protocol";
import { buildStyle, labelLanguage, OVERLAY_CASING, OVERLAY_LINE, OVERLAY_SOURCE } from "./style";

// MapLibre finds its worker next to its own module, which a bundle moves: point it at the copy Vite emits.
setWorkerUrl(workerUrl);

export type RegionMapOptions = {
  container: HTMLElement;
  manifest: Manifest;
  dataUrl: string;
  theme: Theme;
  overlay: OverlayState;
  store: ExploredStore;
  /** an edge was picked (`null`: the tap hit nothing, or the overlay is hidden) */
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
  #overlay: OverlayState;
  #selected: number | null = null;
  #ready = false;

  constructor(options: RegionMapOptions) {
    registerPmtiles();
    this.#options = options;
    this.#theme = options.theme;
    this.#overlay = options.overlay;
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
    container.dataset.mode = options.overlay.mode;
    container.dataset.idle = "false";

    this.map.once("load", () => {
      this.#ready = true;
      container.dataset.loaded = "true";
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
      overlay: this.#overlay,
      assetsUrl: new URL("map/", document.baseURI).href,
      lang: labelLanguage(navigator.languages ?? [navigator.language]),
    });
  }

  /** Switch the mode / attribute: only the overlay's paint changes, no tiles reload. */
  setOverlay(overlay: OverlayState) {
    this.#overlay = overlay;
    if (!this.#ready) return;
    this.#paintOverlay();
    this.#options.container.dataset.mode = overlay.mode;
    if (overlay.mode === "plain") this.select(null);
  }

  #paintOverlay() {
    const { map } = this;
    const paint = overlayPaint(this.#overlay, this.#theme);
    for (const id of [OVERLAY_CASING, OVERLAY_LINE]) {
      map.setLayoutProperty(id, "visibility", paint.visible ? "visible" : "none");
    }
    map.setPaintProperty(OVERLAY_CASING, "line-color", paint.casingColor);
    map.setPaintProperty(OVERLAY_CASING, "line-opacity", paint.casingOpacity);
    map.setPaintProperty(OVERLAY_CASING, "line-width", paint.casingWidth);
    map.setPaintProperty(OVERLAY_LINE, "line-color", paint.lineColor);
    map.setPaintProperty(OVERLAY_LINE, "line-opacity", paint.lineOpacity);
    map.setPaintProperty(OVERLAY_LINE, "line-width", paint.lineWidth);
  }

  /** The base map's flavour and the overlay's colours follow the theme; the new style drops feature state. */
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

  #click(point: { x: number; y: number }) {
    if (this.#overlay.mode === "plain") return;
    this.select(pickEdge(this.map, point));
  }

  destroy() {
    this.explored.destroy();
    this.map.remove();
  }
}
