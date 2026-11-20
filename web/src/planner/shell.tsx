// The planner shell on the consolidated design (docs/design/planner.md): one set of parts (parts.tsx),
// one state model (store.ts); this file arranges them per breakpoint and wires the region map, the
// engine and the ride library.
// - phone (< 720 px wide, or < 560 px high): the map keeps the screen. Bottom stack: summary card,
//   chip strip, agent bar. Everything larger than one row is a bottom sheet, one at a time.
// - tablet (720 … 1099 px): the desk's route card with the phone's strip; sheets become a side panel.
// - desk (≥ 1100 px): route card left, profile card right; "Map & rides" is a popover.
import { cn } from "cn";
import { Bookmark, ChevronUp, Layers, Lock, Plus, SlidersHorizontal, X } from "lucide-react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { InspectPanel } from "@/components/map-controls";
import type { MapHandle } from "@/components/map-view";
import { RidesPanel } from "@/components/rides-panel";
import type { LimitId, PrefId } from "@/engine/generated/types";
import type { GeometryMode } from "@/engine/protocol";
import { engineStore } from "@/engine/store";
import { useEngine } from "@/engine/use-engine";
import { exploredStore } from "@/history/explored-store";
import { useTheme } from "@/lib/theme";
import { devEnabled } from "@/map/dev";
import { type InfoLayer, infoLayerFromName, infoSpec, type MapLayers } from "@/map/info";
import type { PickedEdge } from "@/map/inspect";
import type { Manifest } from "@/map/manifest";
import { ridesState } from "@/rides/session";
import type { RideSummary } from "@/rides/types";
import { ExploredLegend, LayersPanel, Legend } from "./layers-panel";
import { presetName, waypointLabel } from "./model";
import { dataVars } from "./palette";
import {
  AgentBar,
  BusyBar,
  ComparePick,
  CompareResult,
  card,
  DeltaLine,
  DiffBar,
  EngineBadge,
  GpxButton,
  IconButton,
  LaneStrip,
  LimitRow,
  label,
  Mark,
  Picker,
  PrefRow,
  ProfileList,
  RouteDetails,
  Soon,
  Stats,
  StatusBody,
  useFlashScroll,
  useStatus,
} from "./parts";
import { type LayerView, RouteLayer } from "./route-layer";
import { engineAdapter, PlannerContext, PlannerStore, usePlan, usePlanner } from "./store";

const MapView = lazy(() => import("@/components/map-view"));

const params = new URLSearchParams(location.search);
const DEV = devEnabled(location.search);
/** how many edges the dev button fakes */
const FAKE_COUNT = 400;
/** `?geometry=lazy`: geometry tiles load per route instead of up front (docs/engine-web.md) */
const GEOMETRY: GeometryMode = params.get("geometry") === "lazy" ? "lazy" : "eager";
/** `?terrain=0` / `?routes=0` start with a toggle off. */
const flag = (name: string) => params.get(name) !== "0";

export type Mode = "phone" | "tablet" | "desk";

/** The breakpoints: they switch the arrangement, not the parts. */
const readSize = () => ({ w: window.innerWidth, h: window.innerHeight });
export function useMode(): { mode: Mode; w: number; h: number } {
  const read = readSize;
  const [s, setS] = useState(read);
  useEffect(() => {
    const on = () => setS(readSize());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const mode: Mode = s.w < 720 || s.h < 560 ? "phone" : s.w < 1100 ? "tablet" : "desk";
  return { mode, ...s };
}

function useHeight(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(200);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setH(Math.round(e.contentRect.height)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, h];
}

/** Dropping files anywhere on the page imports them as rides (and keeps the browser from opening them). */
function useFileDrop(onFiles: (files: File[]) => void) {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      latest.current(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
}

/** What the arrangement needs from the screen: the parts that are not the planner's own. */
type Slots = {
  mode: Mode;
  w: number;
  h: number;
  /** the "Map & rides" content */
  layers: ReactNode;
  /** the active layer's legend for the pill (`null`: the plain map) */
  legend: { name: string; body: ReactNode } | null;
  picked: PickedEdge | null;
  inspectCard: ReactNode;
  ridesCount: number;
  onRetry: () => void;
};

// ------------------------------------------------------------------ the screen

export function PlannerScreen({ manifest, dataUrl }: { manifest: Manifest; dataUrl: string }) {
  const theme = useTheme();
  const { mode, w, h } = useMode();
  const engine = engineStore();
  const engineState = useEngine();
  const store = useMemo(
    () => new PlannerStore(engineAdapter(engine), { bounds: manifest.bounds }),
    [engine, manifest],
  );
  const attributes = manifest.overlay.attributes;
  const [info, setInfo] = useState<InfoLayer>(() => infoLayerFromName(params.get("layer"), attributes));
  const [terrain, setTerrain] = useState(() => flag("terrain"));
  const [routes, setRoutes] = useState(() => flag("routes"));
  const [picked, setPicked] = useState<PickedEdge | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const mapRef = useRef<MapHandle>(null);
  const inspect = useSyncExternalStore(store.subscribe, () => store.getSnapshot().inspect);
  const ridden = useSyncExternalStore(
    (onChange) => exploredStore.subscribe(onChange),
    () => exploredStore.size,
  );

  // the planner: presets and catalogue, then routes once the graph is in; the plan is saved on page hide
  useEffect(() => {
    void store.init().catch(() => undefined);
    const hide = () => store.flush();
    window.addEventListener("pagehide", hide);
    if (DEV) {
      const win = window as unknown as { __kompass?: object };
      win.__kompass = Object.assign(win.__kompass ?? {}, { planner: store });
    }
    return () => {
      window.removeEventListener("pagehide", hide);
      store.flush();
    };
  }, [store]);
  useEffect(() => store.setEngineReady(engineState.status === "ready"), [store, engineState.status]);
  // the ride library hands the engine a new personal layer (ridden ways) after matching: route again
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = exploredStore.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => store.refresh(), 400);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [store]);

  // the engine: the region graph downloads (once per build) and loads in its worker
  const loadGraph = useCallback(() => {
    if (manifest.graph) void engine.load(dataUrl, manifest.graph, GEOMETRY).catch(() => undefined);
  }, [engine, manifest, dataUrl]);
  useEffect(() => {
    loadGraph();
    if (DEV) {
      const win = window as unknown as { __kompass?: object };
      win.__kompass = Object.assign(win.__kompass ?? {}, { engine });
    }
  }, [loadGraph, engine]);

  // the ride library (src/rides/): its worker starts here; the explored map follows its saved matches
  const library = ridesState();
  const rides = useSyncExternalStore(library.subscribe, library.getSnapshot);
  const [ridesVisible, setRidesVisible] = useState(true);
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  useEffect(() => {
    // matches belong to a graph build (docs/rides.md): the engine's build id
    library.attachExplored(exploredStore, manifest.graph?.buildId ?? manifest.buildId ?? manifest.builtAt);
    void library.init();
    if (DEV) {
      const win = window as unknown as { __kompass?: object };
      win.__kompass = Object.assign(win.__kompass ?? {}, { rides: library, ridesCall: library.call });
    }
  }, [library, manifest]);
  useFileDrop((files) => {
    store.open("layers");
    void library.importFiles(files);
  });

  // inspect only while asked for (a tap otherwise adds a stop); leaving the information layer ends it
  useEffect(() => {
    if (info.kind !== "attribute" && inspect) store.setInspect(false);
  }, [info, inspect, store]);
  useEffect(() => {
    if (!inspect) setPicked(null);
  }, [inspect]);

  // the planner's layer on the region map
  const layerRef = useRef<RouteLayer | null>(null);
  const view = useRef<LayerView | null>(null);
  const [stackH, setStackH] = useState(200);
  const padding = () => {
    if (mode === "phone") return { top: 76, bottom: Math.min(stackH, h * 0.6) + 40, left: 40, right: 40 };
    const left = mode === "desk" ? 372 : 340;
    return {
      top: 96,
      bottom: mode === "desk" ? 90 : stackH + 50,
      left: left + 56,
      right: mode === "desk" ? 404 + 56 : 56,
    };
  };
  view.current = {
    theme,
    plain: info.kind === "none",
    notes: mode === "desk" ? 3 : 2,
    padding,
    onCoveredTap: () => {
      const s = store.getSnapshot();
      if (s.sheet !== null || (mode !== "desk" && s.picker)) {
        store.open(null);
        return true;
      }
      return false;
    },
  };
  useEffect(() => {
    if (!map || !view.current) return;
    const current = view.current;
    const layer = new RouteLayer(map, store, {
      ...current,
      padding: () => view.current?.padding() ?? current.padding(),
      onCoveredTap: () => view.current?.onCoveredTap() ?? false,
    });
    layerRef.current = layer;
    return () => {
      layer.destroy();
      layerRef.current = null;
    };
  }, [map, store]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view (a ref) follows theme, layer and breakpoint
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    layerRef.current?.setView({
      ...current,
      padding: () => view.current?.padding() ?? current.padding(),
      onCoveredTap: () => view.current?.onCoveredTap() ?? false,
    });
  }, [theme, info.kind, mode]);

  const layers = useMemo<MapLayers>(() => ({ info, terrain, routes }), [info, terrain, routes]);
  const focusRide = (ride: RideSummary | null) => {
    setSelectedRide(ride?.id ?? null);
    const pad =
      mode === "phone"
        ? { top: 80, bottom: Math.round(h * 0.6) + 30, left: 32, right: 32 }
        : {
            top: 80,
            bottom: 60,
            left: (mode === "desk" ? 372 : 340) + 56,
            right: mode === "desk" ? 404 + 344 + 80 : 460,
          };
    mapRef.current?.focusRide(ride, pad);
  };

  const legend =
    info.kind === "attribute"
      ? { name: info.attribute.label, body: <Legend legend={infoSpec(info.attribute, theme).legend} /> }
      : info.kind === "explored"
        ? { name: "Explored", body: <ExploredLegend theme={theme} ridden={ridden} /> }
        : null;

  const layersPanel = (
    <LayersPanel
      attributes={attributes}
      info={info}
      onInfo={setInfo}
      terrain={manifest.terrain ? terrain : null}
      onTerrain={setTerrain}
      routes={routes}
      onRoutes={setRoutes}
      theme={theme}
      ridden={ridden}
      ridesVisible={ridesVisible}
      onRidesVisible={setRidesVisible}
      devTools={DEV}
      onFakeRidden={() => mapRef.current?.fakeRidden(FAKE_COUNT)}
      onClearRidden={() => exploredStore.clear()}
      rides={
        <RidesPanel
          snapshot={rides}
          state={library}
          selectedId={selectedRide}
          onSelect={focusRide}
          onClose={() => {
            focusRide(null);
            store.open(null);
          }}
          className="relative h-[min(460px,70dvh)] gap-0 overflow-hidden rounded-control border-border bg-card p-0 shadow-none"
        />
      }
    />
  );

  return (
    <PlannerContext.Provider value={store}>
      <div
        className="absolute inset-0 overflow-hidden bg-background text-foreground"
        style={
          {
            ...dataVars(theme),
            "--attrib-bottom": mode === "phone" ? `${Math.min(stackH, h * 0.6) + 18}px` : "0px",
          } as CSSProperties
        }
      >
        <Suspense fallback={null}>
          <MapView
            ref={mapRef}
            manifest={manifest}
            dataUrl={dataUrl}
            layers={layers}
            store={exploredStore}
            rides={rides.layer}
            ridesVisible={ridesVisible}
            picking={inspect}
            onPick={setPicked}
            onError={setMapError}
            onMap={setMap}
          />
        </Suspense>
        <Arrangement
          mode={mode}
          w={w}
          h={h}
          layers={layersPanel}
          legend={legend}
          picked={picked}
          ridesCount={rides.rides.length}
          onRetry={loadGraph}
          onStackHeight={setStackH}
          inspectCard={
            picked ? (
              <InspectPanel
                manifest={manifest}
                edge={picked}
                onClose={() => mapRef.current?.clearSelection()}
              />
            ) : null
          }
        />
        {mapError && (
          <div
            data-testid="map-error"
            className={cn(
              card,
              "absolute top-[calc(max(var(--gutter),env(safe-area-inset-top))+52px)] left-1/2 z-30 -translate-x-1/2 px-3 py-2 text-xs",
            )}
          >
            Map data problem: {mapError}
          </div>
        )}
      </div>
    </PlannerContext.Provider>
  );
}

function Arrangement(props: Slots & { onStackHeight: (h: number) => void }) {
  useFlashScroll();
  // a preference added from the strip's "+" opens as a chip straight away
  const store = usePlanner();
  const fresh = usePlan((s) => s.fresh);
  useEffect(() => {
    if (props.mode === "desk" || !fresh) return;
    if (store.getSnapshot().sheet === null) store.setChip(fresh);
  }, [fresh, props.mode, store]);
  return props.mode === "phone" ? <Phone {...props} /> : <Desk {...props} />;
}

// ------------------------------------------------------------------ top bar, legend pill, inspect

const TOP = "top-[max(var(--gutter),env(safe-area-inset-top))]";
const BOTTOM = "bottom-[calc(var(--gutter)+env(safe-area-inset-bottom))]";

function TopBar({ wide, ridesCount }: { wide?: boolean; ridesCount: number }) {
  const store = usePlanner();
  const sheet = usePlan((s) => s.sheet);
  const on = sheet === "layers";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-(--gutter) z-10 flex items-start justify-between gap-2 *:pointer-events-auto",
        TOP,
      )}
    >
      <div className="flex gap-2">
        <EngineBadge
          className={cn(
            card,
            "relative flex h-10 items-center gap-2 rounded-full",
            wide ? "pr-4 pl-2.5" : "w-10 justify-center",
          )}
        >
          <Mark size={20} />
          {wide && <span className="font-extrabold text-base tracking-tight">kompass</span>}
        </EngineBadge>
        <Soon className={cn(card, "h-10 rounded-full border-dashed px-3.5 text-xs")}>Ride mode</Soon>
      </div>
      <div className={cn(card, "flex h-10 items-center rounded-full px-1")}>
        <button
          type="button"
          aria-label="Map & rides"
          aria-expanded={on}
          data-testid="map-rides"
          title="Map & rides"
          onClick={() => store.open(on ? null : "layers")}
          className={cn(
            "grid size-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
            on && "bg-foreground text-background",
          )}
        >
          <Layers className="size-4" />
          <span className="sr-only">
            , <span data-testid="rides-count">{ridesCount.toLocaleString("en")}</span> rides
          </span>
        </button>
      </div>
    </div>
  );
}

/** While a layer is on and its panel is closed, its legend stays on the map. */
function LegendPill({
  legend,
  className,
  style,
}: {
  legend: Slots["legend"];
  className?: string;
  style?: CSSProperties;
}) {
  const store = usePlanner();
  const sheet = usePlan((s) => s.sheet);
  if (!legend || sheet === "layers") return null;
  return (
    <div
      data-testid="legend-pill"
      style={style}
      className={cn(
        card,
        "absolute z-10 max-w-[min(420px,calc(100%-2*var(--gutter)))] rounded-control px-3 py-2 text-left",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`${legend.name}: open Map & rides`}
        onClick={() => store.open("layers")}
        className="absolute inset-0 z-10 cursor-pointer rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className={label}>{legend.name}</span>
      <div className="mt-1">{legend.body}</div>
    </div>
  );
}

function InspectBanner({ className, style }: { className?: string; style?: CSSProperties }) {
  const store = usePlanner();
  const inspect = usePlan((s) => s.inspect);
  if (!inspect) return null;
  return (
    <div
      style={style}
      className={cn(
        card,
        "absolute z-10 flex h-10 items-center gap-2 rounded-full pr-1 pl-3.5 text-sm",
        className,
      )}
      data-testid="inspect-banner"
    >
      <span className="font-semibold">Tap a way to inspect it</span>
      <button
        type="button"
        data-testid="inspect-done"
        onClick={() => store.setInspect(false)}
        className="h-8 rounded-full bg-foreground px-3 font-semibold text-background text-xs"
      >
        Done
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ the chip strip (phone, tablet)

const ROW = 36;
const GAP = 6;
const chipName = (id: string, short: string | undefined) => (id === "novel" ? "Never ridden" : (short ?? id));

/**
 * The profile as chips: the profile itself first (opens the whole list), then one chip per
 * preference, the limits as one chip, and "add". It never scrolls sideways: it wraps to two rows at
 * most, changed preferences first, and what does not fit collapses into "+N".
 */
function Strip({ rows = 2 }: { rows?: number }) {
  const store = usePlanner();
  const ref = useRef<HTMLDivElement>(null);
  const prefIds = usePlan((s) => s.prefIds);
  const changes = usePlan((s) => s.changes);
  const chip = usePlan((s) => s.chip);
  const sheet = usePlan((s) => s.sheet);
  const base = usePlan((s) => s.base);
  const limitIds = usePlan((s) => s.limitIds);
  const limits = usePlan((s) => s.limits);
  const weights = usePlan((s) => s.weights);
  const catalogue = usePlan((s) => s.catalogue);
  const engine = useEngine();
  const changedIds = new Set(changes.map((c) => c.id));
  const ids = [...prefIds.filter((id) => changedIds.has(id)), ...prefIds.filter((id) => !changedIds.has(id))];
  const [n, setN] = useState(ids.length);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  // fit: start from all chips whenever the set or the width changes, then drop from the end until it fits
  const key = `${ids.join()}|${width}|${presetName(base)}|${changes.length}|${rows}`;
  const last = useRef("");
  useLayoutEffect(() => {
    if (last.current !== key) {
      last.current = key;
      if (n !== ids.length) return setN(ids.length);
    }
    if (ref.current && ref.current.offsetHeight > rows * ROW + (rows - 1) * GAP + 1 && n > 0) setN(n - 1);
  });
  const chipCls = (on: boolean) =>
    cn(
      "flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 font-semibold text-xs shadow-float backdrop-blur-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
      on ? "border-transparent bg-foreground text-background" : "border-border bg-glass",
    );
  const limitsOn = limitIds.filter((id) => limits[id] !== undefined && limits[id] !== false).length;
  const limitsChanged = limitIds.some((id) => changedIds.has(id));
  const toLimits = () => {
    store.open("profile");
    window.setTimeout(
      () => document.getElementById("kp-limits")?.scrollIntoView({ block: "start", behavior: "smooth" }),
      320,
    );
  };
  const dot = <i className="size-1.5 shrink-0 rounded-full bg-signal" />;
  const inert = engine.status === "downloading";
  return (
    <div
      ref={ref}
      data-testid="strip"
      className={cn("flex flex-wrap gap-1.5", inert && "pointer-events-none opacity-50")}
    >
      <button
        type="button"
        data-testid="profile-chip"
        onClick={() => store.open(sheet === "profile" ? null : "profile")}
        className={chipCls(sheet === "profile")}
        aria-label={`Profile: ${presetName(base)}${changes.length ? `, ${changes.length} changes` : ""}. Open the whole profile`}
      >
        {base?.own ? <Bookmark className="size-3.5" /> : <SlidersHorizontal className="size-3.5" />}
        <span className="max-w-36 truncate font-bold">{presetName(base)}</span>
        {changes.length > 0 && (
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-signal px-1 font-bold text-2xs text-signal-foreground">
            {changes.length}
          </span>
        )}
        <ChevronUp className="size-3.5 opacity-60" />
      </button>
      {ids.slice(0, n).map((id) => {
        const v = weights[id] ?? 0;
        const pref = catalogue?.preferences.find((p) => p.id === id);
        return (
          <button
            type="button"
            key={id}
            data-testid={`chip-${id}`}
            aria-pressed={chip === id}
            onClick={() => store.setChip(chip === id ? null : id)}
            className={chipCls(chip === id)}
          >
            {changedIds.has(id) && dot}
            {chipName(id, pref?.short)}
            <span className="relative h-1 w-6 overflow-hidden rounded-full bg-current/20">
              <i
                className="absolute inset-y-0 rounded-full bg-current"
                style={{ left: `${(Math.min(v, 0) + 100) / 2}%`, width: `${Math.max(8, Math.abs(v) / 2)}%` }}
              />
            </span>
          </button>
        );
      })}
      {ids.length > n && (
        <button
          type="button"
          onClick={() => store.open("profile")}
          className={chipCls(false)}
          aria-label={`${ids.length - n} more preferences`}
        >
          +{ids.length - n}
        </button>
      )}
      {limitIds.length > 0 && (
        <button
          type="button"
          data-testid="limits-chip"
          onClick={toLimits}
          className={chipCls(false)}
          aria-label={`${limitsOn} limits`}
        >
          {limitsChanged && dot}
          <Lock className="size-3.5" />
          <span className="tabular-nums">{limitsOn}</span>
        </button>
      )}
      <button
        type="button"
        data-testid="strip-add"
        onClick={() => store.setPicker(true)}
        className={cn(chipCls(false), "border-foreground/35 border-dashed px-2.5")}
        aria-label="Add a preference or limit"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/** One chip's editor: a single slider (or limit) with its explanation. The map stays visible. */
function Tune({ id }: { id: string }) {
  const store = usePlanner();
  const pref = usePlan((s) => s.catalogue?.preferences.find((p) => p.id === id));
  const limit = usePlan((s) => s.catalogue?.limits.find((l) => l.id === id));
  const ms = usePlan((s) => s.main.ms);
  return (
    <div data-testid="tune">
      {pref ? <PrefRow id={id as PrefId} /> : <LimitRow id={id as LimitId} />}
      <div className="flex items-center gap-2 px-1 pt-0.5 text-muted-foreground text-xs">
        <span className="min-w-0 flex-1 truncate">{pref?.hint ?? limit?.hint}</span>
        {ms !== null && <span className="shrink-0 tabular-nums">rerouted in {Math.round(ms)} ms</span>}
        <IconButton label="Done" onClick={() => store.setChip(null)} className="-my-1 size-8">
          <X className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

const showLimits = (store: PlannerStore, mode: Mode) => {
  if (mode !== "desk") store.open("profile");
  window.setTimeout(
    () => document.getElementById("kp-limits")?.scrollIntoView({ block: "start", behavior: "smooth" }),
    320,
  );
};

/**
 * The card above the strip. On the phone it is the route's summary (tap it for the details) and
 * turns into whatever needs the map beside it: one chip's slider, a comparison, a state. On the
 * tablet the totals live in the route card, so it only appears for the slider and the comparison.
 */
function SummaryCard({
  totals = true,
  mode,
  onRetry,
}: {
  totals?: boolean;
  mode: Mode;
  onRetry: () => void;
}) {
  const store = usePlanner();
  const status = useStatus();
  const comparing = usePlan((s) => !!s.compareId);
  const chip = usePlan((s) => s.chip);
  const r = usePlan((s) => s.main.result);
  if (status) {
    // the profile can be set before there is a route: a chip's slider stays under the state
    const tune = chip ? (
      <div className={cn(totals && "mt-2.5 border-border border-t pt-2")}>
        <Tune id={chip} />
      </div>
    ) : null;
    if (!totals) return tune ? <section className={cn(card, "p-3.5 pt-2.5")}>{tune}</section> : null;
    return (
      <section className={cn(card, "p-3.5")} data-testid="summary">
        <StatusBody onShowLimits={() => showLimits(store, mode)} onRetry={onRetry} />
        {tune}
      </section>
    );
  }
  if (comparing)
    return (
      <section className={cn(card, "p-3.5")} data-testid="summary">
        <CompareResult />
      </section>
    );
  if (!totals)
    return chip ? (
      <section className={cn(card, "p-3.5 pt-2.5")}>
        <Tune id={chip} />
      </section>
    ) : null;
  return (
    <section className={cn(card, "p-3.5")} data-testid="summary">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Show the route details"
          data-testid="open-route"
          onClick={() => store.open("route")}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Stats size={chip ? "sm" : "lg"} />
          <ChevronUp className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </button>
        <GpxButton compact />
      </div>
      <BusyBar />
      {!chip && r && <LaneStrip route={r} by="surface" className="mt-3 h-1.5" />}
      <DeltaLine max={chip ? 3 : 4} className="mt-2" />
      {chip && (
        <div className="mt-2.5 border-border border-t pt-2">
          <Tune id={chip} />
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ sheets (phone, tablet)

/**
 * A sheet: from the bottom on a narrow screen (two detents, the grabber toggles or drags), a panel
 * on the right when there is room beside it. `clear` is hold-to-clear: everything but `data-keep`
 * and the held row fades, the map shows through.
 */
function Sheet({
  side,
  full,
  clear,
  vh,
  head,
  name,
  onHeight,
  onClose,
  children,
}: {
  side: boolean;
  full?: boolean;
  clear?: boolean;
  vh: number;
  head: ReactNode;
  name: string;
  onHeight?: (h: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const stops = [Math.round(vh * 0.6), vh - 64];
  const [detent, setDetent] = useState(0);
  const [pull, setPull] = useState<number | null>(null);
  const at = full ? 1 : detent;
  const height = pull ?? (stops[at] as number);
  const ref = useRef<HTMLElement>(null);
  useEffect(
    () => onHeight?.(side ? 0 : Math.min(height, stops[0] as number)),
    [height, side, onHeight, stops[0]],
  );
  // focus moves into the sheet when it opens; Escape closes it
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const grip = {
    onPointerDown: (e: React.PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      const h0 = stops[at] as number;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientY - y0) > 4) moved = true;
        if (moved) setPull(Math.max(160, Math.min(vh - 40, h0 + y0 - ev.clientY)));
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        setPull(null);
        const hh = h0 + y0 - ev.clientY;
        if (moved && hh < (stops[0] as number) * 0.55) onClose();
        else
          setDetent(
            moved
              ? Math.abs((stops[0] as number) - hh) < Math.abs((stops[1] as number) - hh)
                ? 0
                : 1
              : 1 - at,
          );
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    },
    style: { touchAction: "none" as const },
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };
  if (side)
    return (
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-label={name}
        onKeyDown={keys}
        data-testid="sheet"
        className={cn(
          "absolute top-(--gutter) right-(--gutter) bottom-(--gutter) z-20 flex w-[min(400px,calc(100%-2*var(--gutter)))] flex-col p-4 outline-none",
          card,
        )}
      >
        <div className="shrink-0 pb-3">{head}</div>
        <div className="thin-scroll -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">{children}</div>
      </section>
    );
  return (
    <section
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={name}
      onKeyDown={keys}
      data-testid="sheet"
      data-clear={clear ? "" : undefined}
      className={cn(
        "kp-sheet absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-sheet border border-border border-b-0 bg-glass shadow-sheet outline-none backdrop-blur-xl",
        pull !== null && "!transition-none",
      )}
      style={{ height }}
    >
      <div {...grip} data-fade className="shrink-0 cursor-grab pt-2 pb-1.5" aria-hidden="true">
        <i className="mx-auto block h-1 w-9 rounded-full bg-foreground/20" />
      </div>
      <div className="shrink-0 px-4 pb-3">{head}</div>
      <div
        className={cn(
          "thin-scroll min-h-0 flex-1 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]",
          clear ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function SheetHead({
  title,
  onClose,
  children,
}: {
  title?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {title && <span className="font-extrabold text-base tracking-tight">{title}</span>}
      {children}
      <span data-fade className="ml-auto">
        <IconButton label="Close" onClick={onClose} testid="sheet-close">
          <X className="size-4" />
        </IconButton>
      </span>
    </div>
  );
}

/** The whole profile: base, diff and preset, the list, compare. The same body in the phone's sheet, the tablet's panel and the desk's card. */
function ProfileBody({
  held,
  onGrab,
  onRelease,
  result,
  onCompare,
}: {
  held?: string | null;
  onGrab?: (id: string) => void;
  onRelease?: () => void;
  result?: boolean;
  onCompare?: () => void;
}) {
  const comparing = usePlan((s) => !!s.compareId);
  return (
    <div className="space-y-3" data-testid="profile">
      {result && comparing && (
        <div className="rounded-control border border-border p-3">
          <CompareResult />
        </div>
      )}
      <div data-fade>
        <DiffBar />
      </div>
      <ProfileList
        held={held ?? null}
        {...(onGrab ? { onGrab } : {})}
        {...(onRelease ? { onRelease } : {})}
      />
      <div data-fade className="border-border border-t pt-3">
        <ComparePick {...(onCompare ? { onPick: onCompare } : {})} />
      </div>
    </div>
  );
}

/** Whichever sheet is open. The picker wins over the others and returns to them. */
function Sheets({
  side,
  vh,
  onHeight,
  totals = true,
  layers,
}: {
  side: boolean;
  vh: number;
  onHeight?: (h: number) => void;
  totals?: boolean;
  layers: ReactNode;
}) {
  const store = usePlanner();
  const picker = usePlan((s) => s.picker);
  const sheet = usePlan((s) => s.sheet);
  const ms = usePlan((s) => s.main.ms);
  const [held, setHeld] = useState<string | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = () => store.open(null);
  const open = picker || sheet !== null;
  useEffect(() => {
    if (!open) onHeight?.(0);
  }, [open, onHeight]);
  if (picker)
    return (
      <Sheet
        side={side}
        full
        vh={vh}
        onHeight={onHeight}
        head={null}
        name="Add a preference"
        onClose={() => store.setPicker(false)}
      >
        <Picker className="h-full" />
      </Sheet>
    );
  if (sheet === "route" && totals)
    return (
      <Sheet
        side={side}
        vh={vh}
        onHeight={onHeight}
        name="Route"
        onClose={close}
        head={
          <SheetHead onClose={close}>
            <Stats />
            <span className="ml-auto" />
            <GpxButton />
          </SheetHead>
        }
      >
        <BusyBar />
        <DeltaLine className="mb-3" />
        <RouteDetails />
      </Sheet>
    );
  if (sheet === "profile") {
    const clear = !side && held !== null;
    return (
      <Sheet
        side={side}
        clear={clear}
        vh={vh}
        onHeight={onHeight}
        name="Profile"
        onClose={close}
        head={
          <div data-keep className="-mx-2 flex items-center gap-2 px-2 py-1">
            {totals || clear ? (
              <Stats size="sm" />
            ) : (
              <span className="font-extrabold text-base tracking-tight">Profile</span>
            )}
            {clear ? (
              ms !== null && (
                <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                  rerouted in {Math.round(ms)} ms
                </span>
              )
            ) : (
              <span className="ml-auto">
                <IconButton label="Close" onClick={close} testid="sheet-close">
                  <X className="size-4" />
                </IconButton>
              </span>
            )}
          </div>
        }
      >
        <ProfileBody
          held={held}
          onCompare={close}
          onGrab={(id) => {
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setHeld(id), 110);
          }}
          onRelease={() => {
            window.clearTimeout(timer.current);
            setHeld(null);
          }}
        />
      </Sheet>
    );
  }
  if (sheet === "layers")
    return (
      <Sheet
        side={side}
        vh={vh}
        onHeight={onHeight}
        name="Map & rides"
        onClose={close}
        head={<SheetHead title="Map & rides" onClose={close} />}
      >
        {layers}
      </Sheet>
    );
  return null;
}

// ------------------------------------------------------------------ phone

function Phone({
  w,
  h,
  layers,
  legend,
  picked,
  inspectCard,
  ridesCount,
  onRetry,
  onStackHeight,
}: Slots & { onStackHeight: (h: number) => void }) {
  const [stack, stackH] = useHeight();
  const [sheetH, setSheetH] = useState(0);
  const picker = usePlan((s) => s.picker);
  const sheet = usePlan((s) => s.sheet);
  // a phone in landscape: sheets open beside the map, not over it
  const side = w >= 600;
  const short = h < 560;
  const covered = !side && (picker || sheet !== null);
  useEffect(
    () => onStackHeight(covered ? sheetH || stackH : stackH),
    [covered, sheetH, stackH, onStackHeight],
  );
  return (
    <>
      <TopBar ridesCount={ridesCount} />
      <LegendPill
        legend={legend}
        className="left-(--gutter) top-[calc(max(var(--gutter),env(safe-area-inset-top))+48px)]"
      />
      <InspectBanner className="left-1/2 top-[calc(max(var(--gutter),env(safe-area-inset-top))+48px)] -translate-x-1/2" />
      <div
        ref={stack}
        data-testid="stack"
        className={cn(
          "absolute left-(--gutter) z-10 flex flex-col gap-2 transition-opacity motion-reduce:transition-none",
          BOTTOM,
          side ? "w-[min(440px,calc(100%-2*var(--gutter)))]" : "right-(--gutter)",
          covered && "pointer-events-none opacity-0",
        )}
        aria-hidden={covered || undefined}
      >
        {picked ? inspectCard : <SummaryCard mode="phone" onRetry={onRetry} />}
        <Strip rows={short ? 1 : 2} />
        {!short && <AgentBar />}
      </div>
      <Sheets side={side} vh={h} onHeight={setSheetH} layers={layers} />
    </>
  );
}

// ------------------------------------------------------------------ tablet and desk

function RouteCard({ left, mode, onRetry }: { left: number; mode: Mode; onRetry: () => void }) {
  const store = usePlanner();
  const status = useStatus();
  const waypoints = usePlan((s) => s.waypoints);
  const n = waypoints.length;
  const title =
    n >= 2
      ? `${waypointLabel(waypoints[0], 0, n)} → ${waypointLabel(waypoints[n - 1], n - 1, n)}`
      : "New route";
  return (
    <section
      data-testid="route-card"
      className={cn(
        "thin-scroll absolute left-(--gutter) z-10 overflow-y-auto p-4",
        card,
        "top-[calc(max(var(--gutter),env(safe-area-inset-top))+52px)]",
      )}
      style={{ width: left, maxHeight: "calc(100% - 2*var(--gutter) - 52px)" }}
    >
      <div className={cn(label, "mb-3 truncate")}>{title}</div>
      {status ? (
        <>
          <StatusBody onShowLimits={() => showLimits(store, mode)} onRetry={onRetry} />
          {n > 0 && (
            <div className="mt-3.5">
              <RouteDetails />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-end justify-between gap-2">
            <Stats />
            <GpxButton />
          </div>
          <BusyBar />
          <DeltaLine className="mt-2.5" />
          <div className="mt-3.5">
            <RouteDetails />
          </div>
        </>
      )}
    </section>
  );
}

function Desk({
  mode,
  layers,
  legend,
  picked,
  inspectCard,
  ridesCount,
  onRetry,
  onStackHeight,
}: Slots & { onStackHeight: (h: number) => void }) {
  const store = usePlanner();
  const desk = mode === "desk";
  const [stack, stackH] = useHeight();
  useEffect(() => onStackHeight(stackH), [stackH, onStackHeight]);
  const picker = usePlan((s) => s.picker);
  const sheet = usePlan((s) => s.sheet);
  const left = desk ? 372 : 340;
  const right = 404;
  const top = "top-[calc(max(var(--gutter),env(safe-area-inset-top))+52px)]";
  return (
    <>
      <TopBar wide ridesCount={ridesCount} />
      <LegendPill legend={legend} className={top} style={{ left: `calc(${left}px + 2*var(--gutter))` }} />
      <InspectBanner className="top-[max(var(--gutter),env(safe-area-inset-top))] left-1/2 -translate-x-1/2" />
      <RouteCard left={left} mode={mode} onRetry={onRetry} />
      {picked && (
        <div
          className={cn("absolute z-10 w-80", BOTTOM)}
          style={{ left: `calc(${left}px + 2*var(--gutter))` }}
        >
          {inspectCard}
        </div>
      )}
      {desk ? (
        <>
          {/* the profile: the whole list, always on screen */}
          <section
            data-testid="profile-card"
            className={cn("absolute right-(--gutter) z-10 flex flex-col p-4", top, card)}
            style={{
              width: right,
              maxHeight: "calc(100% - 2*var(--gutter) - 52px)",
              height: picker ? "calc(100% - 2*var(--gutter) - 52px)" : undefined,
            }}
          >
            {picker ? (
              <Picker className="flex-1" />
            ) : (
              <div className="thin-scroll -mr-2 overflow-y-auto pr-2">
                <ProfileBody result />
              </div>
            )}
          </section>
          {sheet === "layers" && (
            <section
              role="dialog"
              aria-label="Map & rides"
              data-testid="sheet"
              onKeyDown={(e) => e.key === "Escape" && store.open(null)}
              className={cn("thin-scroll absolute z-20 w-[344px] overflow-y-auto p-4", top, card)}
              style={{
                right: `calc(${right}px + 2*var(--gutter))`,
                maxHeight: "calc(100% - 2*var(--gutter) - 52px)",
              }}
            >
              <div className="mb-3 flex items-center">
                <span className="font-extrabold text-base tracking-tight">Map & rides</span>
                <IconButton
                  label="Close"
                  onClick={() => store.open(null)}
                  className="ml-auto"
                  testid="sheet-close"
                >
                  <X className="size-4" />
                </IconButton>
              </div>
              {layers}
            </section>
          )}
          <AgentBar
            className={cn("absolute left-1/2 z-10 -translate-x-1/2", BOTTOM)}
            style={{ width: `min(500px, calc(100% - ${left + right}px - 6*var(--gutter)))` }}
          />
        </>
      ) : (
        <>
          <div
            ref={stack}
            className={cn(
              "absolute right-(--gutter) z-10 flex flex-col gap-2 transition-opacity motion-reduce:transition-none",
              BOTTOM,
              (picker || sheet === "profile" || sheet === "layers") && "pointer-events-none opacity-0",
            )}
            style={{ left: `calc(${left}px + 2*var(--gutter))` }}
          >
            <SummaryCard totals={false} mode={mode} onRetry={onRetry} />
            <Strip />
            <AgentBar />
          </div>
          <Sheets side vh={0} totals={false} layers={layers} />
        </>
      )}
    </>
  );
}
