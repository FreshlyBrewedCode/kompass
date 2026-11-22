// The Cost layer's key (docs/planner.md, "Cost"): the scale, the clamp, closed ways. A tap on the layer
// opens the segment inspector (../inspector/), which took over the tap panel and the "why not" card.
// The words come from ./model.ts; data colours from src/map/palette.ts (the scale).
import { cn } from "cn";
import { COST_MINZOOM, costColorAt, costPosition, costTicks, formatFactor } from "@/map/cost";
import type { CostStatus } from "@/map/cost-layer";
import { COST_CLOSED, COST_STOPS, type Theme } from "@/map/palette";
import { usePlan } from "../store";
import { closureName } from "./model";

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
