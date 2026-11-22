// The structured controls' logic (#66, a prototype behind a switch; docs/planner.md): tier boards for
// surfaces and way types, the hills curve, Detours as the spread. Pure functions over the engine's
// structured profile (docs/profile.md, "The structured model"): the words, a tier move, the curve and
// its handles, the changes against the preset, what a route says about each row and grade band.
import type {
  BoardId,
  BoardRow,
  Boards,
  Catalogue,
  GradeHistogram,
  Hills,
  LimitId,
  PrefId,
  Profile,
  RouteResult,
  StructuredInfo,
  SurfaceBoard,
  Tier,
  WayBoard,
} from "@/engine/generated/types";

// ---------------------------------------------------------------- tiers

/** Worst to best, as the tier picker lays them out (avoid on the left, like the sliders). */
export const TIERS: readonly Tier[] = ["avoid", "dislike", "fine", "like", "love"];
/** Best to worst: the lanes, top to bottom. */
export const LANES: readonly Tier[] = ["love", "like", "fine", "dislike", "avoid"];
/** A metre's factor relative to `love` (the engine's catalogue has the same; avoid closes). */
export const TIER_FACTOR: Record<Exclude<Tier, "avoid">, number> = {
  love: 1,
  like: 1.15,
  fine: 1.35,
  dislike: 2,
};
export const TIER_LABEL: Record<Tier, string> = {
  avoid: "Avoid",
  dislike: "Dislike",
  fine: "Fine",
  like: "Like",
  love: "Love",
};
const rank = (t: Tier) => TIERS.indexOf(t);

/** "1.35", "2", "1.15": a factor without float dust. */
export function num(v: number, digits = 2): string {
  return String(Number(v.toFixed(digits)));
}

/** What a tier's metre counts as under the spread (`detours`): love 1, fine 1.35 at spread 1. */
export function tierFactor(t: Tier, spread = 1): number | null {
  if (t === "avoid") return null;
  return TIER_FACTOR[t] ** spread;
}

/** A lane's rate: "1 km is 1 km", "1 km → 1.35 km", "never". */
export function tierRate(t: Tier, spread = 1): string {
  const f = tierFactor(t, spread);
  if (f === null) return "never";
  if (Math.abs(f - 1) < 0.005) return "1 km is 1 km";
  return `1 km → ${num(f)} km`;
}

/** The tier picker's small line: "never", "2 km", "1.35 km", "1 km". */
export function tierShort(t: Tier, spread = 1): string {
  const f = tierFactor(t, spread);
  return f === null ? "never" : `${num(f)} km`;
}

// ---------------------------------------------------------------- boards

export const SURFACE_ROWS: readonly (keyof SurfaceBoard)[] = [
  "paved",
  "rough_paved",
  "compacted",
  "gravel",
  "soft",
  "unknown",
];
export const WAY_ROWS: readonly (keyof WayBoard)[] = [
  "main",
  "country_road",
  "residential",
  "service",
  "track",
  "path",
  "cycle_path",
  "cycle_path_roadside",
];
export const BOARD_ROWS: Record<BoardId, readonly BoardRow[]> = { surface: SURFACE_ROWS, way: WAY_ROWS };
/** The board a row is on. */
export const boardOf = (row: BoardRow): BoardId =>
  (SURFACE_ROWS as readonly BoardRow[]).includes(row) ? "surface" : "way";

/** How a summary names a row: "tracks", "fine gravel", "never main roads". */
const ROW_NOUN: Record<BoardRow, string> = {
  paved: "smooth tarmac",
  rough_paved: "cobbles",
  compacted: "fine gravel",
  gravel: "gravel",
  soft: "soft ground",
  unknown: "unknown surface",
  main: "main roads",
  country_road: "country roads",
  residential: "residential streets",
  service: "service roads",
  track: "tracks",
  path: "paths",
  cycle_path: "cycle paths",
  cycle_path_roadside: "roadside cycle paths",
};
export const rowNoun = (row: BoardRow) => ROW_NOUN[row];

/** A chip's name: the catalogue's label ("Tracks", "Roadside cycle paths"). */
export function rowLabel(row: BoardRow, catalogue: Catalogue | null): string {
  const b = catalogue?.structured?.boards.find((x) => x.id === boardOf(row));
  return b?.rows.find((r) => r.id === row)?.label ?? ROW_NOUN[row];
}

export type Board = Partial<Record<BoardRow, Tier>>;

/** One board of the profile, as a row → tier map (`{}` when the profile has no such board). */
export function boardOfProfile(boards: Boards | null | undefined, id: BoardId): Board {
  return { ...((boards?.[id] ?? {}) as Board) };
}

/** The board with one row moved to `tier` (a new object; unchanged rows are kept). */
export function moveRow(boards: Boards, row: BoardRow, tier: Tier): Boards {
  const id = boardOf(row);
  const board = { ...(boards[id] ?? {}), [row]: tier };
  return { ...boards, [id]: board } as Boards;
}

/** The rows of a board in one tier, in the board's order. */
export const rowsIn = (board: Board, id: BoardId, tier: Tier) =>
  BOARD_ROWS[id].filter((r) => board[r] === tier);

const names = (rows: readonly BoardRow[], max: number) => {
  const named = rows.slice(0, max).map(rowNoun).join(", ");
  return rows.length > max ? `${named} +${rows.length - max}` : named;
};

/**
 * The collapsed line in a rider's words: the best tiers first, then the worst ("love tracks, cycle
 * paths · never main roads"; "like gravel · dislike soft ground"). Fine is no opinion, not named.
 */
export function boardSummary(board: Board, id: BoardId): string {
  const rows = BOARD_ROWS[id];
  const of = (t: Tier) => rows.filter((r) => board[r] === t);
  const good: string[] = [];
  const love = of("love");
  const like = of("like");
  if (love.length) good.push(`love ${names(love, 2)}`);
  if (like.length && (love.length < 2 || like.length === 1))
    good.push(`like ${names(like, love.length ? 1 : 2)}`);
  else if (like.length) good.push(`like ${like.length} more`);
  const bad: string[] = [];
  const avoid = of("avoid");
  const dislike = of("dislike");
  if (avoid.length) bad.push(`never ${names(avoid, 2)}`);
  if (dislike.length && avoid.length < 2) bad.push(`dislike ${names(dislike, avoid.length ? 1 : 2)}`);
  if (!good.length && !bad.length) return "all fine: no ranking yet";
  return [good.join(", "), bad.join(", ")].filter(Boolean).join(" · ");
}

/** Metres of the route in a row (`breakdown.rows`); `null` without a route. */
export function rowM(r: RouteResult | null, row: BoardRow): number | null {
  if (!r) return null;
  return r.breakdown.rows?.find((p) => p.key === row)?.length_m ?? 0;
}

/** The sentence under the board: the exchange between love and fine under the spread. */
export function exchangeSentence(spread = 1): { lead: string; strong: string; tail: string } {
  return {
    lead: "To stay on ways you love, the route may be up to ",
    strong: `${num(TIER_FACTOR.fine ** spread)}× longer`,
    tail: " than on ways that are fine.",
  };
}

// ---------------------------------------------------------------- the hills curve

/** The handles' grades, downhill negative; 0 % is pinned at 1. */
export const HANDLES = [-15, -8, 0, 3, 6, 10, 15] as const;
export type Grade = (typeof HANDLES)[number];
/** The curve is flat beyond this. */
export const FLAT_BEYOND = 15;

const UP = [3, 6, 10, 15] as const;

/** A value as the engine stores it (f32) on two decimals. */
const round2 = (v: number) => Math.round(v * 100) / 100;

/** The curve with its values rounded (the engine's f32 noise off) and the descent made explicit. */
export function cleanHills(h: Hills): Hills {
  const up = {
    "3": round2(h.up["3"]),
    "6": round2(h.up["6"]),
    "10": round2(h.up["10"]),
    "15": round2(h.up["15"]),
  };
  const down = h.down
    ? { "8": round2(h.down["8"]), "15": round2(h.down["15"]) }
    : { "8": round2(implicitDown(up, 8)), "15": round2(implicitDown(up, 15)) };
  return { up, down, loose_pct: Math.round(h.loose_pct) };
}

/** Without descending handles a descent counts like a climb of half its grade, at least 1. */
function implicitDown(up: Hills["up"], g: number): number {
  return Math.max(1, upCurve(up, g / 2));
}

function upCurve(up: Hills["up"], g: number): number {
  return interp([[0, 1], ...UP.map((x) => [x, up[String(x) as keyof Hills["up"]]] as [number, number])], g);
}

/** Linear in grade and in log value between the points, flat beyond the ends. */
function interp(points: readonly [number, number][], g: number): number {
  const first = points[0] as [number, number];
  const last = points[points.length - 1] as [number, number];
  if (g <= first[0]) return first[1];
  if (g >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [g0, v0] = points[i - 1] as [number, number];
    const [g1, v1] = points[i] as [number, number];
    if (g <= g1) return Math.exp(Math.log(v0) + ((g - g0) / (g1 - g0)) * (Math.log(v1) - Math.log(v0)));
  }
  return last[1];
}

/** The handle's value: what a metre at that grade counts as relative to flat. */
export function handleValue(h: Hills, g: number): number {
  if (g === 0) return 1;
  if (g > 0) return h.up[String(g) as keyof Hills["up"]] ?? 1;
  const d = h.down?.[String(-g) as keyof NonNullable<Hills["down"]>];
  return d ?? implicitDown(h.up, -g);
}

/** The handles as points, downhill negative. */
export const curvePoints = (h: Hills): [number, number][] => HANDLES.map((g) => [g, handleValue(h, g)]);

/** What a metre at grade `g` (percent, signed) counts as. */
export function curveAt(h: Hills, g: number): number {
  return interp(curvePoints(h), g);
}

/** The ladder the stepper walks: fine steps near 1, coarser ones further out. */
export const LADDER = [
  0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2, 2.2, 2.5, 3, 3.5,
  4, 5, 6, 7, 8, 10,
] as const;

/** The range of a handle (the catalogue's: down 1 … 10, up 0.5 … 10). */
export function handleRange(g: number, info?: StructuredInfo | null): { min: number; max: number } {
  const h = info?.hills.handles.find((x) => x.grade_pct === g);
  if (h) return { min: h.min, max: h.max };
  return g < 0 ? { min: 1, max: 10 } : { min: 0.5, max: 10 };
}

/** One step of the stepper from `v`: the next value on the ladder, within the handle's range. */
export function stepValue(v: number, dir: 1 | -1, range: { min: number; max: number }): number {
  const next = dir > 0 ? LADDER.find((x) => x > v + 1e-6) : [...LADDER].reverse().find((x) => x < v - 1e-6);
  return Math.max(range.min, Math.min(range.max, next ?? v));
}

/** The curve with one handle set (0 % stays pinned); values on two decimals, within range. */
export function setHandle(h: Hills, g: number, v: number, info?: StructuredInfo | null): Hills {
  if (g === 0) return h;
  const { min, max } = handleRange(g, info);
  const value = round2(Math.max(min, Math.min(max, v)));
  const base = cleanHills(h);
  if (g > 0) return { ...base, up: { ...base.up, [String(g)]: value } as Hills["up"] };
  return { ...base, down: { ...(base.down as NonNullable<Hills["down"]>), [String(-g)]: value } };
}

export const LOOSE_STEP = 5;
/** "Steeper on loose ground" one step up or down (0 … 50 %). */
export function stepLoose(h: Hills, dir: 1 | -1, info?: StructuredInfo | null): Hills {
  const r = info?.hills.loose_pct ?? { min: 0, max: 50 };
  const v = Math.max(r.min, Math.min(r.max, Math.round(h.loose_pct / LOOSE_STEP + dir) * LOOSE_STEP));
  return { ...cleanHills(h), loose_pct: v };
}

/** "8 % on gravel is read as 9.6 %". */
export function looseSentence(loose: number): string {
  if (loose <= 0) return "grades on gravel count as they are";
  return `8 % on gravel is read as ${num(8 * (1 + loose / 100), 1)} %`;
}

/** Whether two curves are the same (on two decimals). */
export function sameHills(a: Hills | null | undefined, b: Hills | null | undefined): boolean {
  if (!a || !b) return a === b || (!a && !b);
  const x = cleanHills(a);
  const y = cleanHills(b);
  return x.loose_pct === y.loose_pct && HANDLES.every((g) => handleValue(x, g) === handleValue(y, g));
}

/** The named curve this one is (`null`: the rider's own). */
export function namedCurve(h: Hills, info: StructuredInfo | null | undefined) {
  return info?.hills.curves.find((c) => sameHills(c.hills, h)) ?? null;
}

/** A value as metres: "2.5 m", "1 m", "0.93 m". */
export const metreText = (v: number) => `${num(v)} m`;

/** "+10 %", "−8 %", "flat". */
export const gradeText = (g: number) => (g === 0 ? "flat" : `${g > 0 ? "+" : "−"}${Math.abs(g)} %`);

/**
 * The collapsed line: "Don't mind · a metre at 10 % counts as 1.4 m" (a named curve), "Gravel
 * explorer's curve · …" (the preset's own), "Your own curve · …".
 */
export function hillsSummary(
  h: Hills,
  info: StructuredInfo | null | undefined,
  base?: { name: string; hills: Hills },
): string {
  const name =
    namedCurve(h, info)?.label ??
    (base && sameHills(base.hills, h) ? `${base.name}’s curve` : "Your own curve");
  return `${name} · a metre at 10 % counts as ${metreText(handleValue(h, 10))}`;
}

/** The band a handle stands for: halfway to its neighbours ("around 10 %": 8 to 12.5 %). */
export function handleBand(g: number): [number, number] {
  const i = HANDLES.indexOf(g as Grade);
  const lo = i <= 0 ? -Infinity : ((HANDLES[i - 1] as number) + g) / 2;
  const hi = i < 0 || i >= HANDLES.length - 1 ? Infinity : ((HANDLES[i + 1] as number) + g) / 2;
  return [lo, hi];
}

/** The histogram's bands: centre grade and metres. */
export function bands(grades: GradeHistogram | null | undefined): { g: number; m: number }[] {
  if (!grades) return [];
  return grades.metres.map((m, i) => ({ g: grades.from_pct + (i + 0.5) * grades.step_pct, m }));
}

/** The route's metres around a handle, and what they count as under the curve. */
export function bandAround(
  grades: GradeHistogram | null | undefined,
  h: Hills,
  g: number,
): { m: number; counts: number } | null {
  if (!grades) return null;
  const [lo, hi] = handleBand(g);
  let m = 0;
  let counts = 0;
  for (const b of bands(grades)) {
    if (b.g < lo || b.g >= hi) continue;
    m += b.m;
    counts += b.m * curveAt(h, b.g);
  }
  return { m, counts };
}

/** The hills of a route in metres: the engine's own per segment (`hills_m`). */
export function routeHillsM(r: RouteResult | null): number | null {
  if (!r?.breakdown.grades) return null;
  return r.segments.reduce((s, x) => s + (x.hills_m ?? 0), 0);
}

const kmText = (m: number) => `${(m / 1000).toFixed(1)} km`;

/** "At 10 % uphill a metre counts as 2.5 m." and the route's share around it. */
export function handleSentence(
  h: Hills,
  g: number,
  grades: GradeHistogram | null | undefined,
): { lead: string; route: string | null } {
  const v = handleValue(h, g);
  const where = g === 0 ? "On the flat" : `At ${Math.abs(g)} % ${g > 0 ? "uphill" : "downhill"}`;
  const lead =
    g === 0
      ? "On the flat a metre is a metre: the yardstick."
      : `${where} a metre counts as ${metreText(v)}.`;
  const band = bandAround(grades, h, g);
  if (!band) return { lead, route: null };
  if (band.m < 50) return { lead, route: `Nothing on this route around ${gradeText(g)}.` };
  return {
    lead,
    route: `On this route: ${kmText(band.m)} around ${gradeText(g)} count as ${kmText(band.counts)}.`,
  };
}

/** "+7.8 km" for the total (signed; a curve that seeks climbs gives a minus). */
export function signedKm(m: number): string {
  return `${m < 0 ? "−" : "+"}${kmText(Math.abs(m))}`;
}

// ---------------------------------------------------------------- detours (the spread)

export const SPREAD = { min: 0.5, max: 2, step: 0.05, default: 1 } as const;

export function snapSpread(v: number): number {
  const c = Math.max(SPREAD.min, Math.min(SPREAD.max, v));
  return Number((Math.round(c / SPREAD.step) * SPREAD.step).toFixed(2));
}

/** The word beside the spread: how far the ranking pulls. */
export function spreadWord(x: number): string {
  if (x <= 0.65) return "Stay close to direct";
  if (x < 0.9) return "A little off the way";
  if (x <= 1.1) return "Detours for good ways";
  if (x < 1.6) return "Further for good ways";
  return "Go far for good ways";
}

// ---------------------------------------------------------------- the profile

/** A structured profile: it has boards, a curve or a spread (the engine then uses that model). */
export function isStructured(p: Profile | null | undefined): boolean {
  return !!p && (p.boards !== undefined || p.hills !== undefined || p.detours !== undefined);
}

/** The structured part of a plan, next to its weights and limits. */
export type StructuredParts = { boards: Boards; hills: Hills; spread: number };

/** A preset's structured part (a board or curve it lacks: every row fine, a flat curve). */
export function partsOf(p: Profile | null | undefined): StructuredParts {
  return {
    boards: {
      surface: { ...(fullBoard("surface", p?.boards?.surface) as SurfaceBoard) },
      way: { ...(fullBoard("way", p?.boards?.way) as WayBoard) },
    },
    hills: cleanHills(p?.hills ?? FLAT_HILLS),
    spread: snapSpread(p?.detours ?? SPREAD.default),
  };
}

function fullBoard(id: BoardId, board: Board | undefined): Board {
  return Object.fromEntries(BOARD_ROWS[id].map((r) => [r, board?.[r] ?? "fine"])) as Board;
}

export const FLAT_HILLS: Hills = {
  up: { "3": 1, "6": 1, "10": 1, "15": 1 },
  down: { "8": 1, "15": 1 },
  loose_pct: 0,
};

/** What the boards and the curve replace: never sent in a structured profile (the engine rejects them). */
export function replaced(catalogue: Catalogue | null): { prefs: Set<PrefId>; limits: Set<LimitId> } {
  const s = catalogue?.structured;
  return {
    prefs: new Set([...(s?.boards.flatMap((b) => b.replaces) ?? []), ...(s?.hills.replaces ?? [])]),
    limits: new Set(s?.boards.flatMap((b) => b.replaces_limits) ?? []),
  };
}

/** The plan's structured profile as the engine takes it. */
export function structuredProfile(
  base: { id: string; profile: Profile } | undefined,
  weights: Profile["weights"],
  limits: Profile["limits"],
  parts: StructuredParts,
  catalogue: Catalogue | null,
): Profile {
  const { prefs, limits: lims } = replaced(catalogue);
  const w = Object.fromEntries(Object.entries(weights).filter(([k]) => !prefs.has(k as PrefId)));
  const l = Object.fromEntries(Object.entries(limits).filter(([k]) => !lims.has(k as LimitId)));
  const max = base?.profile.bounds?.max_factor;
  return {
    ...(base?.profile.name ? { name: base.profile.name } : {}),
    ...(base ? { base: base.id } : {}),
    weights: w,
    limits: l,
    // min_factor stays at its default in this model (detours takes its place)
    ...(max !== undefined ? { bounds: { min_factor: 0.5, max_factor: max } } : {}),
    ...(base?.profile.turn_m !== undefined ? { turn_m: base.profile.turn_m } : {}),
    boards: parts.boards,
    hills: parts.hills,
    detours: parts.spread,
  };
}

// ---------------------------------------------------------------- changes against the preset

export type StructuredChange = { id: string; kind: "row" | "hills" | "detours"; text: string };

/** The rows, the curve and the spread that differ from the base preset, in words. */
export function structuredChanges(
  base: StructuredParts,
  plan: StructuredParts,
  info: StructuredInfo | null | undefined,
): StructuredChange[] {
  const out: StructuredChange[] = [];
  for (const id of ["surface", "way"] as const) {
    const a = base.boards[id] as Board | undefined;
    const b = plan.boards[id] as Board | undefined;
    for (const row of BOARD_ROWS[id]) {
      const from = a?.[row] ?? "fine";
      const to = b?.[row] ?? "fine";
      if (from === to) continue;
      out.push({ id: `row:${row}`, kind: "row", text: tierChangeText(row, from, to) });
    }
  }
  if (!sameHills(base.hills, plan.hills)) {
    const named = namedCurve(plan.hills, info);
    out.push({ id: "hills", kind: "hills", text: named ? `hills: ${named.label}` : "own hills curve" });
  }
  if (Math.abs(base.spread - plan.spread) > 1e-6)
    out.push({
      id: "detours",
      kind: "detours",
      text: plan.spread > base.spread ? "more detours" : "fewer detours",
    });
  return out;
}

/** "paths a tier up", "never main roads", "soft ground allowed again". */
export function tierChangeText(row: BoardRow, from: Tier, to: Tier): string {
  const n = rowNoun(row);
  if (to === "avoid") return `never ${n}`;
  if (from === "avoid") return `${n} allowed again`;
  const d = rank(to) - rank(from);
  const steps = Math.abs(d) === 1 ? "a tier" : `${Math.abs(d)} tiers`;
  return `${n} ${steps} ${d > 0 ? "up" : "down"}`;
}

export const sameBoards = (a: Boards, b: Boards) =>
  (["surface", "way"] as const).every((id) =>
    BOARD_ROWS[id].every(
      (r) => ((a[id] as Board | undefined)?.[r] ?? "fine") === ((b[id] as Board | undefined)?.[r] ?? "fine"),
    ),
  );

export const sameParts = (a: StructuredParts, b: StructuredParts) =>
  sameBoards(a.boards, b.boards) && sameHills(a.hills, b.hills) && Math.abs(a.spread - b.spread) < 1e-6;

// ---------------------------------------------------------------- switching on

/**
 * The structured plan made from a slider plan: per part (a board, the curve), the twin's own where the
 * plan changed nothing that feeds it (so River valley keeps its tuned curve), else the engine's
 * conversion of the plan; the other weights and limits from the conversion.
 */
export function fromSliders(o: {
  converted: Profile;
  twin: { profile: Profile } | undefined;
  /** the slider plan's and its base's weights and limits */
  plan: { weights: Profile["weights"]; limits: Profile["limits"] };
  base: { weights: Profile["weights"]; limits: Profile["limits"] };
  catalogue: Catalogue | null;
}): { weights: Profile["weights"]; limits: Profile["limits"]; parts: StructuredParts } {
  const s = o.catalogue?.structured;
  const conv = partsOf(o.converted);
  const twin = o.twin ? partsOf(o.twin.profile) : null;
  const untouched = (prefs: readonly PrefId[], limits: readonly LimitId[] = []) =>
    prefs.every((id) => o.plan.weights[id] === o.base.weights[id]) &&
    limits.every((id) => !!o.plan.limits[id] === !!o.base.limits[id]);
  const board = (id: BoardId) => {
    const b = s?.boards.find((x) => x.id === id);
    return twin && b && untouched(b.replaces, b.replaces_limits) ? twin.boards[id] : conv.boards[id];
  };
  const hills = twin && s && untouched(s.hills.replaces) ? twin.hills : conv.hills;
  const { prefs, limits } = replaced(o.catalogue);
  return {
    weights: Object.fromEntries(
      Object.entries(o.converted.weights).filter(([k]) => !prefs.has(k as PrefId)),
    ) as Profile["weights"],
    limits: Object.fromEntries(
      Object.entries(o.converted.limits).filter(([k]) => !limits.has(k as LimitId)),
    ) as Profile["limits"],
    parts: {
      boards: { surface: board("surface") as SurfaceBoard, way: board("way") as WayBoard },
      hills,
      spread: twin && Math.abs(conv.spread - twin.spread) < 0.03 ? twin.spread : conv.spread,
    },
  };
}

/** The structured twin of a slider preset (`<id>_structured`). */
export const twinId = (id: string) => (id.endsWith("_structured") ? id : `${id}_structured`);

// ---------------------------------------------------------------- persistence

/** The plan's structured profile as saved next to its slider profile (`kompass.plan.v1`). */
export type SavedStructured = {
  baseId: string;
  weights: Profile["weights"];
  limits: Profile["limits"];
  boards: Boards;
  hills: Hills;
  spread: number;
  /** edited since it was converted: kept apart from the sliders (else converted again on switching) */
  edited: boolean;
};

const isTier = (x: unknown): x is Tier => typeof x === "string" && (TIERS as readonly string[]).includes(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** A saved structured profile, or `null` when it is missing or not ours. */
export function parseStructured(raw: unknown): SavedStructured | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof SavedStructured, unknown>>;
  if (typeof r.baseId !== "string") return null;
  const boards: Boards = {};
  for (const id of ["surface", "way"] as const) {
    const b = (r.boards as Record<string, Record<string, unknown>> | undefined)?.[id];
    if (!b) return null;
    const out: Board = {};
    for (const row of BOARD_ROWS[id]) {
      const t = b[row];
      if (!isTier(t)) return null;
      out[row] = t;
    }
    (boards as Record<BoardId, Board>)[id] = out;
  }
  const h = r.hills as Hills | undefined;
  const values = h ? [...Object.values(h.up ?? {}), ...Object.values(h.down ?? {}), h.loose_pct] : [];
  if (!h?.up || values.length !== 7 || !values.every(finite)) return null;
  const weights: Profile["weights"] = {};
  for (const [k, v] of Object.entries((r.weights as object) ?? {}))
    if (finite(v)) weights[k as PrefId] = Math.max(-100, Math.min(100, v));
  const limits: Profile["limits"] = {};
  for (const [k, v] of Object.entries((r.limits as object) ?? {}))
    if (typeof v === "boolean" || finite(v)) limits[k as LimitId] = v;
  return {
    baseId: r.baseId,
    weights,
    limits,
    boards,
    hills: cleanHills(h),
    spread: snapSpread(finite(r.spread) ? r.spread : SPREAD.default),
    edited: r.edited === true,
  };
}
