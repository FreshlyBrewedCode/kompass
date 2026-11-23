// What the planner draws on the region map, and the map's taps (docs/planner.md):
// - the plan's route: one vermilion line with a rim, above the map's ways and below its labels (or
//   coloured by surface, a switch in "Map & rides");
// - the base profile's route as a dashed ink ghost while the changes move the route, or after an
//   error the route without the blocking limit; a compared preset's route in blue;
// - the waypoints as draggable markers (dragging reroutes live), the timeline's cursor, a few
//   "why this way" notes;
// - this plan's exceptions: a quiet mark under the route on each avoided (dotted ink), preferred or
//   allowed (soft halos) stretch;
// - the hard limits' trade-offs: a small marker on the route at each bit where breaking a limit
//   would save real distance; while its card is open, the shortcut dashed in the "allowed" colour;
// - the segment inspector's way: an ink ring around it, or around its whole run between junctions once
//   the engine has it (around the route's line where the route rides it); "why not this" draws the route through it in the compared route's blue, with a ring at the
//   point; the ghost and a compared preset step aside meanwhile;
// - the gestures: a tap adds a waypoint; a right-click or a long press (touch) inspects the nearest way
//   (so does a tap while the Cost layer inspects), or, with no way near, shows the point's coordinates;
//   it never adds a waypoint or opens the browser's menu.
// It subscribes to the planner store itself and only touches the source whose data changed: a
// slider step costs one `setData` of the main line.
import {
  type GeoJSONSource,
  type LngLatLike,
  type Map as MapLibreMap,
  type MapMouseEvent,
  Marker,
} from "maplibre-gl";
import type { RouteResult } from "@/engine/generated/types";
import { pickEdge } from "@/map/inspect";
import { SELECTED, type Theme } from "@/map/palette";
import { INFO_LINE, OVERLAY_SOURCE, RIDES_LINE } from "@/map/style";
import { WAY_PICK_LAYERS } from "@/map/ways";
import { partedBounds } from "./cost/model";
import { LongPress, type Point } from "./inspector/gesture";
import { type InspectTarget, midpoint, nearestPiece, onRoute } from "./inspector/model";
import { markerText, routeNotes, SURFACE_GROUP, vertexAt, waypointLabel } from "./model";
import { GHOST, OVERRIDE, ROUTE, ROUTE_ALT, ROUTE_CASING, surfaceColor } from "./palette";
import type { PlannerStore, PlanState } from "./store";
import { tradeoffKey, tradeoffSentence } from "./tradeoffs";

const MAIN = "planner-main";
const ALT = "planner-alt";
const CURSOR = "planner-cursor";
const INSPECT = "planner-inspect";
/** the open trade-off's shortcut */
const TRADEOFF = "planner-tradeoff";
export const TRADEOFF_LINE = "planner-tradeoff-line";
/** this plan's exceptions (avoided, preferred, allowed stretches) */
export const OVERRIDES = "planner-overrides";
const OVERRIDE_HALO = "planner-override-halo";
const OVERRIDE_AVOID = "planner-override-avoid";
/** the ring around the inspected way */
export const INSPECT_RING = "planner-inspect-ring";
export const MAIN_LINE = "planner-main-line";
export const ALT_LINE = "planner-alt-line";
export const GHOST_LINE = "planner-ghost-line";
const MAIN_CASING = "planner-main-casing";
const ALT_CASING = "planner-alt-casing";
const CURSOR_DOT = "planner-cursor-dot";
/** what the route toggle hides: every route line (the plan's, the ghost, a compared one, "why not") */
export const ROUTE_LINES = [ALT_CASING, ALT_LINE, GHOST_LINE, MAIN_CASING, MAIN_LINE, TRADEOFF_LINE];

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
  /** the overlay's source layer (the ways, by edge id) */
  overlay: string;
  /** a tap inspects a way while `inspect` is on (the Cost layer), instead of the region map's panel */
  tapInspects: boolean;
  /** a way was asked about: right-click, long press, or a tap while the Cost layer inspects */
  onInspect: (target: InspectTarget) => void;
  /** a right-click or long press hit no way: the pressed point, `[lon, lat]` (its coordinates) */
  onPoint: (at: [number, number]) => void;
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
  #applied: Partial<
    Record<"main" | "alt" | "cursor" | "notes" | "inspect" | "overrides" | "tradeoff" | "tradeoffs", unknown>
  > = {};
  #tradeoffs = new Map<string, Marker>();
  /** the inspected way and its pieces as the tiles have them (for the ring off the route) */
  #inspected: { target: InspectTarget; pieces: [number, number][][] } | null = null;
  readonly #press: LongPress;
  #markers = new Map<string, { marker: Marker; el: HTMLButtonElement }>();
  #notes: Marker[] = [];
  #via: Marker | null = null;
  /** the "why not" point the map was last fitted to */
  #fittedAt: unknown = null;
  #dragging: string | null = null;
  #fitSeq: number;
  readonly #unsubscribe: () => void;
  readonly #onStyle = () => this.#ensure();
  readonly #onClick = (event: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
    if (this.#press.swallows()) return; // the echo of a long press
    const s = this.#store.getSnapshot();
    if (s.inspect) {
      // the Cost layer inspects with a tap; an attribute layer's inspect is the region map's
      if (this.#view.tapInspects) this.#inspectAt(event.point);
      return;
    }
    if (this.#view.onCoveredTap()) return;
    this.#store.addWaypointAt(event.lngLat.lng, event.lngLat.lat, placeNear(this.map, event.point));
  };
  /** right-click (and a touch browser's long-press menu): inspect, never the browser's menu */
  readonly #onContextMenu = (event: MapMouseEvent) => {
    event.originalEvent.preventDefault();
    if (this.#press.swallows()) return;
    this.#pressAt(event.point);
  };
  readonly #touchPoints = (event: TouchEvent): Point[] => {
    const box = this.map.getCanvasContainer().getBoundingClientRect();
    return [...event.touches].map((t) => ({ x: t.clientX - box.left, y: t.clientY - box.top }));
  };
  readonly #onTouchStart = (event: TouchEvent) => {
    // a press on a marker or a note is theirs (a waypoint drags)
    if (event.target !== this.map.getCanvas()) return this.#press.cancel();
    this.#press.down(this.#touchPoints(event));
  };
  readonly #onTouchMove = (event: TouchEvent) => this.#press.move(this.#touchPoints(event));
  readonly #onTouchEnd = () => this.#press.up();
  readonly #onMoveStart = () => this.#press.cancel();

  constructor(map: MapLibreMap, store: PlannerStore, view: LayerView) {
    this.map = map;
    this.#store = store;
    this.#view = view;
    // a restored plan fits once its route is there
    this.#fitSeq = 0;
    this.#press = new LongPress((p) => {
      this.#pressAt(p);
      navigator.vibrate?.(12);
    });
    map.on("styledata", this.#onStyle);
    map.on("idle", this.#onStyle);
    map.on("click", this.#onClick);
    map.on("contextmenu", this.#onContextMenu);
    map.on("movestart", this.#onMoveStart);
    const surface = map.getCanvasContainer();
    surface.addEventListener("touchstart", this.#onTouchStart, { passive: true });
    surface.addEventListener("touchmove", this.#onTouchMove, { passive: true });
    surface.addEventListener("touchend", this.#onTouchEnd, { passive: true });
    surface.addEventListener("touchcancel", this.#onTouchEnd, { passive: true });
    this.#ensure();
    this.#unsubscribe = store.subscribe(() => this.#sync());
    this.#sync();
  }

  /** The context menu (right-click, long press): the nearest way's inspector, else the point alone. */
  #pressAt(point: Point) {
    if (this.#inspectAt(point)) return;
    this.#view.onPoint(this.map.unproject([point.x, point.y]).toArray() as [number, number]);
  }

  /**
   * Inspects the way nearest to a screen point: the region map's edge picking, then the way's pieces
   * from the tiles (the ring, and the point halfway along it that "why not this" routes through).
   * `false`: no way there.
   */
  #inspectAt(point: Point): boolean {
    const picked = pickEdge(this.map, point, [...WAY_PICK_LAYERS, INFO_LINE]);
    if (!picked) return false;
    const at = picked.at ?? (this.map.unproject([point.x, point.y]).toArray() as [number, number]);
    const pieces = this.#piecesOf(picked.id);
    const target: InspectTarget = {
      id: picked.id,
      at,
      point: midpoint(nearestPiece(pieces, at) ?? []) ?? at,
    };
    this.#inspected = { target, pieces };
    this.#view.onInspect(target);
    this.#sync();
    return true;
  }

  #piecesOf(id: number): [number, number][][] {
    let features: ReturnType<MapLibreMap["querySourceFeatures"]> = [];
    try {
      features = this.map.querySourceFeatures(OVERLAY_SOURCE, {
        sourceLayer: this.#view.overlay,
        filter: ["==", ["id"], id],
      });
    } catch {
      return [];
    }
    return features.flatMap((f) => {
      const g = f.geometry;
      if (g.type === "LineString") return [g.coordinates as [number, number][]];
      if (g.type === "MultiLineString") return g.coordinates as [number, number][][];
      return [];
    });
  }

  /** The way the inspector shows (`null`: none); a target not picked here gets its pieces from the tiles. */
  setInspected(target: InspectTarget | null) {
    if (target?.id === this.#inspected?.target.id && target?.point === this.#inspected?.target.point) return;
    this.#inspected = target ? { target, pieces: this.#piecesOf(target.id) } : null;
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
      map.addSource(INSPECT, { type: "geojson", data: collection([]) });
      map.addSource(OVERRIDES, { type: "geojson", data: collection([]) });
      map.addSource(TRADEOFF, { type: "geojson", data: collection([]) });
    } catch {
      return; // the style is still loading: the next styledata / idle event tries again
    }
    const layers = map.getStyle().layers;
    const ridesAt = layers.findIndex((l) => l.id === RIDES_LINE);
    const before = ridesAt >= 0 ? layers[ridesAt + 1]?.id : undefined;
    const round = { "line-cap": "round" as const, "line-join": "round" as const };
    const isKind = (k: string) => ["==", ["get", "kind"], k] as ["==", ["get", string], string];
    // the plan's exceptions under every route line
    map.addLayer(
      {
        id: OVERRIDE_HALO,
        type: "line",
        source: OVERRIDES,
        filter: ["!=", ["get", "kind"], "avoid"],
        layout: round,
        paint: {},
      },
      before,
    );
    map.addLayer(
      {
        id: OVERRIDE_AVOID,
        type: "line",
        source: OVERRIDES,
        filter: isKind("avoid"),
        layout: round,
        paint: {},
      },
      before,
    );
    map.addLayer(
      { id: ALT_CASING, type: "line", source: ALT, filter: isKind("compare"), layout: round, paint: {} },
      before,
    );
    map.addLayer(
      { id: ALT_LINE, type: "line", source: ALT, filter: isKind("compare"), layout: round, paint: {} },
      before,
    );
    // the ghost under the plan's line: it shows only where the two routes part
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
    map.addLayer({ id: MAIN_CASING, type: "line", source: MAIN, layout: round, paint: {} }, before);
    map.addLayer({ id: MAIN_LINE, type: "line", source: MAIN, layout: round, paint: {} }, before);
    map.addLayer({ id: TRADEOFF_LINE, type: "line", source: TRADEOFF, layout: round, paint: {} }, before);
    map.addLayer({ id: INSPECT_RING, type: "line", source: INSPECT, layout: round, paint: {} }, before);
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
    // a ring with a gap: the way (or the route's line) stays readable inside it
    set(INSPECT_RING, "line-color", SELECTED[t]);
    set(INSPECT_RING, "line-width", w(2.5, 3.5));
    set(INSPECT_RING, "line-gap-width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      ["match", ["get", "kind"], "route", 9 * 0.7, 5],
      13,
      ["match", ["get", "kind"], "route", 9, 7],
      17,
      ["match", ["get", "kind"], "route", 13, 14],
    ]);
    set(OVERRIDE_HALO, "line-color", [
      "match",
      ["get", "kind"],
      "prefer",
      OVERRIDE.prefer[t],
      OVERRIDE.allow[t],
    ]);
    set(OVERRIDE_HALO, "line-width", w(7, 12));
    set(OVERRIDE_HALO, "line-opacity", 0.4);
    set(OVERRIDE_AVOID, "line-color", OVERRIDE.avoid[t]);
    set(OVERRIDE_AVOID, "line-width", w(3, 4.5));
    set(OVERRIDE_AVOID, "line-opacity", 0.85);
    set(OVERRIDE_AVOID, "line-dasharray", [0.5, 1.5]);
    // the open trade-off's shortcut: the "allowed" colour, dashed (not allowed yet)
    set(TRADEOFF_LINE, "line-color", OVERRIDE.allow[t]);
    set(TRADEOFF_LINE, "line-width", w(4, 6));
    set(TRADEOFF_LINE, "line-dasharray", [1.2, 1]);
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
    const whyNot = s.whyNot;
    const comparing = !!s.compareId && !whyNot;
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
    // the route toggle: the lines go, the stops stay
    if (ready) {
      const visibility = s.routeHidden ? "none" : "visible";
      for (const id of ROUTE_LINES)
        if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== visibility)
          map.setLayoutProperty(id, "visibility", visibility);
    }
    // ghost / compare / the route without the blocking limit
    const ghostResult = error
      ? (s.blame?.result ?? null)
      : s.changed && !comparing && !whyNot
        ? s.ghost.result
        : null;
    const showGhost = error || (!whyNot && s.moved !== null && s.moved.length > 0);
    const through = whyNot?.line.result ?? null;
    const altKey = [
      ghostResult,
      showGhost,
      comparing ? s.compare.result : null,
      through,
      s.waypoints.length >= 2,
    ];
    if (ready && changed(this.#applied.alt, altKey)) {
      this.#applied.alt = altKey;
      const features =
        s.waypoints.length < 2
          ? []
          : [
              ...(showGhost ? line(ghostResult, "ghost") : []),
              ...(comparing ? line(s.compare.result, "compare") : []),
              ...line(through, "compare"),
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
    // the inspected way (its run once known): around the route's line where the route rides it, else
    // around the way
    const inspected = this.#inspected;
    const run = inspected && s.run?.edge === inspected.target.id ? s.run.result : null;
    const inspectKey = [inspected, s.main.result, run];
    if (ready && changed(this.#applied.inspect, inspectKey)) {
      this.#applied.inspect = inspectKey;
      (map.getSource(INSPECT) as GeoJSONSource).setData(
        collection(
          inspected
            ? inspectFeatures(
                run ? run.edges : [inspected.target.id],
                run && run.coordinates.length >= 2
                  ? [run.coordinates as [number, number][]]
                  : inspected.pieces,
                s.main.result,
              )
            : [],
        ),
      );
    }
    // this plan's exceptions
    if (ready && changed(this.#applied.overrides, [s.overrides])) {
      this.#applied.overrides = [s.overrides];
      (map.getSource(OVERRIDES) as GeoJSONSource).setData(
        collection(
          s.overrides
            .filter((o) => o.line.length >= 2)
            .map((o) => ({
              type: "Feature" as const,
              properties: { kind: o.kind },
              geometry: { type: "LineString" as const, coordinates: o.line },
            })),
        ),
      );
    }
    // the open trade-off's shortcut
    const open = s.tradeoffOpen ? s.tradeoffs.find((t) => tradeoffKey(t) === s.tradeoffOpen) : undefined;
    if (ready && changed(this.#applied.tradeoff, [open])) {
      this.#applied.tradeoff = [open];
      (map.getSource(TRADEOFF) as GeoJSONSource).setData(
        collection(
          open && open.coordinates.length >= 2
            ? [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "LineString", coordinates: open.coordinates as [number, number][] },
                },
              ]
            : [],
        ),
      );
    }
    this.#syncMarkers(s);
    this.#syncTradeoffs(s);
    this.#syncNotes(s);
    this.#syncVia(s);
    // fit once the lines are there (and the chrome has laid out around them)
    const lines = (s.main.result || s.blame?.result) && (!s.compareId || s.compare.result || s.compare.error);
    // "why not through here?": once the comparison is in, show where the two routes part
    const w = s.whyNot;
    if (w?.comparison && s.main.result && w.line.result && this.#fittedAt !== w.at) {
      this.#fittedAt = w.at;
      const box = partedBounds(w.comparison, s.main.result, w.line.result);
      // after the card has laid out (the padding follows its height); only when part of it is out of view
      if (box)
        setTimeout(() => {
          if (!this.#inView(box)) this.#fitBox(box, this.map.getZoom());
        }, 120);
    }
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
    this.#fitBox([w, so, e, n], 16);
  }

  /** Whether a box lies in the part of the map the chrome leaves free. */
  #inView([w, s, e, n]: [number, number, number, number]): boolean {
    const pad = this.#view.padding();
    const { clientWidth: width, clientHeight: height } = this.map.getContainer();
    return [
      [w, s],
      [e, n],
    ].every((c) => {
      const p = this.map.project(c as [number, number]);
      return p.x >= pad.left && p.x <= width - pad.right && p.y >= pad.top && p.y <= height - pad.bottom;
    });
  }

  #fitBox([w, s, e, n]: [number, number, number, number], maxZoom: number) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: this.#view.padding(), maxZoom, duration: reduce ? 0 : 600 },
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
    const show =
      this.#view.notes > 0 &&
      this.#view.plain &&
      !s.compareId &&
      !s.whyNot &&
      !s.main.error &&
      !s.routing &&
      !s.routeHidden;
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

  /** A marker on the route at each trade-off of the plan's limits (tap: its card). */
  #syncTradeoffs(s: PlanState) {
    const show =
      s.waypoints.length >= 2 &&
      !s.main.error &&
      !s.whyNot &&
      !s.compareId &&
      !s.routeHidden &&
      !!s.main.result;
    const list = show ? s.tradeoffs : [];
    const key = [list, s.tradeoffOpen];
    if (!changed(this.#applied.tradeoffs, key)) return;
    this.#applied.tradeoffs = key;
    const seen = new Set<string>();
    for (const t of list) {
      const k = tradeoffKey(t);
      seen.add(k);
      let marker = this.#tradeoffs.get(k);
      if (!marker) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "kp-tradeoff";
        el.dataset.testid = "tradeoff-marker";
        el.setAttribute("aria-label", `${tradeoffSentence(t)} Show the trade-off`);
        el.title = tradeoffSentence(t);
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          const now = this.#store.getSnapshot().tradeoffOpen;
          this.#store.openTradeoff(now === k ? null : k);
        });
        el.addEventListener("contextmenu", (event) => event.stopPropagation());
        marker = new Marker({ element: el }).setLngLat([t.at.lon, t.at.lat]).addTo(this.map);
        this.#tradeoffs.set(k, marker);
      }
      marker.getElement().dataset.open = String(s.tradeoffOpen === k);
    }
    for (const [k, m] of this.#tradeoffs) {
      if (seen.has(k)) continue;
      m.remove();
      this.#tradeoffs.delete(k);
    }
  }

  /** The ring at the point of "why not through here?". */
  #syncVia(s: PlanState) {
    const at = s.whyNot?.at;
    if (!at) {
      this.#via?.remove();
      this.#via = null;
      return;
    }
    if (!this.#via) {
      const el = document.createElement("div");
      el.className = "kp-via";
      el.dataset.testid = "whynot-via";
      this.#via = new Marker({ element: el }).setLngLat([at.lon, at.lat]).addTo(this.map);
    } else this.#via.setLngLat([at.lon, at.lat]);
  }

  destroy() {
    this.#unsubscribe();
    this.#via?.remove();
    this.map.off("styledata", this.#onStyle);
    this.map.off("idle", this.#onStyle);
    this.map.off("click", this.#onClick);
    this.map.off("contextmenu", this.#onContextMenu);
    this.map.off("movestart", this.#onMoveStart);
    this.#press.cancel();
    const surface = this.map.getCanvasContainer();
    surface.removeEventListener("touchstart", this.#onTouchStart);
    surface.removeEventListener("touchmove", this.#onTouchMove);
    surface.removeEventListener("touchend", this.#onTouchEnd);
    surface.removeEventListener("touchcancel", this.#onTouchEnd);
    for (const { marker } of this.#markers.values()) marker.remove();
    for (const m of this.#notes) m.remove();
    for (const m of this.#tradeoffs.values()) m.remove();
    this.#tradeoffs.clear();
    this.#markers.clear();
    if (this.map.getStyle()) {
      for (const id of [
        CURSOR_DOT,
        INSPECT_RING,
        TRADEOFF_LINE,
        GHOST_LINE,
        MAIN_LINE,
        MAIN_CASING,
        ALT_LINE,
        ALT_CASING,
        OVERRIDE_AVOID,
        OVERRIDE_HALO,
      ])
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      for (const id of [MAIN, ALT, CURSOR, INSPECT, OVERRIDES, TRADEOFF])
        if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }
}

/**
 * The ring's features: where the route rides all of the edges (the inspected one, or its run), the
 * route's own vertices of them (the ring then hugs the route's line); else the way's pieces (the run's
 * line, or the tiles' pieces of the edge).
 */
function inspectFeatures(edges: number[], pieces: [number, number][][], r: RouteResult | null): Feature[] {
  const coords = r?.geometry?.coordinates;
  if (r && coords && edges.every((e) => onRoute(e, r.arcs))) {
    const set = new Set(edges);
    const out: Feature[] = [];
    r.arcs.forEach((a, i) => {
      if (!set.has(a >> 1)) return;
      const from = r.arc_vertex[i] ?? 0;
      const to = r.arc_vertex[i + 1] ?? coords.length - 1;
      const line = coords.slice(from, to + 1);
      if (line.length >= 2)
        out.push({
          type: "Feature",
          properties: { kind: "route" },
          geometry: { type: "LineString", coordinates: line },
        });
    });
    if (out.length > 0) return out;
  }
  return pieces
    .filter((p) => p.length >= 2)
    .map((coordinates) => ({
      type: "Feature" as const,
      properties: { kind: "way" },
      geometry: { type: "LineString" as const, coordinates },
    }));
}

/** Whether a key (a short array of values compared by identity) differs from the last one. */
function changed(last: unknown, next: unknown[]): boolean {
  if (!Array.isArray(last) || last.length !== next.length) return true;
  return next.some((v, i) => !Object.is(v, last[i]));
}
