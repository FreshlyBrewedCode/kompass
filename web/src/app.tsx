import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EngineStatus } from "@/components/engine-status";
import {
  AttributePicker,
  ExploredCard,
  InspectPanel,
  LegendCard,
  ModeSwitch,
} from "@/components/map-controls";
import type { MapHandle } from "@/components/map-view";
import { EmptyState, ErrorState } from "@/components/region-state";
import { RidesButton, RidesPanel } from "@/components/rides-panel";
import { exploredStore } from "@/history/explored-store";
import { useTheme } from "@/lib/theme";
import { devEnabled } from "@/map/dev";
import { legendFor, MAP_MODES, type MapMode } from "@/map/expressions";
import type { PickedEdge } from "@/map/inspect";
import { loadRegion, type RegionState, resolveDataUrl } from "@/map/region";
import { ridesState } from "@/rides/session";
import type { RideSummary } from "@/rides/types";

// MapLibre (and with it the map code) is the heavy part: the first paint does not wait for it
const MapView = lazy(() => import("@/components/map-view"));

const params = new URLSearchParams(location.search);
const DEV = devEnabled(location.search);
/** how many edges the dev button fakes */
const FAKE_COUNT = 400;

function initialMode(): MapMode {
  const mode = params.get("mode");
  return MAP_MODES.find((m) => m === mode) ?? "attribute";
}

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
  const [mode, setMode] = useState<MapMode>(initialMode);
  const attributes = manifest.overlay.attributes;
  const [attributeKey, setAttributeKey] = useState(() => {
    const wanted = params.get("attr");
    return attributes.find((a) => a.key === wanted)?.key ?? attributes[0]?.key ?? "";
  });
  const attribute = attributes.find((a) => a.key === attributeKey);
  const [picked, setPicked] = useState<PickedEdge | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
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
    // `builtAt` stands in for the graph build until the matching task defines one (docs/rides.md)
    library.attachExplored(exploredStore, manifest.builtAt);
    void library.init();
    if (DEV) {
      // dev / e2e: drive the ride worker directly (e.g. save a fake match)
      const w = window as unknown as { __kompass?: object };
      w.__kompass = Object.assign(w.__kompass ?? {}, { rides: library, ridesCall: library.call });
    }
  }, [library, manifest.builtAt]);
  useFileDrop((files) => {
    setRidesOpen(true);
    void library.importFiles(files);
  });

  const overlay = useMemo(() => ({ mode, attribute }), [mode, attribute]);
  const legend = useMemo(() => (attribute ? legendFor(attribute, theme) : null), [attribute, theme]);
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
          overlay={overlay}
          store={exploredStore}
          rides={rides.layer}
          ridesVisible={ridesVisible}
          onPick={setPicked}
          onError={setMapError}
        />
      </Suspense>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:w-[26rem]">
        <ModeSwitch mode={mode} onChange={setMode} />
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
        {mode === "attribute" && attribute && (
          <AttributePicker attributes={attributes} value={attributeKey} onChange={setAttributeKey} />
        )}
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
        {picked && mode !== "plain" ? (
          <InspectPanel manifest={manifest} edge={picked} onClose={() => mapRef.current?.clearSelection()} />
        ) : mode === "attribute" && legend ? (
          <LegendCard legend={legend} />
        ) : mode === "explored" ? (
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
