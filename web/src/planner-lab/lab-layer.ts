// TEMPORARY (the planner lab, #19): the lab's route lines and waypoint markers on the region map,
// kept apart from src/map. The planner shell replaces all of src/planner-lab/.
import { type GeoJSONSource, type Map as MapLibreMap, Marker } from "maplibre-gl";
import { RIDES_LINE } from "@/map/style";

export const LAB_SOURCE = "lab-routes";
export const LAB_CASING = "lab-routes-casing";
export const LAB_LINE = "lab-routes-line";
/** the main route, and the second preset's for comparison */
export const ROUTE_COLOR = "#d23f18";
export const COMPARE_COLOR = "#0072b2";

export type LabLine = { id: "main" | "compare"; coordinates: [number, number][] };

type Point = { lon: number; lat: number };

function collection(lines: LabLine[]) {
  return {
    type: "FeatureCollection" as const,
    // the comparison first, so the main route draws on top
    features: [...lines]
      .sort((a, b) => (a.id === b.id ? 0 : a.id === "compare" ? -1 : 1))
      .filter((l) => l.coordinates.length > 1)
      .map((l) => ({
        type: "Feature" as const,
        id: l.id === "main" ? 1 : 2,
        properties: { route: l.id, color: l.id === "main" ? ROUTE_COLOR : COMPARE_COLOR },
        geometry: { type: "LineString" as const, coordinates: l.coordinates },
      })),
  };
}

/** The lab's lines (above the overlay and "My rides", below the labels) and its waypoint markers. */
export class LabLayer {
  readonly map: MapLibreMap;
  #lines: LabLine[] = [];
  #markers: Marker[] = [];
  readonly #onStyle = () => this.#ensure();

  constructor(map: MapLibreMap) {
    this.map = map;
    // a theme switch replaces the whole style: put the lines back
    map.on("styledata", this.#onStyle);
    map.on("idle", this.#onStyle);
    this.#ensure();
  }

  #ensure() {
    const map = this.map;
    if (map.getSource(LAB_SOURCE)) return;
    try {
      map.addSource(LAB_SOURCE, { type: "geojson", data: collection(this.#lines) });
    } catch {
      return; // the style is still loading: the next styledata / idle event tries again
    }
    const layers = map.getStyle().layers;
    const ridesAt = layers.findIndex((l) => l.id === RIDES_LINE);
    const before = layers[ridesAt + 1]?.id;
    map.addLayer(
      {
        id: LAB_CASING,
        type: "line",
        source: LAB_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 },
      },
      before,
    );
    map.addLayer(
      {
        id: LAB_LINE,
        type: "line",
        source: LAB_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 4 },
      },
      before,
    );
  }

  setLines(lines: LabLine[]) {
    this.#lines = lines;
    (this.map.getSource(LAB_SOURCE) as GeoJSONSource | undefined)?.setData(collection(lines));
  }

  /** One draggable marker per waypoint: drag to move, tap to remove. */
  setWaypoints(points: Point[], onMove: (i: number, p: Point) => void, onRemove: (i: number) => void) {
    for (const m of this.#markers) m.remove();
    this.#markers = points.map((p, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.dataset.testid = "lab-waypoint";
      el.setAttribute("aria-label", `Waypoint ${i + 1}: tap to remove`);
      el.textContent = i === 0 ? "A" : i === points.length - 1 ? "B" : String(i);
      el.style.cssText =
        "width:26px;height:26px;border-radius:50%;border:2px solid #fff;background:#d23f18;color:#fff;" +
        "font:600 12px system-ui;display:flex;align-items:center;justify-content:center;cursor:grab;" +
        "box-shadow:0 1px 4px rgb(0 0 0 / .4)";
      const marker = new Marker({ element: el, draggable: true }).setLngLat([p.lon, p.lat]).addTo(this.map);
      let dragged = false;
      marker.on("dragstart", () => {
        dragged = true;
      });
      marker.on("dragend", () => {
        const at = marker.getLngLat();
        onMove(i, { lon: at.lng, lat: at.lat });
      });
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        if (dragged) {
          dragged = false;
          return;
        }
        onRemove(i);
      });
      return marker;
    });
  }

  destroy() {
    this.map.off("styledata", this.#onStyle);
    this.map.off("idle", this.#onStyle);
    for (const m of this.#markers) m.remove();
    this.#markers = [];
    if (this.map.getStyle()) {
      for (const id of [LAB_LINE, LAB_CASING]) if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(LAB_SOURCE)) this.map.removeSource(LAB_SOURCE);
    }
  }
}
