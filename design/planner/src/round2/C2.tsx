import { Bookmark, ChevronDown, ChevronUp, Lock, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { type Theme, useIsDesktop, useTheme } from "@/shared/usePlanner";
import { Soon } from "@/shared/viz";
import { attr, limitDef } from "./model";
import { AgentBar, BaseChooser, Compare, DeltaChips, DiffBar, GpxButton, LayersPanel, LimitRow, Picker, PrefRow, RoutePanel, Stats, glass } from "./parts";
import { Brand, PlanMap, Tools, useViewportH } from "./shell";
import "./round2.css";
import { type Tuner, useTuner } from "./useTuner";

/**
 * C2 · Strip. The map keeps the screen. The profile is a strip of chips above the agent bar, one
 * chip per active preference; tap one and a single slider opens, nothing more. The picker is a
 * cloud of chips. What the tweaks did shows as numbers next to the route's totals.
 */
type Slot = null | "base" | "route" | "layers" | { id: string };

const chipTone = (v: number) => (v > 7 ? "var(--more)" : v < -7 ? "var(--less)" : "currentColor");

function Strip({ t, slot, setSlot, wrap }: { t: Tuner; slot: Slot; setSlot: (s: Slot) => void; wrap?: boolean }) {
  const sel = slot && typeof slot === "object" ? slot.id : null;
  const chip = (on: boolean) => cn("flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold", on ? "border border-transparent bg-foreground text-background shadow-[0_8px_30px_rgb(0_0_0/0.14)]" : glass);
  const pick = (id: string) => {
    t.setPicker(false);
    setSlot(sel === id ? null : { id });
  };
  return (
    <div className={cn("no-scrollbar flex gap-1.5", wrap ? "flex-wrap justify-center" : "-mx-2.5 overflow-x-auto px-2.5")}>
      <button type="button" onClick={() => { t.setPicker(false); setSlot(slot === "base" ? null : "base"); }} className={chip(slot === "base")}>
        {t.base.own && <Bookmark className="size-3" />}<span className="font-bold">{t.base.name}</span>
        {t.changes.length > 0 && <span className={cn("grid size-[18px] place-items-center rounded-full text-[10.5px] font-bold", slot === "base" ? "bg-background text-foreground" : "bg-[var(--hot)] text-white")}>{t.changes.length}</span>}
        <ChevronUp className="size-3.5 opacity-60" />
      </button>
      {t.prefIds.map((id) => {
        const v = t.prefs[id] ?? 0;
        const a = attr(id);
        return (
          <button type="button" key={id} onClick={() => pick(id)} className={chip(sel === id)}>
            {t.base.prefs[id] !== v && <i className="size-1.5 rounded-full bg-[var(--hot)]" />}
            {a.short === "New" ? "Never ridden" : a.short}
            <span className="relative h-[5px] w-7 overflow-hidden rounded-full bg-current/15">
              <i className="absolute inset-y-0 rounded-full" style={{ left: `${(Math.min(v, 0) + 100) / 2}%`, width: `${Math.max(6, Math.abs(v) / 2)}%`, background: chipTone(v) }} />
            </span>
          </button>
        );
      })}
      {t.limitIds.map((id) => {
        const v = t.limits[id];
        const def = limitDef(id);
        return (
          <button type="button" key={id} onClick={() => pick(id)} className={cn(chip(sel === id), v === undefined && "line-through opacity-60")}>
            {t.base.limits[id] !== v && <i className="size-1.5 rounded-full bg-[var(--hot)]" />}
            <Lock className="size-3 text-[var(--hot)]" />{def.label}{typeof v === "number" && <b className="tabular-nums">{def.param?.fmt(v)}</b>}
          </button>
        );
      })}
      <button type="button" onClick={() => { setSlot(null); t.setPicker(!t.picker); }} className={cn(chip(t.picker), "border-dashed pl-2.5")}><Plus className="size-4" />Add</button>
    </div>
  );
}

/** The one card above the strip: the route's totals, and whatever is being edited. */
function Card({ t, slot, setSlot, maxBody }: { t: Tuner; slot: Slot; setSlot: (s: Slot) => void; maxBody: number }) {
  const id = slot && typeof slot === "object" ? slot.id : null;
  const isPref = id !== null && id in t.prefs;
  const isLimit = id !== null && t.limitIds.includes(id);
  const open = slot === "route";
  return (
    <section className={cn("rounded-[24px] p-3.5 pt-3", glass)}>
      {t.picker ? (
        <div className="flex flex-col" style={{ height: maxBody + 70 }}><Picker t={t} mode="chips" className="flex-1" /></div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button type="button" aria-label={open ? "Hide the route details" : "Show the route details"} onClick={() => setSlot(open ? null : "route")} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <Stats t={t} size={slot === null || open ? "lg" : "sm"} />
              {open ? <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" /> : <ChevronUp className="ml-auto size-4 shrink-0 text-muted-foreground" />}
            </button>
            <GpxButton compact={t.moved || !(slot === null || open)} />
          </div>
          {(slot === null || isPref || isLimit) && (t.moved || t.changes.length > 0) && <DeltaChips t={t} className="mt-1.5" />}
          {slot !== null && (
            <div className="thin-scroll -mx-1 mt-2.5 overflow-y-auto border-t border-border px-1 pt-2.5" style={{ maxHeight: maxBody }}>
              {open && <RoutePanel t={t} stats={false} />}
              {slot === "layers" && <LayersPanel t={t} />}
              {slot === "base" && (
                <div className="space-y-2.5">
                  <BaseChooser t={t} />
                  <DiffBar t={t} />
                  <Compare t={t} />
                </div>
              )}
              {(isPref || isLimit) && id && (
                <div>
                  {isPref ? <PrefRow t={t} id={id} /> : <LimitRow t={t} id={id} />}
                  <div className="flex items-center gap-2 px-1 pt-0.5 text-[11.5px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{isPref ? attr(id).hint : limitDef(id).hint}</span>
                    <span className="shrink-0 tabular-nums">rerouted in {t.rerouteMs} ms</span>
                    <button type="button" aria-label="Done" onClick={() => setSlot(null)} className="-my-1 grid size-6 shrink-0 place-items-center rounded-full bg-foreground/8 text-foreground"><X className="size-3.5" /></button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function useSlot(t: Tuner): [Slot, (s: Slot) => void] {
  const [slot, setSlot] = useState<Slot>(() => (t.compare ? "base" : t.view === "layers" ? "layers" : t.view === "profile" ? { id: "water" in t.prefs ? "water" : "unpaved" } : null));
  // a preference that was just added opens right away, ready to tune
  useEffect(() => {
    if (t.fresh) setSlot({ id: t.fresh });
  }, [t.fresh]);
  // a chip whose preference was removed closes
  const gone = slot && typeof slot === "object" && !(slot.id in t.prefs) && !t.limitIds.includes(slot.id);
  useEffect(() => {
    if (gone) setSlot(null);
  }, [gone]);
  return [slot, setSlot];
}

export function C2() {
  const { theme, toggleTheme } = useTheme();
  const t = useTuner();
  const desktop = useIsDesktop();
  const [slot, setSlot] = useSlot(t);
  const layers = () => {
    t.setPicker(false);
    setSlot(slot === "layers" ? null : "layers");
  };
  return (
    <div className="dir-c r2 relative h-full overflow-hidden bg-background text-foreground">
      {desktop ? <Desk t={t} theme={theme} toggleTheme={toggleTheme} slot={slot} setSlot={setSlot} layers={layers} /> : <Phone t={t} theme={theme} toggleTheme={toggleTheme} slot={slot} setSlot={setSlot} layers={layers} />}
    </div>
  );
}

interface P { t: Tuner; theme: Theme; toggleTheme: () => void; slot: Slot; setSlot: (s: Slot) => void; layers: () => void }

function Phone({ t, theme, toggleTheme, slot, setSlot, layers }: P) {
  const H = useViewportH();
  const stack = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(200);
  useEffect(() => {
    if (!stack.current) return;
    const ro = new ResizeObserver(([e]) => e && setH(Math.round(e.contentRect.height)));
    ro.observe(stack.current);
    return () => ro.disconnect();
  }, []);
  // big cards (picker, route details) cover the map for a moment; the map does not shrink for them
  const cover = Math.min(h, Math.round(H * (t.picker || slot === "route" || slot === "layers" ? 0.36 : 0.63)));
  return (
    <>
      <PlanMap t={t} theme={theme} pad={{ top: 70, bottom: cover + 30, left: 34, right: 34 }} attribBottom={cover + 16} />
      <div className="absolute inset-x-3 top-3 flex justify-between"><Brand /><Tools t={t} theme={theme} toggleTheme={toggleTheme} layersOn={slot === "layers"} onLayers={layers} /></div>
      <div ref={stack} className="absolute inset-x-2.5 bottom-2.5 flex flex-col gap-2">
        <Card t={t} slot={slot} setSlot={setSlot} maxBody={Math.round(H * 0.5)} />
        <Strip t={t} slot={slot} setSlot={setSlot} />
        <AgentBar />
      </div>
    </>
  );
}

function Desk({ t, theme, toggleTheme, slot, setSlot, layers }: P) {
  const dock = slot !== null && slot !== "route" && slot !== "layers";
  return (
    <>
      <PlanMap t={t} theme={theme} pad={{ top: 90, bottom: 330, left: 420, right: 80 }} maxNotes={3} wide />
      <div className="absolute left-4 top-4 flex gap-2"><Brand /><Soon className="h-10 border-solid bg-card px-3.5 opacity-70 backdrop-blur-xl">Ride mode</Soon></div>
      <div className="absolute right-4 top-4"><Tools t={t} theme={theme} toggleTheme={toggleTheme} layersOn={slot === "layers"} onLayers={layers} /></div>
      <section className={cn("thin-scroll absolute left-4 top-[68px] w-[368px] overflow-y-auto rounded-3xl p-4", glass)} style={{ maxHeight: "calc(100% - 84px)" }}>
        <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Ridge to the lake</div>
        <RoutePanel t={t} />
        <DeltaChips t={t} className="mt-3 border-t border-border pt-3" />
      </section>
      {slot === "layers" && <section className={cn("thin-scroll absolute right-4 top-[68px] w-[340px] overflow-y-auto rounded-3xl p-4", glass)} style={{ maxHeight: "calc(100% - 260px)" }}><LayersPanel t={t} /></section>}
      <div className="absolute bottom-4 left-[calc(50%+192px)] flex w-[min(760px,calc(100%-440px))] -translate-x-1/2 flex-col items-center gap-2">
        {(dock || t.picker) && (
          <section className={cn("w-[520px] rounded-[24px] p-4", glass)} style={t.picker ? { height: 430, display: "flex", flexDirection: "column" } : undefined}>
            {t.picker ? <Picker t={t} mode="chips" className="flex-1" /> : <DockBody t={t} slot={slot} setSlot={setSlot} />}
          </section>
        )}
        <Strip t={t} slot={slot} setSlot={setSlot} wrap />
        <AgentBar className="w-[500px]" />
      </div>
    </>
  );
}

function DockBody({ t, slot, setSlot }: { t: Tuner; slot: Slot; setSlot: (s: Slot) => void }) {
  if (slot === "base") return <div className="space-y-2.5"><BaseChooser t={t} /><DiffBar t={t} /><Compare t={t} /></div>;
  const id = slot && typeof slot === "object" ? slot.id : null;
  if (!id) return null;
  const isPref = id in t.prefs;
  return (
    <div>
      {isPref ? <PrefRow t={t} id={id} /> : <LimitRow t={t} id={id} />}
      <div className="flex items-center gap-2 px-1 pt-1 text-[11.5px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{isPref ? attr(id).hint : limitDef(id).hint}</span>
        <span className="shrink-0 tabular-nums">rerouted in {t.rerouteMs} ms</span>
        <button type="button" aria-label="Done" onClick={() => setSlot(null)} className="-my-1 grid size-6 shrink-0 place-items-center rounded-full bg-foreground/8 text-foreground"><X className="size-3.5" /></button>
      </div>
    </div>
  );
}
