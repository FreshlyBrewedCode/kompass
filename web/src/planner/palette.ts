// The colours of DATA in the planner (docs/design/planner.md, "Data"): route, compared route, ghost,
// surface, way type, ridden. Not theme tokens: picked against the outdoor map like src/map/palette.ts
// (whose explored teal and unknown grey they reuse). The chrome stays neutral (index.css); this is
// the only colour on screen, and the same colour means the same thing on the map, in a lane and in a
// legend. `dataVars(theme)` hands them to the chrome as CSS variables.
import type { BoardRow, OverrideKind } from "@/engine/generated/types";
import type { Theme } from "@/map/palette";
import { EXPLORED, UNKNOWN } from "@/map/palette";
import type { SurfaceGroup, WayGroup } from "./model";

type Pair = Record<Theme, string>;

/** The planned route: vermilion, the one hue the map keeps free. Also the chrome's accent. */
export const ROUTE: Pair = { light: "#d23f18", dark: "#ff7a57" };
/** The second route of a comparison: Okabe–Ito blue, darker than any water on the map. */
export const ROUTE_ALT: Pair = { light: "#0072b2", dark: "#56b4e9" };
/** The rim under a route line. */
export const ROUTE_CASING: Pair = { light: "#ffffff", dark: "#0c0e0d" };
/** The base profile's route while the changes move it: ink, dashed. */
export const GHOST: Pair = { light: "#161816", dark: "#f0f1ed" };

export const SURFACE: { key: SurfaceGroup; label: string; color: Pair }[] = [
  { key: "paved", label: "Paved", color: { light: "#5d6b7c", dark: "#93a3b8" } },
  { key: "gravel", label: "Gravel", color: { light: "#c98a1e", dark: "#e3ab45" } },
  { key: "dirt", label: "Dirt & grass", color: { light: "#8f5630", dark: "#b9794d" } },
  { key: "unknown", label: "Unknown", color: UNKNOWN },
];
export const WAY: { key: WayGroup; label: string; color: Pair }[] = [
  { key: "path", label: "Path", color: { light: "#1f7a5c", dark: "#4fb891" } },
  { key: "track", label: "Track", color: { light: "#86a845", dark: "#a9c865" } },
  { key: "cycleway", label: "Bike path", color: { light: "#6f5df0", dark: "#a59cff" } },
  { key: "quiet", label: "Quiet street", color: { light: "#a8aeb6", dark: "#7d858e" } },
  { key: "minor", label: "Minor road", color: { light: "#dcae2f", dark: "#e6c456" } },
  { key: "main", label: "Main road", color: { light: "#8e2f3c", dark: "#d0677a" } },
];
/**
 * The rows of the tier boards (structured controls, #66): the same hues as the surface and way-type
 * colours above, a lighter shade for the row next to its sibling (gravel next to compacted).
 */
export const ROW: Record<BoardRow, Pair> = {
  paved: { light: "#5d6b7c", dark: "#93a3b8" },
  rough_paved: { light: "#8d97a4", dark: "#6c7785" },
  compacted: { light: "#c98a1e", dark: "#e3ab45" },
  gravel: { light: "#e2b45e", dark: "#b8862e" },
  soft: { light: "#8f5630", dark: "#b9794d" },
  unknown: UNKNOWN,
  main: { light: "#8e2f3c", dark: "#d0677a" },
  country_road: { light: "#dcae2f", dark: "#e6c456" },
  residential: { light: "#a8aeb6", dark: "#7d858e" },
  service: { light: "#c9cdd2", dark: "#5c636b" },
  track: { light: "#86a845", dark: "#a9c865" },
  path: { light: "#1f7a5c", dark: "#4fb891" },
  cycle_path: { light: "#6f5df0", dark: "#a59cff" },
  cycle_path_roadside: { light: "#a59cff", dark: "#7d70e0" },
};
export const RIDDEN: Pair = EXPLORED;
/**
 * This plan's exceptions, a quiet mark under the route: avoided in ink (dotted on the map), preferred
 * in Okabe–Ito bluish green, allowed in its reddish purple (soft halos on the map).
 */
export const OVERRIDE: Record<OverrideKind, Pair> = {
  avoid: GHOST,
  prefer: { light: "#009e73", dark: "#3cc99c" },
  allow: { light: "#cc79a7", dark: "#e3a2c8" },
};

export const surfaceColor = (k: SurfaceGroup, theme: Theme) =>
  SURFACE.find((s) => s.key === k)?.color[theme] ?? UNKNOWN[theme];

/** The data colours as CSS variables, set on the planner's root so lanes and legends can use them. */
export function dataVars(theme: Theme): Record<string, string> {
  return {
    "--route": ROUTE[theme],
    "--route-alt": ROUTE_ALT[theme],
    "--route-casing": ROUTE_CASING[theme],
    "--ghost": GHOST[theme],
    "--ridden": RIDDEN[theme],
    "--unknown": UNKNOWN[theme],
    ...Object.fromEntries(Object.entries(OVERRIDE).map(([k, c]) => [`--override-${k}`, c[theme]])),
    ...Object.fromEntries(SURFACE.map((s) => [`--surface-${s.key}`, s.color[theme]])),
    ...Object.fromEntries(WAY.map((s) => [`--way-${s.key}`, s.color[theme]])),
    ...Object.fromEntries(Object.entries(ROW).map(([k, c]) => [`--row-${k}`, c[theme]])),
  };
}
