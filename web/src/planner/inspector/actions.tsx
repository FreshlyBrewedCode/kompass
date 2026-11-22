// The segment inspector's actions for THIS PLAN (docs/planner.md, "This plan's exceptions"): avoid a
// segment, prefer a way, allow one where a limit closes it. They change the plan's exceptions, never
// the profile; each applies to the way's run between junctions (the ring on the map), and says so.
import { cn } from "cn";
import { Ban, Check, Star, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { EdgeExplanation, LimitId, OverrideKind } from "@/engine/generated/types";
import { formatFactor } from "@/map/cost";
import { metresText, wayName } from "../cost/model";
import { overrideOn, type PlanOverride } from "../overrides";
import { pill } from "../parts";
import { usePlan, usePlanner } from "../store";

const button = cn(pill, "h-9 border border-border px-3.5 hover:bg-foreground/6 disabled:opacity-50");

/** The inspected way's run (loaded with the inspector), when it is the one for `edge`. */
export function useRun(edge: number) {
  return usePlan((s) => (s.run?.edge === edge ? s.run.result : null));
}

/** The plan's exception on this way, if any. */
export function useException(edge: number): PlanOverride | undefined {
  return usePlan((s) => overrideOn(s.overrides, edge));
}

/** "these 420 m": the run the action applies to. */
function useRunText(edge: number): string {
  const run = useRun(edge);
  return run ? metresText(run.length_m) : "…";
}

function OverrideButton({
  kind,
  x,
  limit,
  children,
}: {
  kind: OverrideKind;
  x: EdgeExplanation;
  limit?: LimitId;
  children: ReactNode;
}) {
  const store = usePlanner();
  const run = useRun(x.edge);
  const Icon = kind === "avoid" ? Ban : kind === "prefer" ? Star : Check;
  return (
    <button
      type="button"
      data-testid={`inspector-${kind}`}
      disabled={!run}
      onClick={() => store.addOverride(kind, x.edge, wayName(x.way), limit)}
      className={button}
    >
      <Icon className="size-4" />
      {children}
    </button>
  );
}

/** "Avoid this segment · 420 m" (on the route, or on any way). */
export function AvoidButton({ x, short }: { x: EdgeExplanation; short?: boolean }) {
  const len = useRunText(x.edge);
  return (
    <OverrideButton kind="avoid" x={x}>
      {short ? "Avoid" : "Avoid this segment"} · {len}
    </OverrideButton>
  );
}

/** "Prefer this way": the run counts as little as Detours allow; no stop. */
export function PreferButton({ x }: { x: EdgeExplanation }) {
  return (
    <OverrideButton kind="prefer" x={x}>
      Prefer this way
    </OverrideButton>
  );
}

/** "Allow here · 140 m": a limit no longer closes this run (for this plan; Lift changes the profile). */
export function AllowButton({ x, limit }: { x: EdgeExplanation; limit?: LimitId }) {
  const len = useRunText(x.edge);
  return (
    <OverrideButton kind="allow" x={x} {...(limit ? { limit } : {})}>
      Allow here · {len}
    </OverrideButton>
  );
}

/** Whether a direction of the way is closed by limits only (an allow opens it). */
export function allowable(x: EdgeExplanation): boolean {
  return [x.along, x.against].some(
    (a) => a.closed_by.length > 0 && a.closed_by.every((c) => c.by !== "no_bikes" && c.by !== "oneway"),
  );
}

/** The line under the actions: what each one does, in a rider's words. */
export function ActionsHint({ x, use }: { x: EdgeExplanation; use: boolean }) {
  const len = useRunText(x.edge);
  return (
    <p className="mt-1.5 text-muted-foreground text-xs leading-snug" data-testid="inspector-actions-hint">
      {use && "“Use this way” adds a stop here: the route must pass. "}
      “Prefer” adds no stop: these {len} count as little as Detours allow ({formatFactor(x.bounds.min_factor)}
      ), and the route takes them where that pays. Both apply to this plan only.
    </p>
  );
}

/** A way with an exception of the plan: what it does here, and the way back. */
export function PlanException({ o, x, onRoute }: { o: PlanOverride; x: EdgeExplanation; onRoute: boolean }) {
  const store = usePlanner();
  const catalogue = usePlan((s) => s.catalogue);
  const limit = o.limit ? (catalogue?.limits.find((l) => l.id === o.limit)?.label ?? o.limit) : null;
  const len = metresText(o.lengthM);
  const [title, text, stop] =
    o.kind === "avoid"
      ? [
          "Avoided in this plan",
          onRoute
            ? `The route still rides it: there is no other way, or a stop is on it (${len}).`
            : `The route takes any other way round these ${len}.`,
          "Stop avoiding",
        ]
      : o.kind === "prefer"
        ? [
            "Preferred in this plan",
            `These ${len} count as little as Detours allow (${formatFactor(x.bounds.min_factor)}), and no limit closes them.`,
            "Stop preferring",
          ]
        : [
            "Allowed in this plan",
            `${limit ? `“${limit}”` : "The limits"} ${limit ? "does" : "do"} not close these ${len}; the rest of the plan keeps ${limit ? "it" : "them"}.`,
            "Remove the exception",
          ];
  return (
    <div
      data-testid="inspector-exception"
      data-kind={o.kind}
      className="mb-2.5 rounded-control bg-foreground/[0.055] px-2.5 py-2 text-xs"
    >
      <p className="font-bold leading-snug">{title}</p>
      <p className="mt-0.5 leading-snug">{text}</p>
      <button
        type="button"
        data-testid="inspector-exception-remove"
        onClick={() => store.removeOverride(o.id)}
        className={cn(button, "mt-2 h-8 bg-card")}
      >
        <Undo2 className="size-3.5" />
        {stop}
      </button>
    </div>
  );
}
