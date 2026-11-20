import type { RoadKey, SurfaceKey } from "@/mock/data";
import type { Outdoor } from "@/shared/MapView";
import type { Theme } from "@/shared/usePlanner";

/**
 * Round 3: the colours of DATA. Everything coloured in the planner is one of these; the chrome is
 * neutral (tokens.css). They are picked against the real map's outdoor style (web/src/map/carto.ts:
 * green forest, pale fields, white-to-yellow roads, brown dashed tracks, violet cycling) and reuse
 * web/src/map/palette.ts where that already has a colour (explored teal, unknown grey, viridis).
 */
type Pair = Record<Theme, string>;

/** The planned route: vermilion, the one hue the map keeps free. Also the chrome's accent. */
export const ROUTE: Pair = { light: "#d23f18", dark: "#ff7a57" };
/** The second route of a comparison: Okabe–Ito blue, darker than any water on the map. */
export const ROUTE_ALT: Pair = { light: "#0072b2", dark: "#56b4e9" };
/** The rim under a route line. */
export const CASING: Pair = { light: "#ffffff", dark: "#0c0e0d" };
/** The base profile's route while the tweaks differ from it: ink, dashed. Neutral on purpose. */
export const GHOST: Pair = { light: "#161816", dark: "#f0f1ed" };

/** Surface, from firm to soft: slate, ochre, brown; unknown is the map palette's grey (hatched in lanes). */
export const SURFACE: { key: SurfaceKey; label: string; color: Pair }[] = [
  { key: "paved", label: "Paved", color: { light: "#5d6b7c", dark: "#93a3b8" } },
  { key: "gravel", label: "Gravel", color: { light: "#c98a1e", dark: "#e3ab45" } },
  { key: "dirt", label: "Dirt & grass", color: { light: "#8f5630", dark: "#b9794d" } },
  { key: "unknown", label: "Unknown", color: { light: "#a3a3a3", dark: "#8f8f98" } },
];
/** Way type, from car-free to busy: two greens, the map's cycling violet, grey, the map's road yellow, maroon. */
export const WAY: { key: RoadKey; label: string; color: Pair }[] = [
  { key: "path", label: "Path", color: { light: "#1f7a5c", dark: "#4fb891" } },
  { key: "track", label: "Forest track", color: { light: "#86a845", dark: "#a9c865" } },
  { key: "cycleway", label: "Bike path", color: { light: "#6f5df0", dark: "#a59cff" } },
  { key: "quiet", label: "Quiet street", color: { light: "#a8aeb6", dark: "#7d858e" } },
  { key: "minor", label: "Minor road", color: { light: "#dcae2f", dark: "#e6c456" } },
  { key: "main", label: "Main road", color: { light: "#8e2f3c", dark: "#d0677a" } },
];
/** Ridden before: the explored map's teal. Never ridden has no colour, as on the explored map. */
export const RIDDEN: Pair = { light: "#0a8f86", dark: "#35d0c0" };
export const UNKNOWN: Pair = { light: "#a3a3a3", dark: "#8f8f98" };
/** Ordered values (traffic, trail difficulty, cost): viridis, five steps, the end that would vanish on the map dropped. */
export const SEQ: Record<Theme, string[]> = {
  light: ["#7ad151", "#22a884", "#2a788e", "#414487", "#440154"],
  dark: ["#3b528b", "#21918c", "#5ec962", "#addc30", "#fde725"],
};

export const surfaceColor = (k: SurfaceKey, theme: Theme) => SURFACE.find((s) => s.key === k)?.color[theme] ?? UNKNOWN[theme];
export const wayColor = (k: RoadKey, theme: Theme) => WAY.find((s) => s.key === k)?.color[theme] ?? UNKNOWN[theme];

/** The data colours as CSS variables, set on the root of the planner so lanes and legends can use them. */
export function dataVars(theme: Theme): Record<string, string> {
  return {
    "--route": ROUTE[theme], "--route-alt": ROUTE_ALT[theme], "--route-casing": CASING[theme], "--ridden": RIDDEN[theme], "--unknown": UNKNOWN[theme],
    ...Object.fromEntries(SURFACE.map((s) => [`--surface-${s.key}`, s.color[theme]])),
    ...Object.fromEntries(WAY.map((s) => [`--way-${s.key}`, s.color[theme]])),
  };
}

/** The sandbox map repainted in the real outdoor style's colours (a subset of carto.ts), to judge the data colours on it. */
export const OUTDOOR: Record<Theme, Outdoor> = {
  light: { land: "#f4f2eb", water: "#a8d4f0", waterway: "#86c0e6", road: "#ffffff", roadCasing: "#a39c8f", primary: "#fbdc8e", secondary: "#fdf0b8", track: "#7d5632" },
  dark: { land: "#1b1e1c", water: "#17344c", waterway: "#21486a", road: "#565a5b", roadCasing: "#0e100f", primary: "#8f7a44", secondary: "#746a48", track: "#d0a878" },
};
export const FOREST: Pair = { light: "#c3dfb1", dark: "#1f3324" };
