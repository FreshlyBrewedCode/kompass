import { useState } from "react";
import { cn } from "@/lib/utils";
import { type Theme, useIsDesktop, useTheme } from "@/shared/usePlanner";
import { Mark, Soon } from "@/shared/viz";
import { AgentBar, BaseChooser, Compare, DeltaChips, DiffBar, Editor, GpxButton, Lanes, LayersPanel, Picker, Shares, Stats, Waypoints, tradeoff, useFlashScroll } from "./parts";
import { Brand, PlanMap, Tools, useViewportH } from "./shell";
import "./round2.css";
import { type Tuner, useTuner } from "./useTuner";

/**
 * C3 · Bench. Nothing floats over the map: the map gets its own pane, the timeline is the seam, and
 * the profile is a dense panel below (phone) or beside it (desktop), every slider on one line. The
 * picker is a grid of categories. What the tweaks did comes back as a sentence, live.
 */
type Tab = "profile" | "stops" | "compare" | "layers";
const TABS: { key: Tab; label: string }[] = [{ key: "profile", label: "Profile" }, { key: "stops", label: "Stops" }, { key: "compare", label: "Compare" }, { key: "layers", label: "Map" }];

/** The live answer to "what did my changes do", in the words the agent will use. */
function Verdict({ t, short }: { t: Tuner; short?: boolean }) {
  if (!t.moved) return <p className="text-[12px] leading-snug text-muted-foreground">{t.changes.length ? "Your changes do not move the route yet. Push a slider further." : t.base.blurb}</p>;
  const w = tradeoff(t.baseRoute, t.route);
  return <p className="text-[12px] leading-snug"><b className="text-[var(--hot)]">Your version</b> {w.first}{!short && <span className="text-muted-foreground"> {w.second}</span>}</p>;
}

function ProfileBody({ t, phone }: { t: Tuner; phone?: boolean }) {
  return (
    <div className="space-y-2">
      {!phone && <BaseChooser t={t} />}
      <DiffBar t={t} words={false} pick={phone} />
      <Verdict t={t} short={phone} />
      <Editor t={t} dense />
    </div>
  );
}

function Seam({ t, className }: { t: Tuner; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-end justify-between gap-2"><Stats t={t} size="sm" /><GpxButton compact /></div>
      <Lanes t={t} height={30} />
    </div>
  );
}

export function C3() {
  const { theme, toggleTheme } = useTheme();
  const t = useTuner();
  const desktop = useIsDesktop();
  useFlashScroll(t.fresh);
  const [tab, setTab] = useState<Tab>(() => (t.compare ? "compare" : t.view === "layers" ? "layers" : t.view === "plan" ? "stops" : "profile"));
  return (
    <div className="dir-c r2 relative h-full overflow-hidden bg-background text-foreground" style={{ "--card": "var(--background)" } as React.CSSProperties}>
      {desktop ? <Desk t={t} theme={theme} toggleTheme={toggleTheme} tab={tab} setTab={setTab} /> : <Phone t={t} theme={theme} toggleTheme={toggleTheme} tab={tab} setTab={setTab} />}
    </div>
  );
}

interface P { t: Tuner; theme: Theme; toggleTheme: () => void; tab: Tab; setTab: (t: Tab) => void }
const float = "border border-border bg-[var(--sheet)] shadow-[0_8px_30px_rgb(0_0_0/0.14)] backdrop-blur-xl";

function Phone({ t, theme, toggleTheme, tab, setTab }: P) {
  const H = useViewportH();
  const mapH = Math.round(H * 0.35);
  return (
    <div className="flex h-full flex-col">
      <div className="relative shrink-0" style={{ height: mapH }}>
        <PlanMap t={t} theme={theme} pad={{ top: 62, bottom: 22, left: 30, right: 30 }} maxNotes={1} />
        <div className="absolute inset-x-3 top-3 flex gap-2 [--card:var(--sheet)]">
          <Brand compact />
          <AgentBar className="h-10 min-w-0 flex-1" hint="Ask for a route…" />
          <Tools t={t} theme={theme} toggleTheme={toggleTheme} layersOn={tab === "layers"} onLayers={() => setTab(tab === "layers" ? "profile" : "layers")} />
        </div>
      </div>
      <Seam t={t} className="shrink-0 border-y border-border px-3.5 pb-1 pt-2.5" />
      {t.picker ? (
        <Picker t={t} mode="grid" className="flex-1 px-3.5 pb-2 pt-3" />
      ) : (
        <>
          <div className="mx-3.5 mt-2.5 grid shrink-0 grid-cols-4 rounded-full bg-foreground/8 p-1 text-[12.5px] font-bold">
            {TABS.map((x) => <button type="button" key={x.key} onClick={() => setTab(x.key)} className={cn("rounded-full py-1.5", tab === x.key ? "bg-background shadow-sm" : "text-muted-foreground")}>{x.label}{x.key === "profile" && t.changes.length > 0 && <span className="ml-1 text-[var(--hot)]">· {t.changes.length}</span>}</button>)}
          </div>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3.5 pb-5 pt-2.5">
            {tab === "profile" && <ProfileBody t={t} phone />}
            {tab === "stops" && <div className="space-y-3"><Waypoints t={t} /><Shares route={t.route} /></div>}
            {tab === "compare" && <div className="space-y-3"><Compare t={t} /><DeltaChips t={t} /></div>}
            {tab === "layers" && <LayersPanel t={t} />}
          </div>
        </>
      )}
    </div>
  );
}

function Desk({ t, theme, toggleTheme, tab, setTab }: P) {
  const layers = tab === "layers";
  return (
    <div className="grid h-full grid-cols-[432px_minmax(0,1fr)] grid-rows-[1fr_auto]">
      <aside className="row-span-2 flex min-h-0 flex-col border-r border-border">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <Mark size={22} accent="var(--hot)" /><span className="text-[16px] font-extrabold tracking-tight">kompass</span>
          <Soon className="ml-auto">Ride mode</Soon>
        </div>
        {t.picker ? (
          <Picker t={t} mode="grid" className="flex-1 p-4" />
        ) : (
          <div className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <ProfileBody t={t} />
            <div className="border-t border-border pt-3"><Compare t={t} /></div>
          </div>
        )}
      </aside>
      <div className="relative min-h-0 [--card:var(--sheet)]">
        <PlanMap t={t} theme={theme} pad={{ top: 80, bottom: 90, left: 70, right: 70 }} maxNotes={3} wide />
        <div className="absolute right-4 top-4"><Tools t={t} theme={theme} toggleTheme={toggleTheme} layersOn={layers} onLayers={() => setTab(layers ? "profile" : "layers")} /></div>
        {layers && <section className={cn("thin-scroll absolute right-4 top-[68px] w-[340px] overflow-y-auto rounded-3xl p-4", float)} style={{ maxHeight: "calc(100% - 150px)" }}><LayersPanel t={t} /></section>}
        <AgentBar className="absolute bottom-4 left-1/2 w-[480px] -translate-x-1/2" />
      </div>
      <div className="grid grid-cols-[300px_minmax(0,1fr)_270px] gap-6 border-t border-border px-5 py-3.5">
        <Waypoints t={t} />
        <div className="min-w-0">
          <div className="mb-2 flex items-end justify-between gap-4"><Stats t={t} /><GpxButton /></div>
          <Lanes t={t} height={58} />
        </div>
        <Shares route={t.route} className="self-center" />
      </div>
    </div>
  );
}
