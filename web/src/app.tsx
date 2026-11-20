import type { Map as MapLibreMap } from "maplibre-gl";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EngineStatus } from "@/components/engine-status";
import { ExploredCard, InspectPanel, LayersControl, LegendCard } from "@/components/map-controls";
import type { MapHandle } from "@/components/map-view";
import { EmptyState, ErrorState } from "@/components/region-state";
import { RidesButton, RidesPanel } from "@/components/rides-panel";
import type { GeometryMode } from "@/engine/protocol";
import { engineStore } from "@/engine/store";
import { exploredStore } from "@/history/explored-store";
import { useTheme } from "@/lib/theme";
import { devEnabled } from "@/map/dev";
import { infoLayerFromName, infoLayerName, infoSpec, type MapLayers } from "@/map/info";
import type { PickedEdge } from "@/map/inspect";
import { loadRegion, type RegionState, resolveDataUrl } from "@/map/region";
import { ridesState } from "@/rides/session";
import type { RideSummary } from "@/rides/types";

// MapLibre (and with it the map code) is the heavy part: the first paint does not wait for it
const MapView = lazy(() => import("@/components/map-view"));
// TEMPORARY: the route lab (src/planner-lab/, `?lab`), with MapLibre in the same lazy chunk
const PlannerLab = lazy(() => import("@/planner-lab/planner-lab"));

const params = new URLSearchParams(location.search);
const DEV = devEnabled(location.search);
/** how many edges the dev button fakes */
const FAKE_COUNT = 400;

/** TEMPORARY: `?lab` opens the route lab (src/planner-lab/) until the planner shell replaces it. */
const LAB = params.has("lab");
/** `?geometry=lazy`: geometry tiles load per route instead of up front (docs/engine-web.md) */
const GEOMETRY: GeometryMode = params.get("geometry") === "lazy" ? "lazy" : "eager";

/** `?terrain=0` / `?routes=0` start with a toggle off. */
const flag = (name: string) => params.get(name) !== "0";

function useRegion(): RegionState {
  const [state, setState] = useState<RegionState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void loadRegion(resolveDataUrl(location.search, document.baseURI)).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/** Dropping files anywhere on the page imports them (and keeps the browser from opening them). */
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

export function App() {
  const region = useRegion();
  return (
    <main className="relative h-full w-full overflow-hidden">
      {region.status === "ready" ? (
        <RegionScreen manifest={region.manifest} dataUrl={region.dataUrl} />
      ) : region.status === "empty" ? (
        <EmptyState dataUrl={region.dataUrl} />
      ) : region.status === "error" ? (
        <ErrorState dataUrl={region.dataUrl} message={region.message} />
      ) : null}
      <div className="pointer-events-none absolute top-0 right-0 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <EngineStatus />
      </div>
    </main>
  );
}

function RegionScreen({
  manifest,
  dataUrl,
}: {
  manifest: Extract<RegionState, { status: "ready" }>["manifest"];
  dataUrl: string;
}) {
  const theme = useTheme();
  const attributes = manifest.overlay.attributes;
  // the readable map is the default; `?layer=<attribute key>|explored` opens with a layer on
  const [info, setInfo] = useState(() => infoLayerFromName(params.get("layer"), attributes));
  const [terrain, setTerrain] = useState(() => flag("terrain"));
  const [routes, setRoutes] = useState(() => flag("routes"));
  const [picked, setPicked] = useState<PickedEdge | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [labMap, setLabMap] = useState<MapLibreMap | null>(null);
  const ridden = useSyncExternalStore(
    (onChange) => exploredStore.subscribe(onChange),
    () => exploredStore.size,
  );

  // the ride library (src/rides/): its worker starts here; the explored map follows its saved matches
  const library = ridesState();
  const rides = useSyncExternalStore(library.subscribe, library.getSnapshot);
  const [ridesOpen, setRidesOpen] = useState(false);
  const [ridesVisible, setRidesVisible] = useState(true);
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  useEffect(() => {
    // matches belong to a graph build (docs/rides.md): the engine's build id
    library.attachExplored(exploredStore, manifest.graph?.buildId ?? manifest.buildId ?? manifest.builtAt);
    void library.init();
    if (DEV) {
      // dev / e2e: drive the ride worker directly (e.g. save a fake match)
      const w = window as unknown as { __kompass?: object };
      w.__kompass = Object.assign(w.__kompass ?? {}, { rides: library, ridesCall: library.call });
    }
  }, [library, manifest]);
  // the engine: the region graph downloads (once per build) and loads in its worker
  useEffect(() => {
    const engine = engineStore();
    if (manifest.graph) void engine.load(dataUrl, manifest.graph, GEOMETRY).catch(() => undefined);
    if (DEV) {
      const w = window as unknown as { __kompass?: object };
      w.__kompass = Object.assign(w.__kompass ?? {}, { engine });
    }
  }, [manifest, dataUrl]);
  useFileDrop((files) => {
    setRidesOpen(true);
    void library.importFiles(files);
  });

  const layers = useMemo<MapLayers>(() => ({ info, terrain, routes }), [info, terrain, routes]);
  const legend = useMemo(
    () => (info.kind === "attribute" ? infoSpec(info.attribute, theme).legend : null),
    [info, theme],
  );
  // the map owns the selection highlight: closing the panel goes through it
  const mapRef = useRef<MapHandle>(null);

  const focusRide = (ride: RideSummary | null) => {
    setSelectedRide(ride?.id ?? null);
    const wide = matchMedia("(min-width: 768px)").matches;
    // keep the line clear of the panel: at the bottom on a phone, at the right on a desktop
    const padding = wide
      ? { top: 60, bottom: 80, left: 60, right: 420 }
      : { top: 120, bottom: Math.round(innerHeight * 0.54) + 60, left: 32, right: 32 };
    mapRef.current?.focusRide(ride, padding);
  };

  return (
    <>
      <Suspense fallback={null}>
        <MapView
          ref={mapRef}
          manifest={manifest}
          dataUrl={dataUrl}
          layers={layers}
          store={exploredStore}
          rides={rides.layer}
          ridesVisible={ridesVisible}
          onPick={LAB ? (edge) => edge && mapRef.current?.clearSelection() : setPicked}
          onError={setMapError}
          {...(LAB ? { onMap: setLabMap } : {})}
        />
      </Suspense>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] max-md:pr-24 md:w-[26rem]">
        <LayersControl
          attributes={attributes}
          value={infoLayerName(info)}
          onChange={(name) => setInfo(infoLayerFromName(name, attributes))}
          terrain={manifest.terrain ? terrain : null}
          onTerrain={setTerrain}
          routes={routes}
          onRoutes={setRoutes}
        />
        <RidesButton
          count={rides.rides.length}
          open={ridesOpen}
          visible={ridesVisible}
          onToggleOpen={() => {
            if (ridesOpen) focusRide(null);
            setRidesOpen(!ridesOpen);
          }}
          onToggleVisible={setRidesVisible}
        />
        {mapError && (
          <div
            data-testid="map-error"
            className="pointer-events-auto rounded-md border border-destructive/40 bg-card/95 px-3 py-2 text-destructive text-xs"
          >
            Map data problem: {mapError}
          </div>
        )}
      </div>

      {ridesOpen && (
        <RidesPanel
          snapshot={rides}
          state={library}
          selectedId={selectedRide}
          onSelect={focusRide}
          onClose={() => {
            focusRide(null);
            setRidesOpen(false);
          }}
        />
      )}

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 p-3 pb-[max(2rem,env(safe-area-inset-bottom))] md:right-auto md:w-80 ${ridesOpen ? "max-md:hidden" : ""}`}
      >
        {LAB ? (
          <Suspense fallback={null}>
            <PlannerLab map={labMap} />
          </Suspense>
        ) : picked ? (
          <InspectPanel manifest={manifest} edge={picked} onClose={() => mapRef.current?.clearSelection()} />
        ) : legend ? (
          <LegendCard legend={legend} />
        ) : info.kind === "explored" ? (
          <ExploredCard
            theme={theme}
            ridden={ridden}
            devTools={DEV}
            onFake={() => mapRef.current?.fakeRidden(FAKE_COUNT)}
            onClear={() => exploredStore.clear()}
          />
        ) : null}
      </div>
    </>
  );
}
