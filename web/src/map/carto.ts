// The map's colours: one table per theme, the single place to tune how the outdoor style looks.
// They are not theme tokens on purpose (like `palette.ts`): map colours are picked against each other
// (forest against land, a track against forest), not against the chrome.
//
// The identity (design rounds 2 and 3, docs/map.md): calm and map-first. The open land is a straw
// ground and the forest clearly green, apart in hue, so every band is the lightest thing on the map;
// roads stay in a narrow white-to-lemon range, every track is one band whose fill tells its grade
// (white, cream, ochre, pale tan) and whose rim is dashed when it is unpaved; paths are thin dark
// lines. The strong hues are kept free for what the app puts on top (the route in vermilion,
// information layers, rides). Cycling infrastructure is violet.
import { type Ground, type MapLook, RELIEF_SCALE } from "./look";
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
  /** grade 1: a paved track, a white band with the tracks' solid rim */
  lane: string;
  /** the solid rim of a paved track */
  trackCasing: string;
  /** the rim of an unpaved band: dashed from z13, plain and lighter than a paved one below */
  trackRimUnpaved: string;
  /** grade 2 */
  compacted: string;
  /** grade 3 */
  gravel: string;
  /** a track with neither surface nor grade mapped: a pale band with a grey (dashed) rim */
  unknown: string;
  unknownCasing: string;
  /** grade 4 and 5: the palest tinted band, still lighter than the ground */
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
  /** the rim under a cycle path, so it reads on forest */
  wayHalo: string;
  // ---- labels
  label: string;
  labelMinor: string;
  labelHalo: string;
  boundary: string;
};

export const CARTO: Record<Theme, Carto> = {
  light: {
    // the "straw" ground (`GROUNDS` holds the others)
    background: "#e4dccb",
    land: "#f0e9d4",
    forest: "#bad59c",
    scrub: "#cdd9a9",
    meadow: "#ebe6c3",
    farmland: "#eee2bc",
    orchard: "#dfe1b4",
    wetland: "#c6dccd",
    rock: "#eae7df",
    sand: "#eadfb9",
    glacier: "#eef5f8",
    builtup: "#e6e2dc",
    industrial: "#dcd9de",
    park: "#c5dfab",
    pitch: "#bcdba4",
    buildings: "#c6b8a6",
    water: "#a6d2ee",
    waterway: "#74b3de",
    waterLabel: "#3f7fa8",
    // a warm, neutral shadow: a green one turns every shaded field into forest
    shade: "#4f4334",
    highlight: "#ffffff",
    hillshadeStrength: 0.3,
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
    lane: "#fffdf8",
    trackCasing: "#7a5b36",
    trackRimUnpaved: "#a58b68",
    compacted: "#fbefca",
    gravel: "#efc786",
    unknown: "#f1eee8",
    unknownCasing: "#a0978a",
    soft: "#f0e9dc",
    cycle: "#5b54d6",
    cycleRoute: "#6f5df0",
    pathPaved: "#8a857c",
    path: "#4a3f35",
    pathUnknown: "#6e645a",
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
    trackRimUnpaved: "#6b5840",
    compacted: "#dcc793",
    gravel: "#c48f45",
    unknown: "#4c4f50",
    unknownCasing: "#8a8d8b",
    soft: "#857a68",
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

type GroundColours = Pick<
  Carto,
  "background" | "land" | "forest" | "scrub" | "meadow" | "farmland" | "orchard" | "park" | "pitch" | "shade"
>;
/**
 * The grounds of the light theme besides straw (in `CARTO.light`): meadow, the open land a pale
 * yellow-green and the forest a deeper green; pale, the quiet ground of design round 2.
 */
export const GROUNDS: Record<Exclude<Ground, "straw">, GroundColours> = {
  meadow: {
    background: "#dcdcc4",
    land: "#ecebd2",
    forest: "#b2cf8c",
    scrub: "#c4d59e",
    meadow: "#e2e6bd",
    farmland: "#e8e7c1",
    orchard: "#d4e0aa",
    park: "#bfdca3",
    pitch: "#b6d79c",
    shade: "#3f4a33",
  },
  pale: {
    background: "#e9e8e2",
    land: "#f4f2eb",
    forest: "#d3e6c3",
    scrub: "#d6e6c1",
    meadow: "#e8efd8",
    farmland: "#f3efdc",
    orchard: "#dcebc3",
    park: "#d3ebc2",
    pitch: "#c9e6bd",
    shade: "#2c4a3a",
  },
};

/** The colours for a theme and the map style options: the ground, the track fills, the relief. */
export function cartoFor(theme: Theme, look: MapLook): Carto {
  const c = CARTO[theme];
  const ground = theme === "light" && look.ground !== "straw" ? GROUNDS[look.ground] : {};
  // simple: every track is the paved one's band, only the rim tells paved from unpaved
  const tracks =
    look.tracks === "simple" ? { compacted: c.lane, gravel: c.lane, soft: c.lane, unknown: c.lane } : {};
  return { ...c, ...ground, ...tracks, hillshadeStrength: c.hillshadeStrength * RELIEF_SCALE[look.relief] };
}
