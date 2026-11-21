// "Map & rides" (docs/design/planner.md, `LayersPanel`): exactly one of the plain map, one information
// layer (with its legend) or the explored map; the relief and cycle-route toggles; "colour the route by
// surface"; inspecting a way; and the ride library, because it feeds the explored map. The map logic
// stays in src/map/ and the ride library's in src/rides/ (its panel is mounted here as it is).

import { cn } from "cn";
import { Crosshair } from "lucide-react";
import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { parsePreference, useThemePreference } from "@/lib/theme";
import type { InfoLayer, Legend as LegendSpec } from "@/map/info";
import { infoSpec } from "@/map/info";
import type { OverlayAttribute } from "@/map/manifest";
import { EXPLORED, type Theme } from "@/map/palette";
import { label, pill, Switch } from "./parts";
import { usePlan, usePlanner } from "./store";

/** The attributes worth a chip first; the rest behind "more". */
const FIRST = [
  "surface_class",
  "highway",
  "tracktype",
  "forest_share",
  "grade_max",
  "mtb_scale",
  "route_level",
];

export type LayersProps = {
  attributes: OverlayAttribute[];
  info: InfoLayer;
  onInfo: (info: InfoLayer) => void;
  /** `null`: the region has no terrain */
  terrain: boolean | null;
  onTerrain: (on: boolean) => void;
  routes: boolean;
  onRoutes: (on: boolean) => void;
  theme: Theme;
  ridden: number;
  ridesVisible: boolean;
  onRidesVisible: (on: boolean) => void;
  devTools: boolean;
  onFakeRidden: () => void;
  onClearRidden: () => void;
  /** the ride library's panel (src/components/rides-panel.tsx) */
  rides: React.ReactNode;
};

const LineKey = ({ color, neutral }: { color: string; neutral?: boolean | undefined }) => (
  <i className={cn("h-1 w-4 shrink-0 rounded-full", neutral && "opacity-90")} style={{ background: color }} />
);

/** An information layer's legend: swatches are data, the rest is ink. */
export function Legend({ legend, className }: { legend: LegendSpec; className?: string }) {
  return (
    <div data-testid="legend" className={cn("space-y-1.5 text-xs", className)}>
      {legend.kind === "categories" ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {legend.entries.map((e) => (
            <li
              key={e.label}
              data-testid="legend-entry"
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <LineKey color={e.color} neutral={e.neutral} />
              <span className="first-letter:uppercase">{e.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-1">
          <div
            data-testid="legend-ramp"
            className="h-1.5 w-full rounded-full"
            style={{ backgroundImage: `linear-gradient(to right, ${legend.stops.join(", ")})` }}
          />
          <div className="flex justify-between text-muted-foreground tabular-nums">
            <span>{legend.min}</span>
            <span>{legend.max}</span>
          </div>
        </div>
      )}
      <p data-testid="legend-note" className="text-muted-foreground leading-snug">
        {legend.note ? `${legend.note}. ` : ""}Everything else is the normal map.
      </p>
    </div>
  );
}

/** The explored map's legend, with the count of ridden ways. */
export function ExploredLegend({
  theme,
  ridden,
  className,
}: {
  theme: Theme;
  ridden: number;
  className?: string;
}) {
  return (
    <div data-testid="explored-legend" className={cn("space-y-1 text-xs", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <LineKey color={EXPLORED[theme]} />
          Ridden
        </span>
        <span className="text-muted-foreground">Never ridden stays the map</span>
      </div>
      <p className="text-muted-foreground">
        <span data-testid="ridden-count" className="font-semibold text-foreground tabular-nums">
          {ridden.toLocaleString("en")} edges
        </span>{" "}
        ridden{ridden === 0 ? " so far: your rides appear here once imported and matched." : "."}
      </p>
    </div>
  );
}

type Mode = "none" | "attribute" | "explored";

export function LayersPanel(p: LayersProps) {
  const store = usePlanner();
  const [appearance, setAppearance] = useThemePreference();
  const lineBy = usePlan((s) => s.lineBy);
  const inspect = usePlan((s) => s.inspect);
  const mode: Mode = p.info.kind;
  const [more, setMore] = useState(false);
  const [lastAttr, setLastAttr] = useState<OverlayAttribute | undefined>(
    p.info.kind === "attribute"
      ? p.info.attribute
      : (p.attributes.find((a) => a.key === "surface_class") ?? p.attributes[0]),
  );
  const first = p.attributes
    .filter((a) => FIRST.includes(a.key))
    .sort((a, b) => FIRST.indexOf(a.key) - FIRST.indexOf(b.key));
  const rest = p.attributes.filter((a) => !FIRST.includes(a.key));
  const active = p.info.kind === "attribute" ? p.info.attribute : null;
  const shown = more || (active && rest.includes(active)) ? [...first, ...rest] : first;
  const pick = (a: OverlayAttribute) => {
    setLastAttr(a);
    p.onInfo({ kind: "attribute", attribute: a });
  };
  const setMode = (m: Mode) => {
    if (m === "none") p.onInfo({ kind: "none" });
    else if (m === "explored") p.onInfo({ kind: "explored" });
    else if (lastAttr) pick(lastAttr);
    if (m !== "attribute" && inspect) store.setInspect(false);
  };
  return (
    <div className="space-y-3.5" data-testid="layers-panel">
      <div
        className="grid grid-cols-3 rounded-full bg-foreground/8 p-1 font-semibold text-xs"
        role="radiogroup"
        aria-label="What the map shows"
      >
        {(
          [
            ["none", "Map"],
            ["attribute", "Information"],
            ["explored", "Explored"],
          ] as const
        ).map(([key, name]) => (
          <button
            type="button"
            aria-pressed={mode === key}
            key={key}
            data-testid={`mode-${key}`}
            onClick={() => setMode(key)}
            className={cn("h-9 rounded-full", mode === key ? "bg-card shadow-sm" : "text-muted-foreground")}
          >
            {name}
          </button>
        ))}
      </div>

      {mode === "none" && (
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-sm">Colour the route by surface</span>
            <span className="block text-muted-foreground text-xs">
              Off: one line in the route colour. The timeline shows surface either way.
            </span>
          </span>
          <Switch
            on={lineBy === "surface"}
            name="Colour the route by surface"
            testid="line-by-surface"
            onClick={() => store.setLineBy(lineBy === "surface" ? "plain" : "surface")}
          />
        </div>
      )}

      {mode === "attribute" && active && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((a) => (
              <button
                type="button"
                key={a.key}
                data-testid={`info-${a.key}`}
                aria-pressed={a.key === active.key}
                onClick={() => pick(a)}
                className={cn(
                  pill,
                  "h-9 border px-3",
                  a.key === active.key
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:border-foreground/40",
                )}
              >
                {a.label}
              </button>
            ))}
            {!more && rest.length > 0 && !rest.includes(active) && (
              <button
                type="button"
                data-testid="info-more"
                onClick={() => setMore(true)}
                className={cn(
                  pill,
                  "h-9 border border-foreground/30 border-dashed px-3 text-muted-foreground",
                )}
              >
                +{rest.length} more
              </button>
            )}
          </div>
          <Legend legend={infoSpec(active, p.theme).legend} />
          <div className="flex items-center gap-3">
            <Crosshair className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-sm">Inspect a way</span>
              <span className="block text-muted-foreground text-xs">
                While on, a tap shows a way's data instead of adding a stop.
              </span>
            </span>
            <Switch
              on={inspect}
              name="Inspect a way"
              testid="inspect-toggle"
              onClick={() => store.setInspect(!inspect)}
            />
          </div>
        </>
      )}

      {mode === "explored" && (
        <>
          <ExploredLegend theme={p.theme} ridden={p.ridden} />
          {p.devTools && (
            <div className="flex gap-1.5">
              <button
                type="button"
                data-testid="fake-ridden"
                onClick={p.onFakeRidden}
                className={cn(pill, "h-8 border border-border px-3")}
              >
                Fake some
              </button>
              <button
                type="button"
                data-testid="clear-ridden"
                onClick={p.onClearRidden}
                className={cn(pill, "h-8 border border-border px-3")}
              >
                Clear
              </button>
            </div>
          )}
        </>
      )}

      <div className="space-y-2.5 border-border border-t pt-3.5">
        {p.terrain !== null && (
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 font-semibold text-sm">Relief and contour lines</span>
            <Switch
              on={p.terrain}
              name="Relief and contour lines"
              testid="toggle-terrain"
              onClick={() => p.onTerrain(!p.terrain)}
            />
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 font-semibold text-sm">Signed cycle routes</span>
          <Switch
            on={p.routes}
            name="Signed cycle routes"
            testid="toggle-routes"
            onClick={() => p.onRoutes(!p.routes)}
          />
        </div>
        <div className="flex items-center gap-3" data-testid="appearance">
          <span className="min-w-0 flex-1 font-semibold text-sm">Appearance</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Appearance"
            value={appearance}
            onValueChange={(v) => v && setAppearance(parsePreference(v))}
          >
            {(["system", "light", "dark"] as const).map((v) => (
              <ToggleGroupItem
                key={v}
                value={v}
                data-testid={`theme-${v}`}
                className="capitalize data-[state=on]:bg-foreground data-[state=on]:text-background"
              >
                {v}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 font-semibold text-sm">My rides on the map</span>
          <Switch
            on={p.ridesVisible}
            name="Show my rides on the map"
            testid="rides-toggle"
            onClick={() => p.onRidesVisible(!p.ridesVisible)}
          />
        </div>
      </div>

      <div className="border-border border-t pt-3.5">
        <div className={cn(label, "mb-2")}>My rides</div>
        {p.rides}
      </div>
    </div>
  );
}
