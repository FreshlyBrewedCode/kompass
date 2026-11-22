// Colours of what the app draws on top of the map (information layers, explored, rides, selection).
// The map's own colours are in `carto.ts`. Neither are theme tokens: they must stay readable on the map
// in both themes and for colour-blind users, so they are picked and checked here.
// Everything else in the app uses the theme tokens of `index.css`.

export type Theme = "light" | "dark";

/** Categorical hues: the Okabe–Ito set (colour-blind safe), black swapped for a violet. At most 8. */
export const CATEGORICAL = [
  "#0072b2", // blue
  "#d55e00", // vermilion
  "#009e73", // bluish green
  "#e69f00", // orange
  "#56b4e9", // sky blue
  "#cc79a7", // reddish purple
  "#f0e442", // yellow
  "#8e6bbf", // violet
] as const;

/** Viridis in 9 steps (perceptually uniform, colour-blind safe, monotone in lightness). */
const VIRIDIS = [
  "#440154",
  "#472d7b",
  "#3b528b",
  "#2c728e",
  "#21918c",
  "#28ae80",
  "#5ec962",
  "#addc30",
  "#fde725",
] as const;

/**
 * The sequential ramp, 8 stops. Each theme drops the end that would vanish on its base map: the
 * near-black purple on dark, the near-white yellow on light.
 */
export function sequential(theme: Theme): string[] {
  return theme === "light" ? VIRIDIS.slice(0, 8) : VIRIDIS.slice(1);
}

/** Unknown / no value: a neutral grey, distinct from every hue above and from the base map's roads. */
export const UNKNOWN: Record<Theme, string> = { light: "#a3a3a3", dark: "#8f8f98" };

/** Halo around the information layer's and the rides' lines, so they read on any map colour. */
export const CASING: Record<Theme, string> = { light: "#ffffff", dark: "#0a0a0a" };

/** Explored map: ridden edges get a calm teal band; never ridden stays the normal map. */
export const EXPLORED: Record<Theme, string> = { light: "#0a8f86", dark: "#35d0c0" };

/** "My rides": the raw recorded tracks. Magenta: distinct from the Okabe–Ito hues, the explored orange and the base map. */
export const RIDES: Record<Theme, string> = { light: "#c2185b", dark: "#ff6fa5" };

/** The selected edge (the inspect panel). */
export const SELECTED: Record<Theme, string> = { light: "#111111", dark: "#ffffff" };

/** `a` moved towards `b` by `f` (0: a, 1: b); both `#rrggbb`. */
export function mixHex(a: string, b: string, f: number): string {
  const ch = (hex: string, o: number) => Number.parseInt(hex.slice(o, o + 2), 16);
  const out = [1, 3, 5].map((o) =>
    Math.round(ch(a, o) + (ch(b, o) - ch(a, o)) * f)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${out.join("")}`;
}

function mix(hex: string, towards: number, amount: number): string {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(value + (towards - value) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** The colour of the n-th category (0-based). Beyond 8 the hues repeat, lighter then darker. */
export function categoryColor(index: number): string {
  const base = CATEGORICAL[index % CATEGORICAL.length] as string;
  const round = Math.floor(index / CATEGORICAL.length);
  if (round === 0) return base;
  return round % 2 === 1 ? mix(base, 255, 0.4) : mix(base, 0, 0.35);
}

/**
 * The cost layer (cost.ts): a diverging scale centred on factor 1, preferred (green) ← neutral (grey)
 * → avoided (magenta), 7 stops from the profile's `minFactor` to its `maxFactor` on a log scale. Green
 * and magenta stay apart for the common colour-blindnesses (ColorBrewer's PiYG family), and neither is
 * the route's vermilion, the compared route's blue or the map's violet cycle paths. On light the strong
 * ends are dark, on dark they are bright: the strong values always stand out most from the ground.
 */
export const COST_STOPS: Record<Theme, readonly string[]> = {
  light: ["#17643a", "#3f9a52", "#93c47d", "#c4bfb5", "#e49ac6", "#c2408f", "#7d1561"],
  dark: ["#8be3a8", "#55c07c", "#3f8a5a", "#76726c", "#a05a8a", "#e06bb6", "#ffa6da"],
};

/** Closed ways on the cost layer: dashed ink, the colour of "no". */
export const COST_CLOSED: Record<Theme, string> = { light: "#2b2b2b", dark: "#e6e6e6" };
