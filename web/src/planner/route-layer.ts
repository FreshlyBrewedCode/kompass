// What the planner draws on the region map, and the map's taps (docs/planner.md):
// - the plan's route: one vermilion line with a rim, above the map's ways and below its labels (or
//   coloured by surface, a switch in "Map & rides");
// - the base profile's route as a dashed ink ghost while the changes move the route, or after an
//   error the route without the blocking limit; a compared preset's route in blue;
// - the waypoints as draggable markers (dragging reroutes live), the timeline's cursor, a few
//   "why this way" notes.
// It subscribes to the planner store itself and only touches the source whose data changed: a
// slider step costs one `setData` of the main line.
import { type GeoJSONSource, type LngLatLike, type Map as MapLibreMap, Marker } from "maplibre-gl";
import type { RouteResult } from "@/engine/generated/types";
import type { Theme } from "@/map/palette";
import { RIDES_LINE } from "@/map/style";
import { markerText, routeNotes, SURFACE_GROUP, vertexAt, waypointLabel } from "./model";
import { GHOST, ROUTE, ROUTE_ALT, ROUTE_CASING, surfaceColor } from "./palette";
import type { PlannerStore, PlanState } from "./store";

const MAIN = "planner-main";
const ALT = "planner-alt";
const CURSOR = "planner-cursor";
export const MAIN_LINE = "planner-main-line";
export const ALT_LINE = "planner-alt-line";
export const GHOST_LINE = "planner-ghost-line";
const MAIN_CASING = "planner-main-casing";
const ALT_CASING = "planner-alt-casing";
const CURSOR_DOT = "planner-cursor-dot";

type Padding = { top: number; right: number; bottom: number; left: number };
type Feature = {
  type: "Feature";
  properties: { kind?: string; color?: string };
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "Point"; coordinates: [number, number] };
};
const collection = (features: Feature[]) => ({ type: "FeatureCollection" as const, features });

export type LayerView = {
  theme: Theme;
  /** the plain map (no information layer): route by surface and notes only there */
  plain: boolean;
  /** how many notes fit (0: none) */
  notes: number;
  /** room the chrome takes, for fitting the route */
  padding: () => Padding;
  /** a tap on the map while something covers it (a sheet): close it instead of adding a waypoint */
  onCoveredTap: () => boolean;
};

/** Distance and duration of the route, rounded, for a marker's label. */
function mainFeatures(r: RouteResult | null, bySurface: boolean, theme: Theme): Feature[] {
  const coords = r?.geometry?.coordinates;
  if (!r || !coords || coords.length < 2) return [];
  if (!bySurface)
    return [
      {
        type: "Feature",
        properties: { kind: "main" },
        geometry: { type: "LineString", coordinates: coords },
      },
    ];
  return r.segments
    .filter((s) => s.vertices[1] > s.vertices[0])
    .map((s) => ({
      type: "Feature" as const,
      properties: { kind: "main", color: surfaceColor(SURFACE_GROUP[s.surface], theme) },
      geometry: { type: "LineString" as const, coordinates: coords.slice(s.vertices[0], s.vertices[1] + 1) },
    }));
}

function line(r: RouteResult | null, kind: string): Feature[] {
  const coords = r?.geometry?.coordinates;
  if (!coords || coords.length < 2) return [];
  return [{ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: coords } }];
}

/** The nearest place label around a screen point (a town or village), for naming a waypoint. */
export function placeNear(map: MapLibreMap, point: { x: number; y: number }): string | undefined {
  const layers = (map.getStyle()?.layers ?? [])
    .filter((l) => l.type === "symbol" && /places_(locality|subplace)|place/i.test(l.id))
    .map((l) => l.id);
  if (layers.length === 0) return undefined;
  const r = 70;
  let best: { name: string; d: number } | undefined;
  for (const f of map.queryRenderedFeatures(
    [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ],
    { layers },
  )) {
    const name = f.properties?.name;
    if (typeof name !== "string" || f.geometry.type !== "Point") continue;
    const p = map.project(f.geometry.coordinates as [number, number]);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (!best || d < best.d) best = { name, d };
  }
  return best?.name;
}

export class RouteLayer {
  readonly map: MapLibreMap;
  readonly #store: PlannerStore;
  #view: LayerView;
  #applied: Partial<Record<"main" | "alt" | "cursor" | "notes", unknown>> = {};
  #markers = new Map<string, { marker: Marker; el: HTMLButtonElement }>();
  #notes: Marker[] = [];
  #dragging: string | null = null;
  #fitSeq: number;
  readonly #unsubscribe: () => void;
  readonly #onStyle = () => this.#ensure();
  readonly #onClick = (event: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
    const s = this.#store.getSnapshot();
    if (s.inspect) return; // the region map's inspect has the tap
    if (this.#view.onCoveredTap()) return;
    this.#store.addWaypointAt(event.lngLat.lng, event.lngLat.lat, placeNear(this.map, event.point));
  };

  constructor(map: MapLibreMap, store: PlannerStore, view: LayerView) {
    this.map = map;
    this.#store = store;
    this.#view = view;
    // a restored plan fits once its route is there
    this.#fitSeq = 0;
    map.on("styledata", this.#onStyle);
    map.on("idle", this.#onStyle);
    map.on("click", this.#onClick);
    this.#ensure();
    this.#unsubscribe = store.subscribe(() => this.#sync());
    this.#sync();
  }

  setView(view: LayerView) {
    const redraw =
      view.theme !== this.#view.theme || view.plain !== this.#view.plain || view.notes !== this.#view.notes;
    this.#view = view;
    if (redraw) {
      this.#applied = {};
      this.#paint();
      this.#sync();
    }
  }

  #ensure() {
    const map = this.map;
    if (map.getSource(MAIN)) return;
    try {
      map.addSource(ALT, { type: "geojson", data: collection([]) });
      map.addSource(MAIN, { type: "geojson", data: collection([]) });
      map.addSource(CURSOR, { type: "geojson", data: collection([]) });
    } catch {
      return; // the style is still loading: the next styledata / idle event tries again
    }
    const layers = map.getStyle().layers;
    const ridesAt = layers.findIndex((l) => l.id === RIDES_LINE);
    const before = ridesAt >= 0 ? layers[ridesAt + 1]?.id : undefined;
    const round = { "line-cap": "round" as const, "line-join": "round" as const };
    const isKind = (k: string) => ["==", ["get", "kind"], k] as ["==", ["get", string], string];
    map.addLayer(
      { id: ALT_CASING, type: "line", source: ALT, filter: isKind("compare"), layout: round, paint: {} },
      before,
    );
    map.addLayer(
      { id: ALT_LINE, type: "line", source: ALT, filter: isKind("compare"), layout: round, paint: {} },
      before,
    );
    map.addLayer({ id: MAIN_CASING, type: "line", source: MAIN, layout: round, paint: {} }, before);
    map.addLayer({ id: MAIN_LINE, type: "line", source: MAIN, layout: round, paint: {} }, before);
    map.addLayer(
      {
        id: GHOST_LINE,
        type: "line",
        source: ALT,
        filter: isKind("ghost"),
        layout: { "line-join": "round" },
        paint: {},
      },
      before,
    );
    map.addLayer({ id: CURSOR_DOT, type: "circle", source: CURSOR, paint: {} }, before);
    this.#applied = {};
    this.#paint();
    this.#sync();
  }

  #paint() {
    const map = this.map;
    if (!map.getLayer(MAIN_LINE)) return;
    const t = this.#view.theme;
    const w = (z13: number, z17: number) => [
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      z13 * 0.7,
      13,
      z13,
      17,
      z17,
    ];
    const set = (id: string, prop: string, v: unknown) => map.setPaintProperty(id, prop as never, v as never);
    set(MAIN_CASING, "line-color", ROUTE_CASING[t]);
    set(MAIN_CASING, "line-width", w(9, 13));
    set(MAIN_CASING, "line-opacity", 0.9);
    set(MAIN_LINE, "line-color", ["coalesce", ["get", "color"], ROUTE[t]]);
    set(MAIN_LINE, "line-width", w(5, 8));
    set(ALT_CASING, "line-color", ROUTE_CASING[t]);
    set(ALT_CASING, "line-width", w(7, 10));
    set(ALT_CASING, "line-opacity", 0.85);
    set(ALT_LINE, "line-color", ROUTE_ALT[t]);
    set(ALT_LINE, "line-width", w(3.5, 5.5));
    set(GHOST_LINE, "line-color", GHOST[t]);
    set(GHOST_LINE, "line-width", w(2.5, 3.5));
    set(GHOST_LINE, "line-opacity", 0.75);
    set(GHOST_LINE, "line-dasharray", [2, 1.6]);
    set(CURSOR_DOT, "circle-radius", 7);
    set(CURSOR_DOT, "circle-color", ROUTE[t]);
    set(CURSOR_DOT, "circle-stroke-color", ROUTE_CASING[t]);
    set(CURSOR_DOT, "circle-stroke-width", 3);
  }

  #sync() {
    const s = this.#store.getSnapshot();
    const map = this.map;
    const ready = !!map.getSource(MAIN);
    const error = !!s.main.error;
    const comparing = !!s.compareId;
    const bySurface = s.lineBy === "surface" && this.#view.plain && !comparing;
    // main
    const mainKey = [s.main.result, bySurface, error, s.waypoints.length >= 2];
    if (ready && changed(this.#applied.main, mainKey)) {
      this.#applied.main = mainKey;
      const r = error || s.waypoints.length < 2 ? null : s.main.result;
      (map.getSource(MAIN) as GeoJSONSource).setData(
        collection(mainFeatures(r, bySurface, this.#view.theme)),
      );
    }
    if (ready && map.getLayer(MAIN_LINE)) {
      const opacity = s.routing ? 0.45 : 1;
      if (map.getPaintProperty(MAIN_LINE, "line-opacity") !== opacity)
        map.setPaintProperty(MAIN_LINE, "line-opacity", opacity);
    }
    // ghost / compare / the route without the blocking limit
    const ghostResult = error ? (s.blame?.result ?? null) : s.changed && !comparing ? s.ghost.result : null;
    const showGhost = error || (s.moved !== null && s.moved.length > 0);
    const altKey = [ghostResult, showGhost, comparing ? s.compare.result : null, s.waypoints.length >= 2];
    if (ready && changed(this.#applied.alt, altKey)) {
      this.#applied.alt = altKey;
      const features =
        s.waypoints.length < 2
          ? []
          : [
              ...(showGhost ? line(ghostResult, "ghost") : []),
              ...(comparing ? line(s.compare.result, "compare") : []),
            ];
      (map.getSource(ALT) as GeoJSONSource).setData(collection(features));
    }
    // cursor
    const cursorKey = [s.cursorM, s.main.result];
    if (ready && changed(this.#applied.cursor, cursorKey)) {
      this.#applied.cursor = cursorKey;
      const r = s.main.result;
      const c = r && s.cursorM !== null ? r.geometry?.coordinates[vertexAt(r, s.cursorM)] : undefined;
      (map.getSource(CURSOR) as GeoJSONSource).setData(
        collection(
          c ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }] : [],
        ),
      );
    }
    this.#syncMarkers(s);
    this.#syncNotes(s);
    // fit once the lines are there (and the chrome has laid out around them)
    const lines = (s.main.result || s.blame?.result) && (!s.compareId || s.compare.result || s.compare.error);
    if (s.fitSeq !== this.#fitSeq && lines) {
      this.#fitSeq = s.fitSeq;
      requestAnimationFrame(() => requestAnimationFrame(() => this.fit()));
    }
  }

  /** Fits the map to the route (and the compared one), clear of the chrome. */
  fit() {
    const s = this.#store.getSnapshot();
    const coords = [
      ...((s.main.error ? s.blame?.result : s.main.result)?.geometry?.coordinates ?? []),
      ...(s.compareId ? (s.compare.result?.geometry?.coordinates ?? []) : []),
    ];
    if (coords.length < 2) return;
    let [w, so, e, n] = [180, 90, -180, -90];
    for (const [x, y] of coords) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      so = Math.min(so, y);
      n = Math.max(n, y);
    }
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.map.fitBounds(
      [
        [w, so],
        [e, n],
      ],
      { padding: this.#view.padding(), maxZoom: 16, duration: reduce ? 0 : 600 },
    );
  }

  #syncMarkers(s: PlanState) {
    const n = s.waypoints.length;
    const seen = new Set<string>();
    const blamed = s.main.error?.code === "no_way_near" ? s.main.error.waypoint : undefined;
    s.waypoints.forEach((w, i) => {
      seen.add(w.id);
      let entry = this.#markers.get(w.id);
      if (!entry) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "kp-marker";
        el.dataset.testid = "waypoint-marker";
        el.append(document.createElement("span"));
        el.addEventListener("click", (event) => event.stopPropagation());
        const marker = new Marker({ element: el, draggable: true }).setLngLat([w.lon, w.lat]).addTo(this.map);
        const id = w.id;
        marker.on("dragstart", () => {
          this.#dragging = id;
        });
        marker.on("drag", () => {
          const at = marker.getLngLat();
          this.#store.moveWaypoint(id, at.lng, at.lat);
        });
        marker.on("dragend", () => {
          this.#dragging = null;
          const at = marker.getLngLat();
          this.#store.moveWaypoint(id, at.lng, at.lat, placeNear(this.map, this.map.project(at)) ?? null);
        });
        entry = { marker, el };
        this.#markers.set(w.id, entry);
      }
      if (this.#dragging !== w.id) {
        const at = entry.marker.getLngLat();
        if (at.lng !== w.lon || at.lat !== w.lat) entry.marker.setLngLat([w.lon, w.lat] as LngLatLike);
      }
      const text = markerText(i, n);
      const span = entry.el.firstChild as HTMLSpanElement;
      if (span.textContent !== text) span.textContent = text;
      entry.el.dataset.end = String(i === 0 || i === n - 1);
      entry.el.dataset.problem = String(blamed === i);
      entry.el.setAttribute("aria-label", `${waypointLabel(w, i, n)}: drag to move`);
    });
    for (const [id, entry] of this.#markers) {
      if (seen.has(id)) continue;
      entry.marker.remove();
      this.#markers.delete(id);
    }
  }

  #syncNotes(s: PlanState) {
    const show = this.#view.notes > 0 && this.#view.plain && !s.compareId && !s.main.error && !s.routing;
    const r = show ? s.main.result : null;
    const key = [r, s.catalogue, this.#view.notes];
    if (!changed(this.#applied.notes, key)) return;
    this.#applied.notes = key;
    for (const m of this.#notes) m.remove();
    this.#notes = [];
    if (!r?.geometry) return;
    for (const note of routeNotes(r, s.catalogue, this.#view.notes)) {
      const at = r.geometry.coordinates[note.vertex];
      if (!at) continue;
      const el = document.createElement("div");
      el.className = "kp-note";
      el.dataset.testid = "route-note";
      const b = document.createElement("b");
      b.textContent = note.title;
      el.append(b);
      if (this.#view.notes > 2) {
        const t = document.createElement("span");
        t.textContent = note.text;
        el.append(t);
      }
      this.#notes.push(
        new Marker({ element: el, anchor: "bottom", offset: [0, -10] }).setLngLat(at).addTo(this.map),
      );
    }
  }

  destroy() {
    this.#unsubscribe();
    this.map.off("styledata", this.#onStyle);
    this.map.off("idle", this.#onStyle);
    this.map.off("click", this.#onClick);
    for (const { marker } of this.#markers.values()) marker.remove();
    for (const m of this.#notes) m.remove();
    this.#markers.clear();
    if (this.map.getStyle()) {
      for (const id of [CURSOR_DOT, GHOST_LINE, MAIN_LINE, MAIN_CASING, ALT_LINE, ALT_CASING])
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      for (const id of [MAIN, ALT, CURSOR]) if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }
}

/** Whether a key (a short array of values compared by identity) differs from the last one. */
function changed(last: unknown, next: unknown[]): boolean {
  if (!Array.isArray(last) || last.length !== next.length) return true;
  return next.some((v, i) => !Object.is(v, last[i]));
}
