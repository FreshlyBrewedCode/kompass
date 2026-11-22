import { useSyncExternalStore } from "react";
import { DEFAULT_LOOK, type MapLook, parseLook, sameLook } from "@/map/look";

// The map style options ("Map style" in Map & rides): remembered on the device, like the theme. A
// per-viewer convenience: blocked storage keeps the choice for the session only.

export const MAP_LOOK_KEY = "kompass.mapLook";

function readStored(): MapLook {
  try {
    return parseLook(localStorage.getItem(MAP_LOOK_KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

let look: MapLook = readStored();
const listeners = new Set<() => void>();

export function setMapLook(next: MapLook) {
  if (sameLook(next, look)) return;
  look = next;
  try {
    if (sameLook(next, DEFAULT_LOOK)) localStorage.removeItem(MAP_LOOK_KEY);
    else localStorage.setItem(MAP_LOOK_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the choice holds for this session only
  }
  for (const l of listeners) l();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The map style options and their setter (one option at a time: `set({ tracks: "simple" })`). */
export function useMapLook(): [MapLook, (change: Partial<MapLook>) => void] {
  const current = useSyncExternalStore(subscribe, () => look);
  return [current, (change) => setMapLook({ ...look, ...change })];
}
