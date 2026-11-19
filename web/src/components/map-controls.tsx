// The map's chrome: deliberately minimal and replaceable (the planner design round decides the real
// layout). Everything here is presentation; the map logic lives in src/map/.
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatAttribute, type Legend, type MapMode } from "@/map/expressions";
import type { PickedEdge } from "@/map/inspect";
import type { Manifest, OverlayAttribute } from "@/map/manifest";
import { EXPLORED, type Theme } from "@/map/palette";

const MODE_LABELS: Record<MapMode, string> = { plain: "Plain", attribute: "Attribute", explored: "Explored" };

export function ModeSwitch({ mode, onChange }: { mode: MapMode; onChange: (mode: MapMode) => void }) {
  return (
    <ToggleGroup
      type="single"
      value={mode}
      // a single-type group reports "" when the active item is pressed again: stay put
      onValueChange={(value) => value && onChange(value as MapMode)}
      variant="outline"
      aria-label="Map mode"
      data-testid="mode-switch"
      className="pointer-events-auto bg-card/90 backdrop-blur"
    >
      {(Object.keys(MODE_LABELS) as MapMode[]).map((m) => (
        <ToggleGroupItem
          key={m}
          value={m}
          data-testid={`mode-${m}`}
          className="px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {MODE_LABELS[m]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function AttributePicker({
  attributes,
  value,
  onChange,
}: {
  attributes: OverlayAttribute[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid="attribute-picker"
        aria-label="Attribute"
        className="pointer-events-auto w-full bg-card/90 backdrop-blur dark:bg-card/90 md:w-60"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {attributes.map((a) => (
          <SelectItem key={a.key} value={a.key} data-testid={`attribute-${a.key}`}>
            {a.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Swatch({ color, neutral }: { color: string; neutral?: boolean | undefined }) {
  // map colours are not theme tokens: they come from src/map/palette.ts
  return (
    <span
      className={`inline-block h-2.5 w-5 shrink-0 rounded-full border border-foreground/20 ${neutral ? "opacity-90" : ""}`}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

export function LegendCard({ legend }: { legend: Legend }) {
  return (
    <Card
      data-testid="legend"
      className="pointer-events-auto gap-2 bg-card/90 px-3 py-2.5 text-xs backdrop-blur"
    >
      <div className="font-semibold text-sm">{legend.title}</div>
      {legend.kind === "categories" ? (
        <ul
          className={`grid max-h-44 gap-x-3 gap-y-1 overflow-y-auto md:max-h-64 ${legend.entries.length > 10 ? "grid-cols-2 md:grid-cols-1" : "grid-cols-1"}`}
        >
          {legend.entries.map((e) => (
            <li key={e.label} data-testid="legend-entry" className="flex items-center gap-2">
              <Swatch color={e.color} neutral={e.neutral} />
              <span className="truncate">{e.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-1.5">
          <div
            data-testid="legend-ramp"
            className="h-2.5 w-full rounded-full border border-foreground/20"
            style={{ backgroundImage: `linear-gradient(to right, ${legend.stops.join(", ")})` }}
          />
          <div className="flex justify-between text-muted-foreground">
            <span>{legend.min}</span>
            <span>{legend.max}</span>
          </div>
          <div data-testid="legend-entry" className="flex items-center gap-2">
            <Swatch color={legend.unknown.color} neutral />
            <span>{legend.unknown.label}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

export function ExploredCard({
  theme,
  ridden,
  devTools,
  onFake,
  onClear,
}: {
  theme: Theme;
  ridden: number;
  devTools: boolean;
  onFake: () => void;
  onClear: () => void;
}) {
  const colors = EXPLORED[theme];
  return (
    <Card
      data-testid="explored-legend"
      className="pointer-events-auto gap-2 bg-card/90 px-3 py-2.5 text-xs backdrop-blur"
    >
      <div className="font-semibold text-sm">Explored</div>
      <ul className="space-y-1">
        <li className="flex items-center gap-2">
          <Swatch color={colors.ridden} />
          Ridden
          <span data-testid="ridden-count" className="ml-auto tabular-nums text-muted-foreground">
            {ridden.toLocaleString("en")} edges
          </span>
        </li>
        <li className="flex items-center gap-2">
          <Swatch color={colors.never} />
          Never ridden
        </li>
      </ul>
      {devTools && (
        <div className="flex gap-2 border-t pt-2">
          <Button size="sm" variant="outline" data-testid="fake-ridden" onClick={onFake}>
            Fake some
          </Button>
          <Button size="sm" variant="outline" data-testid="clear-ridden" onClick={onClear}>
            Clear
          </Button>
        </div>
      )}
      {ridden === 0 && !devTools && (
        <p className="text-muted-foreground">Nothing yet: your rides appear here once imported.</p>
      )}
    </Card>
  );
}

export function InspectPanel({
  manifest,
  edge,
  onClose,
}: {
  manifest: Manifest;
  edge: PickedEdge;
  onClose: () => void;
}) {
  return (
    <Card
      data-testid="inspect-panel"
      data-edge-id={edge.id}
      className="pointer-events-auto max-h-[42vh] gap-2 overflow-y-auto bg-card/95 px-3 py-2.5 text-sm backdrop-blur md:max-h-[70vh]"
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold">Edge {edge.id}</div>
        <Button size="icon" variant="ghost" className="-mr-1 size-8" aria-label="Close" onClick={onClose}>
          <ChevronDown />
        </Button>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {manifest.overlay.attributes.map((a) => (
          <div key={a.key} className="contents" data-testid={`inspect-${a.key}`}>
            <dt className="text-muted-foreground">{a.label}</dt>
            <dd className="text-right tabular-nums">{formatAttribute(a, edge.properties[a.key])}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
