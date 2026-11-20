import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { type Theme, type View, useIsDesktop, useTheme } from "@/shared/usePlanner";
import { Soon } from "@/shared/viz";
import { AgentBar, BaseChooser, Compare, DeltaChips, DiffBar, Editor, GpxButton, LayersPanel, Picker, RoutePanel, Stats, glass, useFlashScroll } from "./parts";
import { Brand, PlanMap, Tools, useViewportH } from "./shell";
import "./round2.css";
import { type Tuner, useTuner } from "./useTuner";

/**
 * C1 · Sheet. One bottom sheet with three detents carries route, profile and map views. The whole
 * list of sliders is there, and while you hold one the sheet clears away and leaves only that row,
 * so the map is free exactly when you need it. The picker is a search-first list.
 */
const TABS: { key: View; label: string }[] = [{ key: "plan", label: "Route" }, { key: "profile", label: "Profile" }, { key: "layers", label: "Map" }];

function ProfileBody({ t, held, onGrab, onRelease, words, pick }: { t: Tuner; held?: string | null; onGrab?: (id: string) => void; onRelease?: () => void; words?: boolean; pick?: boolean }) {
  return (
    <div className="space-y-2.5">
      {t.compare && <div data-fade><Compare t={t} /></div>}
      {!pick && <div data-fade><BaseChooser t={t} /></div>}
      <div data-fade><DiffBar t={t} words={words} pick={pick} /></div>
      <Editor t={t} held={held} onGrab={onGrab} onRelease={onRelease} />
      {!t.compare && <div data-fade className="border-t border-border pt-3"><Compare t={t} /></div>}
    </div>
  );
}

export function C1() {
  const { theme, toggleTheme } = useTheme();
  const t = useTuner();
  const desktop = useIsDesktop();
  useFlashScroll(t.fresh);
  return <div className="dir-c r2 relative h-full overflow-hidden bg-background text-foreground">{desktop ? <Desk t={t} theme={theme} toggleTheme={toggleTheme} /> : <Phone t={t} theme={theme} toggleTheme={toggleTheme} />}</div>;
}

function Desk({ t, theme, toggleTheme }: { t: Tuner; theme: Theme; toggleTheme: () => void }) {
  const layers = t.view === "layers";
  return (
    <>
      <PlanMap t={t} theme={theme} pad={{ top: 90, bottom: 110, left: 420, right: 460 }} maxNotes={3} wide />
      <div className="absolute left-4 top-4 flex gap-2"><Brand /><Soon className="h-10 border-solid bg-card px-3.5 opacity-70 backdrop-blur-xl">Ride mode</Soon></div>
      <div className="absolute right-4 top-4"><Tools t={t} theme={theme} toggleTheme={toggleTheme} layersOn={layers} onLayers={() => t.setView(layers ? "plan" : "layers")} /></div>
      <section className={cn("thin-scroll absolute left-4 top-[68px] w-[368px] overflow-y-auto rounded-3xl p-4", glass)} style={{ maxHeight: "calc(100% - 84px)" }}>
        <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Ridge to the lake</div>
        <RoutePanel t={t} />
        <DeltaChips t={t} className="mt-3 border-t border-border pt-3" />
      </section>
      <section className={cn("absolute right-4 top-[68px] flex w-[408px] flex-col rounded-3xl p-4", glass)} style={{ maxHeight: "calc(100% - 84px)", height: t.picker ? "calc(100% - 84px)" : undefined }}>
        {t.picker ? <Picker t={t} mode="list" className="flex-1" /> : <div className="thin-scroll -mr-2 overflow-y-auto pr-2"><ProfileBody t={t} words /></div>}
      </section>
      {layers && <section className={cn("thin-scroll absolute right-[440px] top-[68px] w-[340px] overflow-y-auto rounded-3xl p-4", glass)} style={{ maxHeight: "calc(100% - 160px)" }}><LayersPanel t={t} /></section>}
      <AgentBar className="absolute bottom-4 left-1/2 w-[500px] -translate-x-1/2" />
    </>
  );
}

function Phone({ t, theme, toggleTheme }: { t: Tuner; theme: Theme; toggleTheme: () => void }) {
  const [params] = useSearchParams();
  const H = useViewportH();
  const stops = [152, Math.round(H * 0.58), H - 68];
  const [detent, setDetent] = useState(params.get("sheet") === "peek" ? 0 : 1);
  const [pull, setPull] = useState<number | null>(null);
  const [held, setHeld] = useState<string | null>(params.get("hold"));
  const timer = useRef(0);
  const at = t.picker ? 2 : detent;
  const height = pull ?? (stops[at] as number);
  const mapH = Math.min(height, stops[1] as number);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const grip = {
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      const h0 = stops[at] as number;
      let moved = false;
      const el = e.currentTarget as HTMLElement;
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientY - y0) > 4) moved = true;
        if (moved) setPull(Math.max(110, Math.min(H - 40, h0 + y0 - ev.clientY)));
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        setPull(null);
        const h = h0 + y0 - ev.clientY;
        // a tap steps through the detents, a drag lands on the nearest one
        setDetent(moved ? stops.reduce((b, s, i) => (Math.abs(s - h) < Math.abs((stops[b] as number) - h) ? i : b), 0) : (at + 1) % 3);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    },
    style: { touchAction: "none" as const },
  };
  const tab = (key: View) => {
    t.setView(key);
    if (at === 0) setDetent(1);
  };

  return (
    <>
      <PlanMap t={t} theme={theme} pad={{ top: 70, bottom: mapH + 24, left: 34, right: 34 }} attribBottom={mapH + 4} />
      <div className="absolute inset-x-3 top-3 flex gap-2">
        <Brand compact />
        <AgentBar className="h-10 min-w-0 flex-1" hint="Ask for a route…" />
        <Tools t={t} theme={theme} toggleTheme={toggleTheme} layersOn={t.view === "layers"} onLayers={() => tab(t.view === "layers" ? "plan" : "layers")} />
      </div>

      <section data-grab={held ? "" : undefined} className={cn("r2-sheet absolute inset-x-0 bottom-0 flex flex-col rounded-t-[28px] border border-b-0 border-border bg-[var(--sheet)] shadow-[0_-8px_30px_rgb(0_0_0/0.14)] backdrop-blur-xl", pull !== null && "!transition-none")} style={{ height }}>
        {t.picker ? (
          <Picker t={t} mode="list" className="flex-1 p-4 pb-2" />
        ) : (
          <>
            <div {...grip} className="shrink-0 cursor-grab px-4 pb-2 pt-2">
              <i data-fade className="mx-auto mb-2 block h-1 w-9 rounded-full bg-foreground/20" />
              <div data-keep className="-mx-2 flex items-end justify-between gap-2 px-2 py-1">
                <Stats t={t} />
                {held ? <span className="whitespace-nowrap text-[10.5px] font-semibold tabular-nums text-muted-foreground">{t.rerouteMs} ms</span> : <GpxButton compact={t.moved} />}
              </div>
              {at === 0 && <p className="mt-1 truncate text-[12px] text-muted-foreground">{t.summary}</p>}
            </div>
            <div data-fade className="mx-4 grid shrink-0 grid-cols-3 rounded-full bg-foreground/8 p-1 text-[12.5px] font-bold">
              {TABS.map((x) => <button type="button" key={x.key} onClick={() => tab(x.key)} className={cn("rounded-full py-1.5", t.view === x.key ? "bg-background shadow-sm" : "text-muted-foreground")}>{x.label}{x.key === "profile" && t.changes.length > 0 && <span className="ml-1 text-[var(--hot)]">· {t.changes.length}</span>}</button>)}
            </div>
            <div className={cn("thin-scroll min-h-0 flex-1 px-4 pb-6 pt-3", held ? "overflow-hidden" : "overflow-y-auto")}>
              {t.view === "plan" && <RoutePanel t={t} stats={false} />}
              {t.view === "profile" && (
                <ProfileBody
                  t={t}
                  held={held}
                  onGrab={(id) => {
                    window.clearTimeout(timer.current);
                    timer.current = window.setTimeout(() => setHeld(id), 110);
                  }}
                  onRelease={() => {
                    window.clearTimeout(timer.current);
                    setHeld(null);
                  }}
                  words={false}
                  pick
                />
              )}
              {t.view === "layers" && <LayersPanel t={t} />}
            </div>
          </>
        )}
      </section>
    </>
  );
}
