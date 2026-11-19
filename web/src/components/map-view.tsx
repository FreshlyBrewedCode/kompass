import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";

// MapLibre finds its worker next to its own module, which a bundle moves: point it at the copy Vite emits.
setWorkerUrl(workerUrl);

// A public demo base map until the Protomaps region extract exists (OpenFreeMap, no key needed).
const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

/** Where the map opens: central Zurich, a neutral demo area. */
export const DEMO_CENTER = { lng: 8.5417, lat: 47.3769 } as const;

/** The full-screen base map; follows the theme. */
export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const theme = useTheme();
  const applied = useRef(theme);

  useEffect(() => {
    if (!container.current) return;
    const instance = new MapLibreMap({
      container: container.current,
      style: STYLES[applied.current],
      center: [DEMO_CENTER.lng, DEMO_CENTER.lat],
      zoom: 12,
      attributionControl: { compact: true },
    });
    instance.once("load", () => setLoaded(true));
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!map.current || applied.current === theme) return;
    applied.current = theme;
    map.current.setStyle(STYLES[theme]);
  }, [theme]);

  // MapLibre's (unlayered) CSS makes its container `position: relative`, beating Tailwind's layered
  // utilities: the wrapper does the positioning.
  return (
    <div className="absolute inset-0">
      <div ref={container} data-testid="map" data-loaded={loaded} className="h-full w-full" />
    </div>
  );
}
