import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import type { ExploredStore } from "@/history/explored-store";
import { useTheme } from "@/lib/theme";
import { RegionMap } from "@/map/controller";
import { devEnabled, fakeRiddenCount, fakeRiddenFromRendered, fakeRiddenRange } from "@/map/dev";
import type { OverlayState } from "@/map/expressions";
import type { PickedEdge } from "@/map/inspect";
import type { Manifest } from "@/map/manifest";

/** What the chrome can ask of the map. */
export type MapHandle = {
  /** drop the edge highlight (the inspect panel closed) */
  clearSelection: () => void;
  /** dev: mark up to `n` of the edges on screen as ridden */
  fakeRidden: (n: number) => void;
};

export type MapViewProps = {
  ref?: Ref<MapHandle>;
  manifest: Manifest;
  dataUrl: string;
  overlay: OverlayState;
  store: ExploredStore;
  onPick: (edge: PickedEdge | null) => void;
  onError: (message: string) => void;
};

/** The full-screen region map (the logic lives in src/map/controller.ts). Loaded lazily: MapLibre is big. */
export default function MapView({ ref, manifest, dataUrl, overlay, store, onPick, onError }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const regionMap = useRef<RegionMap | null>(null);
  const theme = useTheme();
  // the newest values, for the map created once per region
  const latest = useRef({ overlay, theme, onPick, onError });
  latest.current = { overlay, theme, onPick, onError };

  useEffect(() => {
    if (!container.current) return;
    const instance = new RegionMap({
      container: container.current,
      manifest,
      dataUrl,
      theme: latest.current.theme,
      overlay: latest.current.overlay,
      store,
      onPick: (edge) => latest.current.onPick(edge),
      onError: (message) => latest.current.onError(message),
    });
    regionMap.current = instance;

    const search = location.search;
    if (devEnabled(search)) {
      (window as unknown as { __kompass: unknown }).__kompass = {
        map: instance.map,
        store,
        regionMap: instance,
        fakeRange: fakeRiddenRange,
      };
    }
    const fake = fakeRiddenCount(search);
    if (fake > 0) {
      // once the first tiles are in, mark some of the edges on screen as ridden
      instance.map.once("idle", () => {
        store.setRidden(fakeRiddenFromRendered(instance.map, manifest.overlay.layer, fake));
      });
    }
    return () => {
      instance.destroy();
      regionMap.current = null;
    };
  }, [manifest, dataUrl, store]);

  useImperativeHandle(
    ref,
    () => ({
      clearSelection: () => regionMap.current?.select(null),
      fakeRidden: (n) => {
        const current = regionMap.current;
        if (current) store.setRidden(fakeRiddenFromRendered(current.map, manifest.overlay.layer, n));
      },
    }),
    [store, manifest],
  );

  useEffect(() => regionMap.current?.setOverlay(overlay), [overlay]);
  useEffect(() => regionMap.current?.setTheme(theme), [theme]);

  // MapLibre's (unlayered) CSS makes its container `position: relative`, beating Tailwind's layered
  // utilities: the wrapper does the positioning.
  return (
    <div className="absolute inset-0">
      <div ref={container} data-testid="map" className="h-full w-full" />
    </div>
  );
}
