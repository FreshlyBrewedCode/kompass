// Colours of the overlay. They are not theme tokens on purpose: map colours must stay readable on the
// base map (light and dark flavour) and for colour-blind users, so they are picked and checked here.
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

/** Halo around the overlay lines, so they read on any base map colour. */
export const CASING: Record<Theme, string> = { light: "#ffffff", dark: "#0a0a0a" };

/** Explored map: never ridden is muted, ridden stands out. */
export const EXPLORED: Record<Theme, { never: string; ridden: string }> = {
  light: { never: "#8d99a8", ridden: "#e8590c" },
  dark: { never: "#6c7686", ridden: "#ffa94d" },
};

/** The selected edge (the inspect panel). */
export const SELECTED: Record<Theme, string> = { light: "#111111", dark: "#ffffff" };

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
