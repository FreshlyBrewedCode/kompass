// The map style options ("Map style" in Map & rides, docs/map.md): how the outdoor style is drawn, one
// choice per device. Pure: parsing and the tables; the store is `lib/map-look.ts`.

/** graded: the fill of a track tells its grade; simple: every track white, paved or not by its rim */
export type TrackStyle = "graded" | "simple";
export type LineWeight = "normal" | "bold";
/** the colours of the open land and the forest (light theme; dark has one ground) */
export type Ground = "straw" | "meadow" | "pale";
export type Relief = "soft" | "normal" | "strong";

export type MapLook = {
  tracks: TrackStyle;
  weight: LineWeight;
  ground: Ground;
  relief: Relief;
  contours: boolean;
};

export const DEFAULT_LOOK: MapLook = {
  tracks: "graded",
  weight: "normal",
  ground: "straw",
  relief: "normal",
  contours: true,
};

/** The choices of each option, in the order the settings show them (the first is the default). */
export const LOOK_CHOICES = {
  tracks: ["graded", "simple"],
  weight: ["normal", "bold"],
  ground: ["straw", "meadow", "pale"],
  relief: ["soft", "normal", "strong"],
} as const satisfies { [K in Exclude<keyof MapLook, "contours">]: readonly MapLook[K][] };

/** Every way's widths times this. */
export const WEIGHT_SCALE: Record<LineWeight, number> = { normal: 1, bold: 1.25 };
/** The hillshade's strength times this. */
export const RELIEF_SCALE: Record<Relief, number> = { soft: 0.6, normal: 1, strong: 1.5 };

const oneOf = <T extends string>(choices: readonly T[], v: unknown, fallback: T): T =>
  choices.includes(v as T) ? (v as T) : fallback;

/** A stored value (JSON text or an object) to a look; anything missing or unknown is the default. */
export function parseLook(raw: unknown): MapLook {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const o = (v !== null && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_LOOK;
  return {
    tracks: oneOf(LOOK_CHOICES.tracks, o.tracks, d.tracks),
    weight: oneOf(LOOK_CHOICES.weight, o.weight, d.weight),
    ground: oneOf(LOOK_CHOICES.ground, o.ground, d.ground),
    relief: oneOf(LOOK_CHOICES.relief, o.relief, d.relief),
    contours: typeof o.contours === "boolean" ? o.contours : d.contours,
  };
}

export const sameLook = (a: MapLook, b: MapLook) =>
  a.tracks === b.tracks &&
  a.weight === b.weight &&
  a.ground === b.ground &&
  a.relief === b.relief &&
  a.contours === b.contours;
