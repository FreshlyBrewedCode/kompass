// The hard limits as trade-offs (docs/planner.md, "Limits as trade-offs"): where breaking a limit of
// the plan on a short bit would save real distance, the engine says so (`tradeoffs`); here are the
// words in a rider's terms, which ones are still offered, and the plan's exceptions "Allow here" makes.
// Pure functions, no React.
import type { Catalogue, ClosedBy, LimitId, Profile, Tradeoff } from "@/engine/generated/types";
import { metresText, wayName } from "./cost/model";
import type { PlanOverride } from "./overrides";
import { makeOverride } from "./overrides";

/** What a bit is, per limit it breaks: "140 m unpaved", "140 m on a main road". */
const PHRASE: Record<Exclude<ClosedBy, "no_bikes" | "oneway">, string> = {
  paved_only: "unpaved",
  no_unknown_surface: "of unknown surface",
  no_main_roads: "on a main road",
  legal_only: "with private or farm-only access",
  no_stairs: "of steps",
  max_grade: "steeper than your limit",
  max_mtb_scale: "harder than your trail limit",
  no_ferries: "by ferry",
  avoided_surface: "on a surface you avoid",
  avoided_way: "on a way type you avoid",
};

const phrase = (c: ClosedBy) => (c === "no_bikes" || c === "oneway" ? c : PHRASE[c]);

/** "140 m unpaved here would save 3.8 km." */
export function tradeoffSentence(t: Tradeoff): string {
  const what = t.limits.map(phrase).join(" and ");
  return `${metresText(t.broken_m)} ${what} here would save ${metresText(t.saved_m)}.`;
}

/** "Your profile has Paved only." The limits it breaks by the catalogue's labels. */
export function tradeoffLimits(t: Tradeoff, catalogue: Catalogue | null): string {
  const names = t.limits.map((c) =>
    c === "avoided_surface"
      ? "a surface on Avoid"
      : c === "avoided_way"
        ? "a way type on Avoid"
        : (catalogue?.limits.find((l) => l.id === c)?.label ?? c.replace(/_/g, " ")),
  );
  return names.join(", ");
}

/** A trade-off by its edges: the same bit offered again after a reroute is the same one. */
export const tradeoffKey = (t: Tradeoff) => t.runs.flatMap((r) => r.edges).join(",");

/** The trade-offs still offered: not kept ("Keep the limit") in this session. */
export function offered(list: readonly Tradeoff[], kept: ReadonlySet<string>): Tradeoff[] {
  return list.filter((t) => !kept.has(tradeoffKey(t)));
}

/** Whether a profile closes ways it could open: a limit on, or a board row on `avoid`. */
export function closesWays(profile: Profile): boolean {
  if (Object.values(profile.limits).some((v) => v !== false && v !== undefined)) return true;
  const { surface, way } = profile.boards ?? {};
  return [surface, way].some((b) => !!b && Object.values(b).includes("avoid"));
}

/** "Allow here": one exception of the plan per run, each with the limit it was made for. */
export function allowOverrides(t: Tradeoff): PlanOverride[] {
  const limit = t.limits.find((c): c is LimitId => c in PHRASE && !c.startsWith("avoided_"));
  return t.runs.map((r) =>
    makeOverride(
      "allow",
      { edges: r.edges, index: 0, length_m: r.length_m, coordinates: r.coordinates },
      wayName(r.way),
      limit,
    ),
  );
}
