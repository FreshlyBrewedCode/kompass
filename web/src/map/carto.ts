// The map's colours: one table per theme, the single place to tune how the outdoor style looks.
// They are not theme tokens on purpose (like `palette.ts`): map colours are picked against each other
// (forest against land, a track against forest), not against the chrome.
//
// The identity: calm and map-first. Land is quiet, forest is clearly green, roads stay in a narrow
// white-to-yellow range, and the strong hues are kept free for what the app puts on top (the route in
// vermilion, information layers, rides). Cycling infrastructure is violet throughout.
import type { Theme } from "./palette";

export type Carto = {
  /** outside the region and under everything */
  background: string;
  land: string;
  // ---- land cover (fills)
  forest: string;
  scrub: string;
  meadow: string;
  farmland: string;
  orchard: string;
  wetland: string;
  rock: string;
  sand: string;
  glacier: string;
  // ---- land use (fills)
  builtup: string;
  industrial: string;
  park: string;
  pitch: string;
  buildings: string;
  // ---- water
  water: string;
  waterway: string;
  waterLabel: string;
  // ---- relief
  shade: string;
  highlight: string;
  hillshadeStrength: number;
  contour: string;
  contourLabel: string;
  // ---- roads: fill and casing per class
  motorway: string;
  motorwayCasing: string;
  primary: string;
  primaryCasing: string;
  secondary: string;
  secondaryCasing: string;
  /** tertiary and the minor roads */
  road: string;
  roadCasing: string;
  /** a paved track: a narrow road with a brown rim */
  lane: string;
  laneCasing: string;
  rail: string;
  // ---- tracks and paths (lines)
  track: string;
  path: string;
  /** a paved path or pavement: present, but quiet (a town is full of them) */
  pathPaved: string;
  /** neither surface nor track grade is mapped */
  trackUnknown: string;
  /** separate cycle paths, and the halo of signed cycle routes */
  cycle: string;
  cycleRoute: string;
  /** private, or no bicycle access */
  restricted: string;
  /** the light rim under tracks and paths, so their dashes read on forest */
  wayHalo: string;
  // ---- labels
  label: string;
  labelMinor: string;
  labelHalo: string;
  boundary: string;
};

export const CARTO: Record<Theme, Carto> = {
  light: {
    background: "#e9e8e2",
    land: "#f4f2eb",
    forest: "#c3dfb1",
    scrub: "#d6e6c1",
    meadow: "#e6efd0",
    farmland: "#f3efdc",
    orchard: "#dcebc3",
    wetland: "#d3e7df",
    rock: "#eae7df",
    sand: "#f1e9cf",
    glacier: "#eef5f8",
    builtup: "#ebe6e0",
    industrial: "#e0dde2",
    park: "#d3ebc2",
    pitch: "#c9e6bd",
    buildings: "#dcd5cb",
    water: "#a8d4f0",
    waterway: "#86c0e6",
    waterLabel: "#3f7fa8",
    shade: "#2c4a3a",
    highlight: "#ffffff",
    hillshadeStrength: 0.26,
    contour: "#a9825a",
    contourLabel: "#94714c",
    motorway: "#f6c26a",
    motorwayCasing: "#c9963c",
    primary: "#fbdc8e",
    primaryCasing: "#cfa94f",
    secondary: "#fdf0b8",
    secondaryCasing: "#c9b674",
    road: "#ffffff",
    roadCasing: "#a39c8f",
    lane: "#ffffff",
    laneCasing: "#9c7a56",
    rail: "#8f8f95",
    track: "#7d5632",
    path: "#6e5138",
    pathPaved: "#ab947c",
    trackUnknown: "#a78a6c",
    cycle: "#5b54d6",
    cycleRoute: "#6f5df0",
    restricted: "#a09b94",
    wayHalo: "#fffdf7",
    label: "#262a27",
    labelMinor: "#555a55",
    labelHalo: "#fbfaf5",
    boundary: "#9d8fb0",
  },
  dark: {
    background: "#131514",
    land: "#1b1e1c",
    forest: "#1f3324",
    scrub: "#222e22",
    meadow: "#252b1f",
    farmland: "#24241d",
    orchard: "#253021",
    wetland: "#1d2c2b",
    rock: "#252624",
    sand: "#2d2a20",
    glacier: "#2a3236",
    builtup: "#282625",
    industrial: "#27262a",
    park: "#22331f",
    pitch: "#24361f",
    buildings: "#36332f",
    water: "#17344c",
    waterway: "#21486a",
    waterLabel: "#6fa9d6",
    shade: "#000000",
    highlight: "#3d4f41",
    hillshadeStrength: 0.4,
    contour: "#a08260",
    contourLabel: "#a88c6c",
    motorway: "#a47a35",
    motorwayCasing: "#0e100f",
    primary: "#8f7a44",
    primaryCasing: "#0e100f",
    secondary: "#746a48",
    secondaryCasing: "#0e100f",
    road: "#565a5b",
    roadCasing: "#0e100f",
    lane: "#565a5b",
    laneCasing: "#8a6d4d",
    rail: "#6b6b72",
    track: "#d0a878",
    path: "#bfa487",
    pathPaved: "#85735f",
    trackUnknown: "#927b62",
    cycle: "#a59cff",
    cycleRoute: "#8f84ff",
    restricted: "#6d6a66",
    wayHalo: "#0f1110",
    label: "#eceee9",
    labelMinor: "#a9ada7",
    labelHalo: "#141615",
    boundary: "#6c627c",
  },
};
