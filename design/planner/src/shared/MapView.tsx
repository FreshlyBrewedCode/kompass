import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef } from "react";
import { HISTORY, NOVEL_COLOR, type LngLat, type Profile, type RouteData, type Waypoint, roadColor, surfaceColor } from "@/mock/data";
import { attrColor } from "./attrs";
import type { AttrKey, LayerMode, Theme } from "./usePlanner";

export interface MapRoute {
  id: string;
  route: RouteData;
  color: string;
  width?: number;
  opacity?: number;
  dashed?: boolean;
  colorBy?: "solid" | "surface" | "road" | "novel";
}
export interface Callout {
  lngLat: LngLat;
  node: (el: HTMLElement) => void;
}
interface Pad {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
interface Props {
  theme: Theme;
  styles?: { light: string; dark: string };
  routes: MapRoute[];
  waypoints: Waypoint[];
  layer: LayerMode;
  attr: AttrKey;
  profile?: Profile;
  padding: Pad;
  callouts?: { lngLat: LngLat; html: string; flip?: boolean }[];
  /** Round 2: a ready colour expression for the attribute map, instead of `attr` + `profile`. */
  colorExpr?: unknown;
  colorKey?: string;
  /** Round 2: refit only when this changes (not on every reroute while a slider is dragged). */
  fitKey?: string;
  /** Round 2: a dot on the route, driven by scrubbing the timeline. */
  cursor?: LngLat | null;
  /** Tint for woodland, drawn under the roads. Gives the grey base styles some outdoors. */
  forest?: { light?: string; dark?: string };
  /** Lift the attribution above a bottom panel (px). */
  attribBottom?: number;
  className?: string;
}

type GJ = maplibregl.GeoJSONSourceSpecification["data"];
maplibregl.setWorkerUrl(workerUrl);
const OFM = "https://tiles.openfreemap.org";
export const STYLES = {
  liberty: `${OFM}/styles/liberty`,
  bright: `${OFM}/styles/bright`,
  positron: `${OFM}/styles/positron`,
  dark: `${OFM}/styles/dark`,
  fiord: `${OFM}/styles/fiord`,
};
const SKIP = ["rail", "ferry", "transit", "aerialway", "pier", "bridge", "raceway"];

function routeGeoJSON(r: MapRoute) {
  if (!r.colorBy || r.colorBy === "solid")
    return { type: "FeatureCollection", features: [{ type: "Feature", properties: { c: r.color }, geometry: { type: "LineString", coordinates: r.route.coords } }] };
  return {
    type: "FeatureCollection",
    features: r.route.segs.map((s) => ({
      type: "Feature",
      properties: { c: r.colorBy === "surface" ? surfaceColor(s.surface) : r.colorBy === "road" ? roadColor(s.road) : s.novel ? NOVEL_COLOR.novel : NOVEL_COLOR.ridden },
      geometry: { type: "LineString", coordinates: r.route.coords.slice(s.i0, s.i1 + 1) },
    })),
  };
}

export function MapView({ theme, styles = { light: STYLES.liberty, dark: STYLES.dark }, routes, waypoints, layer, attr, profile, padding, callouts, forest, attribBottom = 0, className, colorExpr, colorKey, fitKey, cursor }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const props = useRef({ routes, layer, attr, profile, theme, padding, forest, colorExpr });
  props.current = { routes, layer, attr, profile, theme, padding, forest, colorExpr };

  const fit = (animate: boolean) => {
    const map = mapRef.current;
    const main = props.current.routes[0];
    if (!map || !main) return;
    const b = new maplibregl.LngLatBounds();
    for (const r of props.current.routes) for (const c of r.route.coords) b.extend(c);
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const p = props.current.padding;
    // never let the padding eat the whole map
    const k = Math.min(1, (w - 60) / (p.left + p.right || 1), (h - 60) / (p.top + p.bottom || 1));
    map.fitBounds(b, { padding: { top: p.top * k, bottom: p.bottom * k, left: p.left * k, right: p.right * k }, animate, duration: 500 });
  };

  const apply = () => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { routes, layer, attr, profile, theme } = props.current;
    for (const l of map.getStyle().layers) if (l.id.startsWith("k-")) map.removeLayer(l.id);
    for (const s of Object.keys(map.getStyle().sources)) if (s.startsWith("k-")) map.removeSource(s);
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    const dark = theme === "dark";
    const forest = props.current.forest?.[theme];
    if (forest) {
      const firstLine = map.getStyle().layers.find((l) => l.type === "line")?.id;
      map.addLayer({ id: "k-forest", type: "fill", source: "openmaptiles", "source-layer": "landcover", filter: ["==", ["get", "class"], "wood"], paint: { "fill-color": forest, "fill-opacity": dark ? 0.5 : 0.55, "fill-antialias": false } }, firstLine);
    }
    if (dark)
      for (const l of map.getStyle().layers) {
        // the stock dark style is nearly black on black: lift roads and water a little
        const sl = (l as { "source-layer"?: string })["source-layer"];
        if (l.type === "line" && sl === "transportation" && !l.id.includes("casing") && !l.id.includes("rail")) map.setPaintProperty(l.id, "line-color", "#4a5058");
        if (l.type === "fill" && sl === "water") map.setPaintProperty(l.id, "fill-color", "#1b2f42");
        if (l.type === "line" && sl === "waterway") map.setPaintProperty(l.id, "line-color", "#27435c");
      }

    if (layer !== "normal") {
      map.addLayer({ id: "k-wash", type: "background", paint: { "background-color": dark ? "#0b0d0e" : "#f6f4ef", "background-opacity": dark ? 0.72 : 0.62 } }, firstSymbol);
      const width = ["interpolate", ["linear"], ["zoom"], 10, 0.8, 13, 1.8, 16, 4] as maplibregl.ExpressionSpecification;
      const filter = ["match", ["get", "class"], SKIP, false, true] as maplibregl.FilterSpecification;
      if (layer === "debug") {
        map.addLayer({ id: "k-edges-line", type: "line", source: "openmaptiles", "source-layer": "transportation", filter, layout: { "line-cap": "round" }, paint: { "line-color": (props.current.colorExpr ?? attrColor(attr, profile as Profile)) as maplibregl.ExpressionSpecification, "line-width": width } }, firstSymbol);
      } else {
        map.addLayer({ id: "k-edges-line", type: "line", source: "openmaptiles", "source-layer": "transportation", filter, paint: { "line-color": dark ? "#d9a441" : "#c98a1b", "line-opacity": 0.8, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 13, 1.1, 16, 2.2] } }, firstSymbol);
        map.addSource("k-hist", { type: "geojson", data: { type: "FeatureCollection", features: HISTORY.map((h) => ({ type: "Feature", properties: { count: h.count }, geometry: { type: "LineString", coordinates: h.coords } })) } as unknown as GJ });
        map.addLayer({ id: "k-hist-line", type: "line", source: "k-hist", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["interpolate", ["linear"], ["get", "count"], 1, dark ? "#7fd3c6" : "#5bbfae", 9, dark ? "#e9fff9" : "#0b6b5d"], "line-width": ["interpolate", ["linear"], ["get", "count"], 1, 2.5, 9, 5.5], "line-opacity": 0.95 } }, firstSymbol);
      }
    }
    const thin = layer !== "normal";
    for (const r of [...routes].reverse()) {
      const src = `k-route-${r.id}`;
      map.addSource(src, { type: "geojson", data: routeGeoJSON(r) as unknown as GJ });
      const w = (r.width ?? 5) * (thin ? 0.55 : 1);
      const layout = { "line-cap": "round", "line-join": "round" } as const;
      if (!r.dashed)
        map.addLayer({ id: `${src}-case`, type: "line", source: src, layout, paint: { "line-color": dark ? "#0c0e10" : "#ffffff", "line-width": w + 3.5, "line-opacity": (r.opacity ?? 1) * 0.9 } });
      map.addLayer({ id: `${src}-line`, type: "line", source: src, layout: r.dashed ? { "line-join": "round" } : layout, paint: { "line-color": ["get", "c"], "line-width": w, "line-opacity": r.opacity ?? 1, ...(r.dashed ? { "line-dasharray": [1.6, 1.2] } : {}) } });
    }
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const fitRef = useRef(fit);
  fitRef.current = fit;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the map is created once
  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({ container: el.current, style: styles[theme], center: [8.05, 47.97], zoom: 11, attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true } });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    mapRef.current = map;
    (window as unknown as { __kompassMap?: maplibregl.Map }).__kompassMap = map;
    map.on("style.load", () => {
      ready.current = true;
      applyRef.current();
    });
    const collapse = () => el.current?.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    map.once("load", collapse);
    collapse();
    if (props.current.layer === "normal") fitRef.current(false);
    let t = 0;
    const ro = new ResizeObserver(() => {
      map.resize();
      window.clearTimeout(t);
      t = window.setTimeout(() => props.current.layer === "normal" && fitRef.current(false), 80);
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      ready.current = false;
    };
  }, []);

  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: style swap only on theme change
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ready.current = false;
    mapRef.current?.setStyle(styles[theme]);
  }, [theme]);

  const routeKey = routes.map((r) => `${r.id}:${r.color}:${r.width}:${r.opacity}:${r.dashed}:${r.colorBy}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed
  useEffect(() => apply(), [routeKey, layer, attr, profile, colorKey, forest?.light, forest?.dark]);

  const padKey = `${padding.top},${padding.bottom},${padding.left},${padding.right}|${fitKey ?? routes.map((r) => r.id).join()}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed
  useEffect(() => {
    if (layer === "normal") fit(true);
  }, [padKey]);

  // Tracks and paths only exist in the base tiles from zoom 13 on, so the edge views open zoomed in.
  const firstLayer = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mode change
  useEffect(() => {
    const map = mapRef.current;
    const main = routes[0]?.route;
    if (!map || !main) return;
    const initial = firstLayer.current;
    firstLayer.current = false;
    if (layer === "normal") {
      if (!initial) fit(true);
      return;
    }
    if (map.getZoom() >= 13 && !initial) return;
    const c = main.coords[Math.round(main.coords.length * 0.34)] as LngLat;
    const p = props.current.padding;
    map.easeTo({ center: c, zoom: 13.4, padding: { top: Math.min(p.top, 120), bottom: Math.min(p.bottom, map.getContainer().clientHeight * 0.55), left: Math.min(p.left, 400), right: Math.min(p.right, 400) }, duration: initial ? 0 : 600 });
  }, [layer]);

  const calloutKey = (callouts ?? []).map((c) => `${c.html}${c.lngLat}${c.flip}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of markers.current) m.remove();
    markers.current = [];
    for (const c of callouts ?? []) {
      const d = document.createElement("div");
      d.className = c.flip ? "kcallout kcallout-flip" : "kcallout";
      d.innerHTML = c.html;
      markers.current.push(new maplibregl.Marker({ element: d, anchor: c.flip ? "bottom-right" : "bottom-left", offset: c.flip ? [-6, -6] : [6, -6] }).setLngLat(c.lngLat).addTo(map));
    }
    waypoints.forEach((w, i) => {
      const d = document.createElement("div");
      const kind = i === 0 ? "start" : i === waypoints.length - 1 ? "end" : "via";
      d.className = "kmarker";
      d.dataset.kind = kind;
      d.textContent = kind === "start" ? "A" : kind === "end" ? "B" : String(i);
      markers.current.push(new maplibregl.Marker({ element: d }).setLngLat(w.lngLat).addTo(map));
    });
  }, [waypoints, calloutKey]);

  const cursorMarker = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!cursor) {
      cursorMarker.current?.remove();
      cursorMarker.current = null;
      return;
    }
    if (!cursorMarker.current) {
      const d = document.createElement("div");
      d.className = "kcursor";
      cursorMarker.current = new maplibregl.Marker({ element: d }).setLngLat(cursor).addTo(map);
    } else cursorMarker.current.setLngLat(cursor);
  }, [cursor]);

  // MapLibre makes its container position:relative, so the positioned box is a wrapper
  return (
    <div className={className} style={{ "--attrib-bottom": `${attribBottom}px` } as React.CSSProperties}>
      <div ref={el} className="size-full" />
    </div>
  );
}
