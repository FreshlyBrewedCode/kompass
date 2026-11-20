import { pointAtKm } from "@/mock/data";
import { notes } from "@/round2/model";
import { type MapRoute, MapView, STYLES } from "@/shared/MapView";
import type { Theme } from "@/shared/usePlanner";
import { CASING, FOREST, GHOST, OUTDOOR, RIDDEN, ROUTE, ROUTE_ALT, SEQ, UNKNOWN, surfaceColor, wayColor } from "./palette";
import type { Plan } from "./state";

export interface Pad { top: number; bottom: number; left: number; right: number }

const cls = ["get", "class"];
const trackPath = ["match", cls, ["track", "path"], true, false];
const FAINT = "rgba(150,150,150,0.25)";

/** MapLibre colour for the attribute layer, in the data palette. The cost view reads the live profile. */
function layerColor(p: Plan, theme: Theme): unknown {
  const seq = SEQ[theme] as [string, string, string, string, string];
  const grey = UNKNOWN[theme];
  if (p.dbg === "surface") return ["case", ["==", ["get", "surface"], "paved"], surfaceColor("paved", theme), ["==", ["get", "surface"], "unpaved"], surfaceColor("gravel", theme), trackPath, grey, surfaceColor("paved", theme)];
  if (p.dbg === "road")
    return ["case", ["all", ["==", cls, "path"], ["==", ["get", "subclass"], "cycleway"]], wayColor("cycleway", theme),
      ["match", cls, ["motorway", "trunk", "primary", "secondary"], wayColor("main", theme), "tertiary", wayColor("minor", theme), "track", wayColor("track", theme), "path", wayColor("path", theme), wayColor("quiet", theme)]];
  if (p.dbg === "traffic") return ["match", cls, ["motorway", "trunk", "primary"], seq[4], "secondary", seq[3], "tertiary", seq[2], ["minor", "service"], seq[1], seq[0]];
  if (p.dbg === "trail") return ["case", ["has", "mtb_scale"], ["match", ["slice", ["to-string", ["get", "mtb_scale"]], 0, 1], "0", seq[0], "1", seq[1], "2", seq[2], seq[3]], trackPath, grey, FAINT];
  // cost: a toy version of the engine's per-edge factor, enough to react to the sliders
  const step = (v: number) => seq[Math.max(0, Math.min(3, Math.round(1.5 - v / 55)))] as string;
  const gravel = p.prefs.unpaved ?? 0;
  const quiet = (p.prefs.quiet ?? 0) - (p.prefs.main ?? 0) * 0.5;
  return ["case", ["match", cls, ["motorway", "trunk", "primary", "secondary"], true, false], "noMain" in p.limits ? grey : step(-40 - quiet * 0.6),
    ["==", cls, "tertiary"], step(-quiet * 0.7),
    ["all", ["==", cls, "path"], ["==", ["get", "subclass"], "cycleway"]], step(p.prefs.cycleway_sep ?? 0),
    ["==", ["get", "surface"], "unpaved"], "pavedOnly" in p.limits ? grey : step(gravel),
    trackPath, "noUnknown" in p.limits ? grey : step(gravel * 0.5),
    step(quiet * 0.3 - gravel * 0.3)];
}
const layerKey = (p: Plan) => (p.dbg === "cost" ? `cost:${p.prefs.unpaved}:${p.prefs.quiet}:${p.prefs.main}:${p.prefs.cycleway_sep}:${Object.keys(p.limits)}` : p.dbg);

/**
 * The map of the planner. What is drawn on it, and in which colour:
 * - the route: one vermilion line with a rim (or by surface, a switch in the layers control);
 * - the base profile's route as a dashed ink ghost while the tweaks differ from it;
 * - a second profile's route in blue while comparing;
 * - "why this way" notes, neutral; waypoints, ink.
 * No route in the empty and download states; in the error state only the ghost (the route without the limit).
 */
export function PlanMap({ p, theme, pad, attribBottom = 0, maxNotes = 2, wide }: { p: Plan; theme: Theme; pad: Pad; attribBottom?: number; maxNotes?: number; wide?: boolean }) {
  const plain = p.layer === "normal";
  const none = p.status === "empty" || p.status === "download";
  const ghost = (id: string, route: typeof p.route): MapRoute => ({ id, route, color: GHOST[theme], width: 2.5, dashed: true, opacity: 0.75 });
  const routes: MapRoute[] = [];
  if (p.status === "error") routes.push(ghost(`lost-${p.baseRoute.id}`, p.baseRoute));
  else if (!none) {
    const bySurface = p.lineBy === "surface" && plain && !p.compareRoute;
    routes.push({ id: `live-${p.route.id}`, route: p.route, color: ROUTE[theme], casing: CASING[theme], width: 5, opacity: p.status === "busy" ? 0.45 : 1, colorBy: bySurface ? "surface" : "solid", segColor: bySurface ? (s) => surfaceColor(s.surface, theme) : undefined });
    if (p.compareRoute) routes.push({ id: `cmp-${p.compareRoute.id}`, route: p.compareRoute, color: ROUTE_ALT[theme], casing: CASING[theme], width: 4 });
    else if (p.moved && plain) routes.push(ghost(`ghost-${p.baseRoute.id}`, p.baseRoute));
  }
  const lngs = p.route.coords.map((c) => c[0]);
  const mid = Math.min(...lngs) + (Math.max(...lngs) - Math.min(...lngs)) * 0.6;
  const callouts = p.compareRoute || !plain || p.status !== "ready" ? [] : notes(p.route).slice(0, maxNotes).map((n) => {
    const lngLat = pointAtKm(p.route, n.km);
    return { lngLat, flip: lngLat[0] > mid, html: wide ? `<b>${n.title}</b>${n.text}` : `<b>${n.short}</b>` };
  });
  return (
    <MapView
      theme={theme} styles={{ light: STYLES.positron, dark: STYLES.dark }} outdoor={OUTDOOR} forest={FOREST}
      routes={routes} waypoints={none ? [] : p.waypoints} layer={p.layer} attr="surface" colorExpr={layerColor(p, theme)} colorKey={`${layerKey(p)}:${theme}`}
      explored={{ ridden: theme === "dark" ? ["#1f8f86", RIDDEN.dark] : ["#5cc4bb", RIDDEN.light], rest: null }}
      fitKey={`fit:${p.compare?.id ?? ""}:${p.base.id}:${p.status === "error"}:${none}`} cursor={p.cursor} padding={pad} callouts={callouts} attribBottom={attribBottom}
      onMapClick={() => p.status === "empty" && p.setStatus("ready")} className="absolute inset-0 isolate"
    />
  );
}
