// The cost debug view's chrome (docs/planner.md, "Cost"): the key of the Cost layer, the tap panel
// (one edge's cost from `explainEdge`, verdict first) and the "why not through here?" card (`compare`).
// The words come from ./model.ts; data colours from src/map/palette.ts (the scale) and the planner's
// route colours.
import { cn } from "cn";
import { ChevronDown, Route, X } from "lucide-react";
import { useEffect, useState } from "react";
import { isSuperseded } from "@/engine/client";
import type {
  ArcCostExplanation,
  AttrValue,
  EdgeExplanation,
  PrefId,
  PrefPart,
} from "@/engine/generated/types";
import { COST_MINZOOM, costColorAt, costPosition, costTicks, formatFactor } from "@/map/cost";
import type { CostStatus } from "@/map/cost-layer";
import type { PickedEdge } from "@/map/inspect";
import { COST_CLOSED, COST_STOPS, type Theme } from "@/map/palette";
import { label, PrefRow, pill } from "../parts";
import { usePlan, usePlanner } from "../store";
import {
  betterArc,
  closureName,
  closureTag,
  edgeVerdict,
  isOpen,
  metresText,
  prefRowsOf,
  roleText,
  type Side,
  wayName,
  whyNot,
} from "./model";

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");

/** A line swatch in the cost layer's colour for a factor (closed: dashed ink). */
function FactorSwatch({
  factor,
  min,
  max,
  theme,
  wide,
}: {
  factor: number | null;
  min: number;
  max: number;
  theme: Theme;
  wide?: boolean;
}) {
  if (factor === null)
    return (
      <i
        className="mt-1.5 h-1 w-5 shrink-0 rounded-full"
        style={{
          backgroundImage: `repeating-linear-gradient(to right, ${COST_CLOSED[theme]} 0 4px, transparent 4px 7px)`,
        }}
      />
    );
  return (
    <i
      className={cn("mt-1.5 w-5 shrink-0 rounded-full", wide ? "h-1.5" : "h-1")}
      style={{ background: costColorAt(costPosition(factor, min, max), theme) }}
    />
  );
}

// ------------------------------------------------------------------ the key

/** The Cost layer's key: the scale, the clamp, closed ways, the one-way hint; the zoom hint. */
export function CostLegend({
  status,
  theme,
  compact,
  className,
}: {
  status: CostStatus;
  theme: Theme;
  /** the pill on the map: the scale and one line */
  compact?: boolean;
  className?: string;
}) {
  const { minFactor: min, maxFactor: max } = status;
  const catalogue = usePlan((s) => s.catalogue);
  const ticks = costTicks(min, max);
  const closed = status.closed.slice(0, 3);
  return (
    <div data-testid="cost-legend" data-state={status.state} className={cn("space-y-1.5 text-xs", className)}>
      {status.state === "zoom" && (
        <p data-testid="cost-zoom" className="font-semibold">
          Zoom in to see the cost of each way (from zoom {COST_MINZOOM}).
        </p>
      )}
      <div>
        <div
          className="h-1.5 w-full rounded-full"
          style={{ backgroundImage: `linear-gradient(to right, ${COST_STOPS[theme].join(", ")})` }}
        />
        <div className="relative mt-0.5 h-4 text-muted-foreground tabular-nums">
          {ticks.map((t, i) => (
            <span
              key={t.label}
              className={cn(
                "absolute top-0",
                i === 0 ? "left-0" : i === ticks.length - 1 ? "right-0" : "-translate-x-1/2",
              )}
              style={i === 0 || i === ticks.length - 1 ? undefined : { left: `${((t.t + 1) / 2) * 100}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div className="flex justify-between font-semibold">
          <span>preferred</span>
          <span>neutral</span>
          <span>avoided</span>
        </div>
      </div>
      {compact ? (
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <i className="h-2 w-3.5 rounded-full" style={{ background: costColorAt(-1, theme) }} />
            wide: at the detour limit
          </span>
          <span className="inline-flex items-center gap-1">
            <FactorSwatch factor={null} min={min} max={max} theme={theme} />
            closed
          </span>
        </p>
      ) : (
        <ul className="space-y-0.5">
          <li className="flex items-center gap-1.5">
            <i
              className="h-2 w-4 shrink-0 rounded-full"
              style={{ background: costColorAt(-1, theme) }}
              aria-hidden="true"
            />
            <span>
              <b>Wide:</b> at the detour limit {formatFactor(min)}, a stronger slider changes nothing
              {status.edges > 0 && status.atMin > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  ({Math.round((status.atMin / status.edges) * 100)} % of the ways here)
                </span>
              )}
            </span>
          </li>
          <li className="flex items-center gap-1.5" data-testid="cost-legend-closed">
            <FactorSwatch factor={null} min={min} max={max} theme={theme} />
            <span>
              <b>Dashed:</b> closed
              {closed.length > 0
                ? ` here by ${closed.map((c) => closureName(c.by, catalogue)).join(", ")}`
                : " by a limit or the law"}
            </span>
          </li>
          <li className="flex items-center gap-1.5">
            <span className="w-4 shrink-0 text-center font-bold leading-none">›</span>
            <span>cheaper (or only) direction, where they differ (from zoom 15)</span>
          </li>
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the tap panel

const fmtValue = (v: AttrValue | null) =>
  v === null ? "—" : typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v).replace(/_/g, " ");

const sameArc = (a: ArcCostExplanation, b: ArcCostExplanation) =>
  isOpen(a) === isOpen(b) &&
  Math.abs(a.factor - b.factor) < 1e-3 &&
  Math.abs((a.cost_per_m ?? 0) - (b.cost_per_m ?? 0)) < 1e-3;

/** quality × bonus (gate) → raw → clamped; additive terms; what the router pays. */
function Arithmetic({ arc, x, title }: { arc: ArcCostExplanation; x: EdgeExplanation; title?: string }) {
  const catalogue = usePlan((s) => s.catalogue);
  const row = "flex justify-between gap-3";
  return (
    <div className="space-y-0.5 text-xs" data-testid="cost-arithmetic">
      {title && <div className="font-semibold">{title}</div>}
      {!isOpen(arc) ? (
        arc.closed_by.map((c) => (
          <div key={c.by} className={row}>
            <span>Closed: {closureName(c.by, catalogue)}</span>
            <span className="text-muted-foreground">{closureTag(c)}</span>
          </div>
        ))
      ) : (
        <>
          <div className={row}>
            <span className="text-muted-foreground">Quality (surface, way, traffic…)</span>
            <span className="tabular-nums">{formatFactor(arc.quality)}</span>
          </div>
          <div className={row}>
            <span className="text-muted-foreground">
              × landscape bonuses{arc.bonus < 0.999 ? `, counting ${Math.round(arc.gate * 100)} %` : ""}
            </span>
            <span className="tabular-nums">{formatFactor(arc.bonus)}</span>
          </div>
          <div className={row}>
            <span className="text-muted-foreground">= before the limits</span>
            <span className="tabular-nums">{formatFactor(arc.raw_factor)}</span>
          </div>
          <div className={cn(row, "font-semibold")}>
            <span>
              {arc.clamp === "min"
                ? `held at the detour limit (${formatFactor(x.bounds.min_factor)})`
                : arc.clamp === "max"
                  ? `held at the ceiling (${formatFactor(x.bounds.max_factor)})`
                  : "factor"}
            </span>
            <span className="tabular-nums">{formatFactor(arc.factor)}</span>
          </div>
          {arc.additive.map((a) => (
            <div key={a.kind} className={row}>
              <span className="text-muted-foreground">+ {a.kind}</span>
              <span className="tabular-nums">+{metresText(a.metres)}</span>
            </div>
          ))}
          {arc.cost !== undefined && (
            <div className={row}>
              <span className="text-muted-foreground">The router counts {metresText(x.length_m)} as</span>
              <span className="tabular-nums">{metresText(arc.cost)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PrefLine({
  part,
  gate,
  alongside,
  open,
  onToggle,
}: {
  part: PrefPart;
  gate: number;
  /** the edge's traffic is the road's beside it */
  alongside: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const pref = usePlan((s) => s.catalogue?.preferences.find((p) => p.id === part.id));
  const inPlan = usePlan((s) => part.id in s.weights || (s.catalogue?.core.includes(part.id) ?? false));
  const role = roleText(part, gate, alongside);
  return (
    <li data-testid={`cost-pref-${part.id}`}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!inPlan}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left text-xs hover:bg-foreground/6"
      >
        <span className="min-w-0 flex-1 truncate font-semibold">{pref?.label ?? part.id}</span>
        {role && <span className="shrink-0 text-2xs text-muted-foreground">{role}</span>}
        <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
          {signed(part.weight)}
        </span>
        <span className="w-11 shrink-0 text-right font-bold tabular-nums">{formatFactor(part.factor)}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-180")} />
      </button>
      {open && (
        <div className="pb-1">
          <PrefRow id={part.id} />
        </div>
      )}
    </li>
  );
}

/** One tapped edge under the plan's profile: the verdict first, then the reasons and the arithmetic. */
export function CostPanel({
  edge,
  theme,
  desk,
  onClose,
  onWhyNot,
}: {
  edge: PickedEdge;
  theme: Theme;
  /** the profile card is on screen: a preference row also flashes there */
  desk: boolean;
  onClose: () => void;
  onWhyNot: (at: [number, number]) => void;
}) {
  const store = usePlanner();
  const catalogue = usePlan((s) => s.catalogue);
  const weights = usePlan((s) => s.weights);
  const limits = usePlan((s) => s.limits);
  const base = usePlan((s) => s.base);
  const canWhyNot = usePlan((s) => s.waypoints.length >= 2 && !!s.main.result);
  const [x, setX] = useState<EdgeExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PrefId | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the profile (weights, limits, base) is the input
  useEffect(() => {
    let live = true;
    store.explainEdge(edge.id).then(
      (r) => {
        if (!live || isSuperseded(r)) return;
        setX(r);
        setError(null);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [edge.id, weights, limits, base, store]);
  const fresh = x?.edge === edge.id ? x : null;
  const verdict = fresh ? edgeVerdict(fresh, catalogue) : null;
  const best = fresh ? (betterArc(fresh) ?? fresh.along) : null;
  const rows = best ? prefRowsOf(best) : null;
  const both = fresh && !sameArc(fresh.along, fresh.against);
  const toggle = (id: PrefId) => {
    setOpen(open === id ? null : id);
    if (desk && open !== id) store.flash(id);
  };
  return (
    <section
      data-testid="cost-panel"
      data-edge-id={edge.id}
      data-tone={verdict?.tone ?? ""}
      className="max-h-[46dvh] overflow-y-auto rounded-card border border-border bg-glass p-3.5 text-sm shadow-float backdrop-blur-xl md:max-h-[64dvh]"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className={label}>
          {fresh ? `${wayName(fresh.way)} · ${metresText(fresh.length_m)}` : `Way ${edge.id}`}
        </span>
        <button
          type="button"
          className="-mr-1 ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-foreground/8 hover:bg-foreground/12"
          aria-label="Close"
          data-testid="cost-close"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      {error && <p className="text-muted-foreground text-xs">Could not explain this way: {error}</p>}
      {!fresh && !error && <p className="text-muted-foreground text-xs">Explaining…</p>}
      {fresh && verdict && (
        <>
          <div className="flex gap-2">
            <FactorSwatch
              factor={verdict.factor}
              min={fresh.bounds.min_factor}
              max={fresh.bounds.max_factor}
              theme={theme}
              wide={best?.clamp !== undefined}
            />
            <div className="min-w-0">
              <p data-testid="cost-verdict" className="font-bold leading-snug">
                {verdict.title}
              </p>
              {verdict.notes.map((n) => (
                <p key={n} className="mt-0.5 text-muted-foreground text-xs leading-snug">
                  {n}
                </p>
              ))}
            </div>
          </div>
          {canWhyNot && edge.at && (
            <button
              type="button"
              data-testid="why-not"
              onClick={() => edge.at && onWhyNot(edge.at)}
              className={cn(pill, "mt-2.5 h-9 bg-foreground px-3.5 text-background")}
            >
              <Route className="size-4" />
              Why not through here?
            </button>
          )}
          {rows && rows.active.length > 0 && (
            <div className="mt-3">
              <div className={cn(label, "mb-0.5")}>What the profile says here</div>
              <ul data-testid="cost-prefs">
                {rows.active.map((p) => (
                  <PrefLine
                    key={p.id}
                    part={p}
                    gate={best?.gate ?? 1}
                    alongside={fresh?.traffic_from === "alongside"}
                    open={open === p.id}
                    onToggle={() => toggle(p.id)}
                  />
                ))}
              </ul>
            </div>
          )}
          {rows && rows.idle.length > 0 && (
            <p className="mt-1 px-1 text-muted-foreground text-xs">
              No effect here:{" "}
              {rows.idle
                .map((p) => catalogue?.preferences.find((c) => c.id === p.id)?.short ?? p.id)
                .join(", ")}
            </p>
          )}
          <div className="mt-3 space-y-2.5 border-border border-t pt-2.5">
            {both ? (
              <>
                <Arithmetic arc={fresh.along} x={fresh} title="Direction ›" />
                <Arithmetic arc={fresh.against} x={fresh} title="Direction ‹" />
              </>
            ) : (
              <Arithmetic arc={fresh.along} x={fresh} />
            )}
          </div>
          <details className="mt-2.5 border-border border-t pt-2 text-xs">
            <summary className="cursor-pointer font-semibold">The way's data</summary>
            <p className="mt-1 text-muted-foreground">
              Surface for the cost: {fresh.cost_surface.replace(/_/g, " ")} (
              {fresh.surface_source.replace(/_/g, " ")}), traffic {Math.round(fresh.traffic * 100)} %
              {fresh.traffic_from === "alongside" && " (from the road alongside)"}
            </p>
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
              {fresh.attributes.map((a) => (
                <div key={a.attribute} className="contents">
                  <dt className="text-muted-foreground">{a.attribute.replace(/_/g, " ")}</dt>
                  <dd className="text-right font-semibold tabular-nums">{fmtValue(a.value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ "why not through here?"

const KeyLine = ({ color }: { color: string }) => (
  <i className="h-1 w-4 shrink-0 rounded-full" style={{ background: color }} />
);

function SideCell({ s, name }: { s: Side; name: string }) {
  if (s.empty)
    return (
      <div className="min-w-0 space-y-0.5">
        <div className="font-semibold">{name}</div>
        <div className="text-muted-foreground">nothing: it goes straight on</div>
      </div>
    );
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="font-semibold">{name}</div>
      <div className="tabular-nums">
        {s.length} at <b>{s.factor}</b>
      </div>
      <div className="text-muted-foreground tabular-nums">{s.cost}</div>
      {s.ways && <div className="text-muted-foreground">{s.ways}</div>}
      {s.reasons && <div className="text-muted-foreground">{s.reasons}</div>}
      {s.atMin >= 0.05 && (
        <div className="text-muted-foreground">{Math.round(s.atMin * 100)} % at the detour limit</div>
      )}
      {s.closed && <div className="font-semibold">{s.closed}</div>}
    </div>
  );
}

/** The comparison with the route through the tapped point: a verdict, the diagnosis, the stretches. */
export function WhyNotCard() {
  const store = usePlanner();
  const w = usePlan((s) => s.whyNot);
  const catalogue = usePlan((s) => s.catalogue);
  const [all, setAll] = useState(false);
  if (!w) return null;
  const minFactor = store.profile().bounds?.min_factor ?? catalogue?.bounds.min_factor.default ?? 0.5;
  const summary = w.comparison ? whyNot(w.comparison, minFactor, catalogue) : null;
  const shown = summary ? (all ? summary.stretches : summary.stretches.slice(0, 2)) : [];
  return (
    <div data-testid="whynot-card" className="text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-semibold text-xs">
        <span className="flex items-center gap-1.5">
          <KeyLine color="var(--route)" />
          Planned
        </span>
        <span className="flex items-center gap-1.5">
          <KeyLine color="var(--route-alt)" />
          Through here
        </span>
      </div>
      {w.line.error ? (
        <p className="mt-1.5 text-muted-foreground">No route through here: {w.line.error.message}</p>
      ) : !summary ? (
        <p className="mt-1.5 text-muted-foreground">Routing through here…</p>
      ) : (
        <>
          <p data-testid="whynot-headline" className="mt-1.5 font-bold leading-snug">
            {summary.headline}
          </p>
          {summary.hints.map((h) => (
            <p key={h} data-testid="whynot-hint" className="mt-1 text-xs leading-snug">
              {h}
            </p>
          ))}
        </>
      )}
      <div className="mt-2.5 flex gap-1.5">
        <button
          type="button"
          data-testid="whynot-use"
          disabled={!w.line.result}
          onClick={() => store.acceptWhyNot()}
          className={cn(pill, "h-9 bg-foreground px-3.5 text-background disabled:opacity-50")}
        >
          Use this route
        </button>
        <button
          type="button"
          data-testid="whynot-back"
          onClick={() => store.endWhyNot()}
          className={cn(pill, "h-9 px-3 text-muted-foreground hover:text-foreground")}
        >
          Back to the plan
        </button>
      </div>
      {summary &&
        shown.map((s, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stretches have no id, their order is stable
            key={i}
            data-testid="whynot-stretch"
            className="mt-2.5 border-border border-t pt-2 text-xs"
          >
            <div className="mb-1 font-semibold">
              {summary.stretches.length > 1 ? `Where they part (${i + 1}): ` : "Where they part: "}
              <span className="font-normal">through here is {s.delta}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <SideCell s={s.planned} name="Planned" />
              <SideCell s={s.through} name="Through here" />
            </div>
          </div>
        ))}
      {summary && !all && summary.stretches.length > 2 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1.5 text-muted-foreground text-xs underline"
        >
          {summary.stretches.length - 2} more stretches
        </button>
      )}
    </div>
  );
}
