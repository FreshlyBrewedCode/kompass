import { type Profile, ROADS, SURFACES, surfaceColor } from "@/mock/data";
import type { AttrKey } from "./usePlanner";

export interface Legend {
  key: AttrKey;
  label: string;
  hint: string;
  items: { label: string; color: string }[];
  ramp?: boolean;
}

const TRAFFIC = ["#3f9b6c", "#a6c659", "#f1c644", "#f08a3c", "#d6423a"];
const COST = ["#2c8f6b", "#8fc06a", "#e8d36a", "#f0954a", "#cf3f3f"];

export const LEGENDS: Legend[] = [
  { key: "surface", label: "Surface", hint: "OSM surface and tracktype. Unknown stays unknown.", items: SURFACES.filter((s) => s.key !== "dirt").map((s) => ({ label: s.key === "gravel" ? "Unpaved" : s.label, color: s.color })) },
  { key: "road", label: "Road class", hint: "What kind of way it is.", items: ROADS.map((r) => ({ label: r.label, color: r.color })) },
  { key: "traffic", label: "Traffic proxy", hint: "Guessed from class, lanes and speed limit.", ramp: true, items: ["Car-free", "Calm", "Some", "Busy", "Heavy"].map((l, i) => ({ label: l, color: TRAFFIC[i] as string })) },
  { key: "cost", label: "Cost in this profile", hint: "What the active profile makes of every edge.", ramp: true, items: ["Loves it", "Likes", "Neutral", "Dislikes", "Excluded"].map((l, i) => ({ label: l, color: i === 4 ? "#7a7a7a" : (COST[i] as string) })) },
];

const cls = ["get", "class"];
const isTrackPath = ["match", cls, ["track", "path"], true, false];

/** MapLibre colour expression for the OpenMapTiles `transportation` layer. */
export function attrColor(attr: AttrKey, profile: Profile): unknown {
  if (attr === "surface")
    return ["case", ["==", ["get", "surface"], "paved"], surfaceColor("paved"), ["==", ["get", "surface"], "unpaved"], surfaceColor("gravel"), isTrackPath, surfaceColor("unknown"), surfaceColor("paved")];
  const road = (k: string) => ROADS.find((r) => r.key === k)?.color as string;
  if (attr === "road")
    return ["case", ["all", ["==", cls, "path"], ["==", ["get", "subclass"], "cycleway"]], road("cycleway"),
      ["match", cls, ["motorway", "trunk", "primary", "secondary"], road("main"), "tertiary", road("minor"), "track", road("track"), "path", road("path"), road("quiet")]];
  if (attr === "traffic")
    return ["match", cls, ["motorway", "trunk", "primary"], TRAFFIC[4], "secondary", TRAFFIC[3], "tertiary", TRAFFIC[2], ["minor", "service"], TRAFFIC[1], TRAFFIC[0]];
  // cost: a toy version of the engine's per-edge factor, enough to react to the sliders
  const s = profile.soft;
  const step = (v: number) => COST[Math.max(0, Math.min(3, Math.round(1.5 - v / 55)))] as string;
  const main = profile.hard.noMain ? "#7a7a7a" : step(-40 - s.quiet * 0.6);
  const unpaved = profile.hard.pavedOnly ? "#7a7a7a" : step(s.gravel);
  return ["case", ["match", cls, ["motorway", "trunk", "primary", "secondary"], true, false], main,
    ["==", cls, "tertiary"], step(-s.quiet * 0.7),
    ["all", ["==", cls, "path"], ["==", ["get", "subclass"], "cycleway"]], step(s.bikepath),
    ["==", ["get", "surface"], "unpaved"], unpaved,
    isTrackPath, profile.hard.noUnknown ? "#7a7a7a" : step(s.gravel * 0.5),
    step(s.quiet * 0.3 - s.gravel * 0.3)];
}
