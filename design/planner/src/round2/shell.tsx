import { Layers, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { pointAtKm } from "@/mock/data";
import { type MapRoute, MapView, STYLES } from "@/shared/MapView";
import type { Theme } from "@/shared/usePlanner";
import { Mark } from "@/shared/viz";
import { notes } from "./model";
import { HOT, debugColor, debugKey, glass } from "./parts";
import type { Tuner } from "./useTuner";

export interface Pad { top: number; bottom: number; left: number; right: number }

/**
 * The map of every round-2 variant: the live route coloured by surface with its "why this way"
 * notes, the base profile's route as a dashed ghost while the tweaks differ from it, or a second
 * profile's route when comparing.
 */
export function PlanMap({ t, theme, pad, attribBottom = 0, maxNotes = 2, wide, ghost = true, className = "absolute inset-0 isolate" }: { t: Tuner; theme: Theme; pad: Pad; attribBottom?: number; maxNotes?: number; wide?: boolean; ghost?: boolean; className?: string }) {
  const [hot, cool] = HOT[theme];
  const plain = t.layer === "normal";
  const routes: MapRoute[] = [{ id: `live-${t.route.id}`, route: t.route, color: hot, width: 5.5, colorBy: t.compareRoute || !plain ? "solid" : "surface" }];
  if (t.compareRoute) routes.push({ id: `cmp-${t.compareRoute.id}`, route: t.compareRoute, color: cool, width: 4 });
  else if (ghost && t.moved && plain) routes.push({ id: `ghost-${t.baseRoute.id}`, route: t.baseRoute, color: theme === "dark" ? "#f1f1ee" : "#111312", width: 2.5, dashed: true, opacity: 0.7 });
  const lngs = t.route.coords.map((c) => c[0]);
  const mid = Math.min(...lngs) + (Math.max(...lngs) - Math.min(...lngs)) * 0.6;
  const callouts = t.compareRoute || !plain ? [] : notes(t.route).slice(0, maxNotes).map((n) => {
    const lngLat = pointAtKm(t.route, n.km);
    return { lngLat, flip: lngLat[0] > mid, html: wide ? `<b>${n.title}</b>${n.text}` : `<b>${n.short}</b>` };
  });
  return (
    <MapView theme={theme} styles={{ light: STYLES.positron, dark: STYLES.dark }} forest={{ light: "#d5e3cb", dark: "#17281d" }} routes={routes} waypoints={t.waypoints} layer={t.layer} attr="surface" colorExpr={debugColor(t)} colorKey={debugKey(t)} fitKey={`fit:${t.compare?.id ?? ""}:${t.base.id}`} cursor={t.cursor} padding={pad} callouts={callouts} attribBottom={attribBottom} className={className} />
  );
}

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className={cn("flex h-10 shrink-0 items-center gap-2 rounded-full", compact ? "w-10 justify-center" : "pl-2.5 pr-3.5", glass)}>
      <Mark size={20} accent="var(--hot)" />{!compact && <span className="text-[15px] font-extrabold tracking-tight">kompass</span>}
    </div>
  );
}

export function Tools({ t, theme, toggleTheme, onLayers, layersOn }: { t: Tuner; theme: Theme; toggleTheme: () => void; onLayers: () => void; layersOn: boolean }) {
  return (
    <div className={cn("flex h-10 shrink-0 items-center gap-0.5 rounded-full px-1", glass)}>
      <button type="button" onClick={onLayers} aria-label="Map layers and rides" className={cn("grid size-8 place-items-center rounded-full", (layersOn || t.layer !== "normal") && "bg-foreground text-background")}><Layers className="size-4" /></button>
      <button type="button" onClick={toggleTheme} aria-label="Toggle theme" className="grid size-8 place-items-center rounded-full">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
    </div>
  );
}

export function useViewportH() {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}
