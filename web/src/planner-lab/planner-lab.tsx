// TEMPORARY (the planner lab, #19): proves the engine end to end in the app. Tap the map to add A, B
// and further waypoints (drag to move, tap one to remove), pick a preset, see the route and its
// totals, and optionally a second preset's route to compare. Opened with `?lab`. The planner shell
// (docs/design/planner.md) replaces it: nothing outside src/planner-lab/ depends on it.
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useMemo, useState } from "react";
import { isSuperseded } from "@/engine/client";
import type { Preset, RouteResult } from "@/engine/generated/types";
import type { RouteOutcome } from "@/engine/protocol";
import { engineStore } from "@/engine/store";
import { useEngine } from "@/engine/use-engine";
import { COMPARE_COLOR, LabLayer, type LabLine, ROUTE_COLOR } from "./lab-layer";

type Point = { lon: number; lat: number };

type Line = { outcome: RouteOutcome | null; ms: number | null };

function totals(r: RouteResult) {
  const s = r.summary;
  const h = Math.floor(s.duration_s / 3600);
  const m = Math.round((s.duration_s % 3600) / 60);
  return {
    km: (s.distance_m / 1000).toFixed(1),
    climb: Math.round(s.ascent_m),
    time: `${h}:${String(m).padStart(2, "0")}`,
  };
}

function Totals({ line, color, testid }: { line: Line; color: string; testid: string }) {
  const o = line.outcome;
  if (!o) return null;
  if (!o.ok) {
    return (
      <p data-testid={`${testid}-error`} className="text-destructive text-xs">
        {o.error.message}
      </p>
    );
  }
  const t = totals(o.result);
  return (
    <p data-testid={testid} className="flex items-center gap-2 text-xs tabular-nums">
      <span className="inline-block h-1 w-4 rounded-full" style={{ background: color }} aria-hidden />
      <span>
        <span data-testid={`${testid}-km`}>{t.km}</span> km
      </span>
      <span>↑ {t.climb} m</span>
      <span>{t.time} h</span>
      {line.ms !== null && <span className="ml-auto text-muted-foreground">{Math.round(line.ms)} ms</span>}
    </p>
  );
}

const LAB_OPTIONS = { snap_radius_m: 250, geometry: true };

const selectClass = "h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm text-foreground";

export default function PlannerLab({ map }: { map: MapLibreMap | null }) {
  const engine = engineStore();
  const state = useEngine();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [main, setMain] = useState<string>("");
  const [compare, setCompare] = useState<string>("");
  const [points, setPoints] = useState<Point[]>([]);
  const [route, setRoute] = useState<Line>({ outcome: null, ms: null });
  const [second, setSecond] = useState<Line>({ outcome: null, ms: null });
  const [layer, setLayer] = useState<LabLayer | null>(null);

  useEffect(() => {
    void engine.call("presets").then((list) => {
      setPresets(list);
      setMain((m) => m || (list[0]?.id ?? ""));
    });
  }, [engine]);

  // the map: its layer, and taps add a waypoint
  useEffect(() => {
    if (!map) return;
    const l = new LabLayer(map);
    setLayer(l);
    const click = (event: { lngLat: { lng: number; lat: number } }) =>
      setPoints((p) => [...p, { lon: event.lngLat.lng, lat: event.lngLat.lat }]);
    map.on("click", click);
    return () => {
      map.off("click", click);
      l.destroy();
      setLayer(null);
    };
  }, [map]);

  useEffect(() => {
    layer?.setWaypoints(
      points,
      (i, p) => setPoints((all) => all.map((q, j) => (j === i ? p : q))),
      (i) => setPoints((all) => all.filter((_, j) => j !== i)),
    );
  }, [points, layer]);

  // route on every change, latest wins (one lane per line)
  const ready = state.status === "ready";
  const byId = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  useEffect(() => {
    const run = (id: string, lane: string, set: (l: Line) => void) => {
      const preset = byId.get(id);
      if (!ready || !preset || points.length < 2) {
        engine.client.cancel(lane);
        set({ outcome: null, ms: null });
        return;
      }
      const started = performance.now();
      void engine
        .routeLatest({ waypoints: points, profile: preset.profile, options: LAB_OPTIONS }, lane)
        .then((outcome) => {
          if (!isSuperseded(outcome)) set({ outcome, ms: performance.now() - started });
        });
    };
    run(main, "route", setRoute);
    run(compare, "route-compare", setSecond);
  }, [engine, ready, byId, main, compare, points]);

  useEffect(() => {
    const lines: LabLine[] = [];
    for (const [id, line] of [
      ["main", route],
      ["compare", second],
    ] as const) {
      const g = line.outcome?.ok ? line.outcome.result.geometry : undefined;
      if (g) lines.push({ id, coordinates: g.coordinates as [number, number][] });
    }
    layer?.setLines(lines);
  }, [route, second, layer]);

  return (
    <div
      data-testid="planner-lab"
      className="pointer-events-auto flex flex-col gap-2 rounded-lg border bg-card/95 p-3 text-card-foreground shadow-sm backdrop-blur"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-sm">Route lab</h2>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
          temporary
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-1 w-4 shrink-0 rounded-full" style={{ background: ROUTE_COLOR }} />
        <select
          data-testid="lab-preset"
          aria-label="Preset"
          className={selectClass}
          value={main}
          onChange={(e) => setMain(e.target.value)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.profile.name ?? p.id}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-1 w-4 shrink-0 rounded-full" style={{ background: COMPARE_COLOR }} />
        <select
          data-testid="lab-compare"
          aria-label="Compare with"
          className={selectClass}
          value={compare}
          onChange={(e) => setCompare(e.target.value)}
        >
          <option value="">No comparison</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.profile.name ?? p.id}
            </option>
          ))}
        </select>
      </div>
      {points.length < 2 ? (
        <p data-testid="lab-hint" className="text-muted-foreground text-xs">
          {ready
            ? points.length === 0
              ? "Tap the map to set A."
              : "Tap the map to set B."
            : "Waiting for the region graph…"}
        </p>
      ) : (
        <>
          <Totals line={route} color={ROUTE_COLOR} testid="lab-totals" />
          {compare && <Totals line={second} color={COMPARE_COLOR} testid="lab-compare-totals" />}
        </>
      )}
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span data-testid="lab-count">
          {points.length} waypoint{points.length === 1 ? "" : "s"}
        </span>
        {points.length > 0 && (
          <button type="button" className="underline" onClick={() => setPoints([])}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
