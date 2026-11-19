import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type HardKey,
  PROFILES,
  type Profile,
  ROUTES,
  type RouteData,
  SPARE_WAYPOINTS,
  type SoftKey,
  WAYPOINTS,
  type Waypoint,
} from "@/mock/data";

export type View = "plan" | "profile" | "layers";
export type LayerMode = "normal" | "debug" | "explored";
export type AttrKey = "surface" | "road" | "traffic" | "cost";
export type Theme = "light" | "dark";

/** Light/dark: `?theme=dark` wins, otherwise the system setting. */
export function useTheme() {
  const [params] = useSearchParams();
  const [theme, setTheme] = useState<Theme>(() => {
    const q = params.get("theme");
    if (q === "dark" || q === "light") return q;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  return { theme, toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

export function useIsDesktop() {
  const q = "(min-width: 900px)";
  const [is, setIs] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setIs(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return is;
}

/** All planner state of one direction. Mock: tuning never changes the routes. */
export function usePlanner() {
  const [params] = useSearchParams();
  const [view, setView] = useState<View>(() => (params.get("view") as View) || "plan");
  const [waypoints, setWaypoints] = useState<Waypoint[]>(WAYPOINTS);
  const [profiles, setProfiles] = useState<Profile[]>(PROFILES);
  const [activeId, setActiveId] = useState("gravel");
  const [compareId, setCompareId] = useState<string | null>(() =>
    params.get("compare") === "1" || params.get("view") === "profile" ? "paved" : null,
  );
  const [layer, setLayer] = useState<LayerMode>(() => (params.get("layer") as LayerMode) || "normal");
  const [attr, setAttr] = useState<AttrKey>("surface");
  const [imports, setImports] = useState<string[]>([]);
  const [tunes, setTunes] = useState(0);

  const active = profiles.find((p) => p.id === activeId) as Profile;
  const compare = profiles.find((p) => p.id === compareId) ?? null;
  const route = ROUTES[active.routeId] as RouteData;
  const compareRoute = compare ? (ROUTES[compare.routeId] as RouteData) : null;

  const setSoft = useCallback((id: string, key: SoftKey, value: number) => {
    setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, soft: { ...p.soft, [key]: value } } : p)));
    setTunes((t) => t + 1);
  }, []);
  const toggleHard = useCallback((id: string, key: HardKey) => {
    setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, hard: { ...p.hard, [key]: !p.hard[key] } } : p)));
    setTunes((t) => t + 1);
  }, []);
  const setActive = useCallback((id: string) => {
    setActiveId(id);
    setCompareId((c) => (c === id ? null : c));
  }, []);
  const addWaypoint = useCallback(() => {
    setWaypoints((ws) => {
      const spare = SPARE_WAYPOINTS.find((s) => !ws.some((w) => w.id === s.id));
      if (!spare) return ws;
      return [...ws.slice(0, -1), spare, ws[ws.length - 1] as Waypoint];
    });
  }, []);
  const removeWaypoint = useCallback((id: string) => setWaypoints((ws) => (ws.length > 2 ? ws.filter((w) => w.id !== id) : ws)), []);
  const moveWaypoint = useCallback((from: number, to: number) => {
    setWaypoints((ws) => {
      if (to < 0 || to >= ws.length || from === to) return ws;
      const next = [...ws];
      const [w] = next.splice(from, 1);
      next.splice(to, 0, w as Waypoint);
      return next;
    });
  }, []);
  const addImport = useCallback((names: string[]) => setImports((i) => [...names, ...i]), []);

  return useMemo(
    () => ({
      view, setView, waypoints, addWaypoint, removeWaypoint, moveWaypoint,
      profiles, active, compare, route, compareRoute, setActive, setCompare: setCompareId,
      setSoft, toggleHard, layer, setLayer, attr, setAttr, imports, addImport,
      rerouteMs: 4 + ((tunes * 7) % 9),
    }),
    [view, waypoints, profiles, active, compare, route, compareRoute, layer, attr, imports, tunes,
      addWaypoint, removeWaypoint, moveWaypoint, setActive, setSoft, toggleHard, addImport],
  );
}
export type Planner = ReturnType<typeof usePlanner>;

/** Pointer-drag reordering for a list of equal-height rows. */
export function useReorder(rowHeight: number, move: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<{ index: number; dy: number } | null>(null);
  const handle = (index: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      let cur = index;
      let base = 0;
      setDrag({ index, dy: 0 });
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - y0 - base;
        const step = Math.round(dy / rowHeight);
        if (step !== 0) {
          move(cur, cur + step);
          cur += step;
          base += step * rowHeight;
          setDrag({ index: cur, dy: ev.clientY - y0 - base });
        } else setDrag({ index: cur, dy });
      };
      const onUp = () => {
        setDrag(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    style: { touchAction: "none" as const, cursor: "grab" },
  });
  return { drag, handle };
}
