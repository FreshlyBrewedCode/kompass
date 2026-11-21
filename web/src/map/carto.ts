// The map's colours: one table per theme, the single place to tune how the outdoor style looks.
// They are not theme tokens on purpose (like `palette.ts`): map colours are picked against each other
// (forest against land, a track against forest), not against the chrome.
//
// The identity ("Bands", docs/map.md): calm and map-first. Land is quiet, forest is clearly green,
// roads stay in a narrow white-to-lemon range, what a gravel bike rolls on is a band from white over
// cream to ochre, soft ground a dark brown line; the strong hues are kept free for what the app puts
// on top (the route in vermilion, information layers, rides). Cycling infrastructure is violet.
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
  // ---- motorways and railways (base tiles)
  motorway: string;
  motorwayCasing: string;
  rail: string;
  // ---- the ways (ways.ts): roads keep their tiers, the fill of a track band darkens with roughness
  major: string;
  majorCasing: string;
  secondary: string;
  secondaryCasing: string;
  tertiary: string;
  tertiaryCasing: string;
  /** minor roads, streets, service roads */
  road: string;
  roadCasing: string;
  /** grade 1: a paved track, a white band with the tracks' rim */
  lane: string;
  /** the rim of every unpaved band (and of a paved track) */
  trackCasing: string;
  /** grade 2 */
  compacted: string;
  /** grade 3 */
  gravel: string;
  /** a track with neither surface nor grade mapped: a pale band */
  unknown: string;
  unknownCasing: string;
  /** grade 4 and 5: no band, a dark broken line */
  soft: string;
  /** separate cycle paths (violet), and the band of signed cycle routes */
  cycle: string;
  cycleRoute: string;
  /** a paved path or pavement: present, but quiet (a town is full of them) */
  pathPaved: string;
  path: string;
  /** a path with nothing mapped */
  pathUnknown: string;
  ferry: string;
  /** the rails of a bridge */
  bridge: string;
  /** the rim under the single lines, so their dashes read on forest */
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
    forest: "#d3e6c3",
    scrub: "#d6e6c1",
    meadow: "#e8efd8",
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
    buildings: "#d5ccbf",
    water: "#a6d2ee",
    waterway: "#74b3de",
    waterLabel: "#3f7fa8",
    shade: "#2c4a3a",
    highlight: "#ffffff",
    hillshadeStrength: 0.22,
    contour: "#a9825a",
    contourLabel: "#94714c",
    motorway: "#f8c04f",
    motorwayCasing: "#a27716",
    rail: "#8f8f95",
    major: "#ffe45e",
    majorCasing: "#9c8514",
    secondary: "#fff1a1",
    secondaryCasing: "#a8933a",
    tertiary: "#ffffff",
    tertiaryCasing: "#7a7468",
    road: "#ffffff",
    roadCasing: "#8f897d",
    lane: "#ffffff",
    trackCasing: "#5e3b1b",
    compacted: "#fbeecb",
    gravel: "#e2a85a",
    unknown: "#e6e2da",
    unknownCasing: "#9a9186",
    soft: "#6f4320",
    cycle: "#5b54d6",
    cycleRoute: "#6f5df0",
    pathPaved: "#93897a",
    path: "#5f4732",
    pathUnknown: "#a08c78",
    ferry: "#4b84b3",
    bridge: "#3d342a",
    wayHalo: "#fffdf6",
    label: "#262a27",
    labelMinor: "#555a55",
    labelHalo: "#fbfaf5",
    boundary: "#9d8fb0",
  },
  dark: {
    background: "#131514",
    land: "#1b1e1c",
    forest: "#1d3222",
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
    shade: "#050706",
    highlight: "#5c6e5f",
    hillshadeStrength: 0.3,
    contour: "#8f7658",
    contourLabel: "#a88c6c",
    motorway: "#c2913a",
    motorwayCasing: "#0e100f",
    rail: "#6b6b72",
    major: "#b9a033",
    majorCasing: "#0c0e0d",
    secondary: "#8f8347",
    secondaryCasing: "#0c0e0d",
    tertiary: "#7b8082",
    tertiaryCasing: "#0c0e0d",
    road: "#686d70",
    roadCasing: "#0c0e0d",
    lane: "#8a8f91",
    trackCasing: "#5c4a33",
    compacted: "#dcc793",
    gravel: "#c48f45",
    unknown: "#4c4f50",
    unknownCasing: "#8a8d8b",
    soft: "#d98f58",
    cycle: "#a59cff",
    cycleRoute: "#8f84ff",
    pathPaved: "#8b8f91",
    path: "#c9ad8d",
    pathUnknown: "#8d8172",
    ferry: "#6fa9d6",
    bridge: "#d8d2c6",
    wayHalo: "#0f1110",
    label: "#eceee9",
    labelMinor: "#a9ada7",
    labelHalo: "#141615",
    boundary: "#6c627c",
  },
};
