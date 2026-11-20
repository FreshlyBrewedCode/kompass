// Map style round 2 (issue #37): the key of a variant, `?mapkey=a|b|c|d`. PROTOTYPE.
// The sample lines are drawn by MapLibre with the variant's own layers (a GeoJSON source instead of
// the overlay tiles), at one zoom: what the key shows is what the map draws.
import "maplibre-gl/dist/maplibre-gl.css";
import { type LayerSpecification, Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { OverlayAttribute } from "../manifest";
import type { Theme } from "../palette";
import { loadRegion, resolveDataUrl } from "../region";
import { routeLayer } from "../ways";
import { classes, specLayers } from "./shared";
import { type VariantId, variant } from "./variants";

type Row = { label: string; note?: string; props: Record<string, string> } | { heading: string };

const paved = { surface_class: "paved_smooth" };
const ROWS: Row[] = [
  { heading: "Roads" },
  { label: "Main road", note: "trunk, primary", props: { highway: "primary", ...paved } },
  { label: "Secondary road", props: { highway: "secondary", ...paved } },
  { label: "Tertiary road", props: { highway: "tertiary", ...paved } },
  { label: "Minor road", note: "unclassified", props: { highway: "unclassified", ...paved } },
  { label: "Street", note: "residential", props: { highway: "residential", ...paved } },
  { label: "Service road", props: { highway: "service", ...paved } },
  { label: "Minor road, unpaved", props: { highway: "unclassified", surface_class: "gravel" } },
  { heading: "Tracks" },
  { label: "Grade 1", note: "paved", props: { highway: "track", tracktype: "grade1", ...paved } },
  {
    label: "Grade 2",
    note: "compacted",
    props: { highway: "track", tracktype: "grade2", surface_class: "compacted" },
  },
  {
    label: "Grade 3",
    note: "gravel",
    props: { highway: "track", tracktype: "grade3", surface_class: "gravel" },
  },
  {
    label: "Grade 4",
    note: "mostly soft",
    props: { highway: "track", tracktype: "grade4", surface_class: "soft" },
  },
  {
    label: "Grade 5",
    note: "soft ground",
    props: { highway: "track", tracktype: "grade5", surface_class: "soft" },
  },
  { label: "Unknown", note: "nothing mapped", props: { highway: "track" } },
  { heading: "Paths" },
  { label: "Cycle path", props: { highway: "cycleway", ...paved } },
  { label: "Path, paved", props: { highway: "path", ...paved } },
  { label: "Path, gravel", props: { highway: "path", surface_class: "gravel" } },
  { label: "Path, ground", props: { highway: "path", surface_class: "soft" } },
  { label: "Path, unknown", props: { highway: "path" } },
  { heading: "Also" },
  {
    label: "No bicycle access",
    note: "private",
    props: { highway: "track", tracktype: "grade2", surface_class: "compacted", bike_access: "private" },
  },
  {
    label: "Signed cycle route",
    note: "violet",
    props: { highway: "track", tracktype: "grade2", surface_class: "compacted", route_level: "rcn" },
  },
];

const ROW = 30;
const HEAD = 34;
const WIDTH = 390;
const LINE_FROM = 16;
const LINE_TO = 150;
const ZOOM = 14;

export async function renderKey(id: VariantId, root: HTMLElement) {
  const theme: Theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const region = await loadRegion(resolveDataUrl(location.search, document.baseURI));
  if (region.status !== "ready") throw new Error("the key needs a region manifest (its enum codes)");
  const attributes: readonly OverlayAttribute[] = region.manifest.overlay.attributes;
  const code = (key: string, label: string) => {
    const a = attributes.find((x) => x.key === key);
    return a?.kind === "enum" ? (a.values.find((v) => v.label === label)?.value ?? 0) : 0;
  };
  const v = variant(id, theme);
  const k = classes(attributes);
  const drawn = specLayers(v.spec(k), k, { source: "key" });
  const band = routeLayer(attributes, { source: "key", sourceLayer: "", colors: v.carto, routes: true });
  const {
    "source-layer": _dropped,
    minzoom: _zoom,
    ...route
  } = band as LayerSpecification & {
    "source-layer"?: string;
  };

  let y = 44;
  const places = ROWS.map((row) => {
    const top = y;
    y += "heading" in row ? HEAD : ROW;
    return { row, top };
  });
  const height = y + 12;
  const ink = theme === "light" ? "#161816" : "#f0f1ed";
  root.innerHTML = "";
  const card = document.createElement("div");
  card.dataset.testid = "map-key";
  card.style.cssText = `position:relative;width:${WIDTH}px;height:${height}px;overflow:hidden;color:${ink};font:14px/1.2 system-ui,sans-serif;background:${v.carto.land}`;
  const canvas = document.createElement("div");
  canvas.style.cssText = "position:absolute;inset:0";
  card.append(canvas);
  root.append(card);

  setWorkerUrl(workerUrl);
  const map = new MapLibreMap({
    container: canvas,
    center: [0, 0],
    zoom: ZOOM,
    interactive: false,
    attributionControl: false,
    style: { version: 8, sources: {}, layers: [] },
  });
  await new Promise((resolve) => map.once("load", resolve));
  const at = (x: number, py: number) => map.unproject([x, py]).toArray();
  const mid = (LINE_FROM + LINE_TO) / 2;
  const features = places.flatMap(({ row, top }) => {
    if ("heading" in row) return [];
    const cy = top + ROW / 2;
    const properties = Object.fromEntries(
      Object.entries(row.props).map(([key, label]) => [key, code(key, label)]),
    );
    // a shallow S: joins and dashes show as they do on a real way
    const coordinates = [];
    for (let x = LINE_FROM; x <= LINE_TO; x += 4) {
      const t = (x - LINE_FROM) / (LINE_TO - LINE_FROM);
      coordinates.push(at(x, cy + Math.sin(t * Math.PI * 2) * 4));
    }
    return [{ type: "Feature" as const, properties, geometry: { type: "LineString" as const, coordinates } }];
  });
  const forest = {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [at(mid, 36), at(LINE_TO + 8, 36), at(LINE_TO + 8, height), at(mid, height), at(mid, 36)],
      ],
    },
  };
  map.setStyle({
    version: 8,
    sources: {
      key: { type: "geojson", data: { type: "FeatureCollection", features } },
      forest: { type: "geojson", data: forest },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": v.carto.land } },
      { id: "forest", type: "fill", source: "forest", paint: { "fill-color": v.carto.forest } },
      route as LayerSpecification,
      ...drawn.under,
      ...drawn.over,
    ],
  });

  const text = (css: string, html: string) => {
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;${css}`;
    el.innerHTML = html;
    card.append(el);
  };
  text(
    "left:16px;top:12px;font-weight:650;font-size:15px",
    `${id.toUpperCase()} · ${v.name} <span style="font-weight:400;opacity:.6">· key, as drawn at zoom ${ZOOM}</span>`,
  );
  for (const { row, top } of places) {
    if ("heading" in row) {
      text(
        `left:16px;top:${top + 12}px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6`,
        row.heading,
      );
    } else {
      text(
        `left:${LINE_TO + 22}px;top:${top + 7}px;white-space:nowrap`,
        `${row.label}${row.note ? ` <span style="opacity:.6">· ${row.note}</span>` : ""}`,
      );
    }
  }
  await new Promise((resolve) => map.once("idle", resolve));
  card.dataset.ready = "true";
}
