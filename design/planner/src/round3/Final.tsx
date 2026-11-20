import { Bookmark, ChevronUp, Layers, Lock, Moon, Plus, SlidersHorizontal, Sun, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { attr, limitDef } from "@/round2/model";
import { type Theme, useTheme } from "@/shared/usePlanner";
import { Mark, Soon } from "@/shared/viz";
import { PlanMap } from "./map";
import { dataVars } from "./palette";
import { AgentBar, BusyBar, ComparePick, CompareResult, DeltaLine, DiffBar, GpxButton, IconButton, LaneStrip, LayersPanel, Legend, LimitRow, Picker, PrefRow, ProfileList, RouteDetails, Stats, StatusBody, card, chipName, label, layerDefs, useFlashScroll } from "./parts";
import { type Mode, type Plan, useMode, usePlan } from "./state";

/**
 * Round 3 · the consolidated planner (`/final`).
 *
 * One set of parts (parts.tsx), one state model (state.ts); this file only arranges them:
 * - phone: the map keeps the screen. Bottom stack: summary card, chip strip, agent bar. Everything
 *   larger than one row is a bottom sheet (route, profile, picker, map & rides), one at a time.
 * - desk: route card left, profile card right, both floating; the layers control is a popover.
 * - tablet: the desk's route card with the phone's strip; sheets become a side panel.
 */
export function Final() {
  const { theme, toggleTheme } = useTheme();
  const p = usePlan();
  const { mode, w, h } = useMode();
  useFlashScroll(p.fresh);
  return (
    <div className="r3 relative h-full overflow-hidden bg-background text-foreground" style={dataVars(theme) as CSSProperties}>
      {mode === "phone" ? <Phone p={p} theme={theme} toggleTheme={toggleTheme} w={w} h={h} /> : <Desk p={p} theme={theme} toggleTheme={toggleTheme} mode={mode} />}
    </div>
  );
}

interface LayoutProps { p: Plan; theme: Theme; toggleTheme: () => void }

// ------------------------------------------------------------------ top bar (all breakpoints)

function TopBar({ p, theme, toggleTheme, wide }: LayoutProps & { wide?: boolean }) {
  const layersOn = p.sheet === "layers" || p.layer !== "normal";
  return (
    <div className="pointer-events-none absolute inset-x-(--gutter) top-(--gutter) z-10 flex items-start justify-between gap-2 *:pointer-events-auto">
      <div className="flex gap-2">
        <div className={cn(card, "flex h-10 items-center gap-2 rounded-full", wide ? "pl-2.5 pr-4" : "w-10 justify-center")}><Mark size={20} accent="var(--signal)" />{wide && <span className="text-base font-extrabold tracking-tight">kompass</span>}</div>
        <Soon className={cn(card, "h-10 rounded-full border-dashed px-3.5 text-xs text-muted-foreground opacity-100")}>Ride mode</Soon>
      </div>
      <div className={cn(card, "flex h-10 items-center gap-1 rounded-full px-1")}>
        <IconButton label="Map layers and rides" on={layersOn} onClick={() => p.open(p.sheet === "layers" ? null : "layers")} className={cn(!layersOn && "bg-transparent")}><Layers className="size-4" /></IconButton>
        {/* sandbox only: the real app follows the system setting */}
        <IconButton label="Toggle theme (sandbox only)" onClick={toggleTheme} className="bg-transparent">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</IconButton>
      </div>
    </div>
  );
}

/** While a layer is on and its panel is closed, its legend stays on the map. */
function LegendPill({ p, theme, className, style }: { p: Plan; theme: Theme; className?: string; style?: CSSProperties }) {
  if (p.layer === "normal" || p.sheet === "layers") return null;
  const name = p.layer === "explored" ? "Explored" : layerDefs(theme).find((d) => d.key === p.dbg)?.label;
  return (
    <button type="button" onClick={() => p.open("layers")} style={style} className={cn(card, "absolute z-10 max-w-[calc(100%-2*var(--gutter))] rounded-control px-3 py-2 text-left", className)}>
      <span className={label}>{name}</span>
      <Legend p={p} theme={theme} className="mt-1" />
    </button>
  );
}

// ------------------------------------------------------------------ the chip strip (phone, tablet)

const ROW = 36;
const GAP = 6;
/**
 * The profile as chips: the profile itself first (opens the whole list), then one chip per
 * preference, the limits as one chip, and "add". It never scrolls sideways: it wraps to two rows at
 * most, changed preferences first, and what does not fit collapses into "+N" (opens the list too).
 */
function Strip({ p, rows = 2 }: { p: Plan; rows?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const changed = (id: string) => p.base.prefs[id] !== p.prefs[id];
  const ids = [...p.prefIds.filter(changed), ...p.prefIds.filter((id) => !changed(id))];
  const [n, setN] = useState(ids.length);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  // fit: start from all chips whenever the set or the width changes, then drop from the end until two rows hold
  const key = `${ids.join()}|${width}|${p.base.name}|${p.changes.length}`;
  const last = useRef("");
  useLayoutEffect(() => {
    if (last.current !== key) {
      last.current = key;
      if (n !== ids.length) return setN(ids.length);
    }
    if (ref.current && ref.current.offsetHeight > rows * ROW + (rows - 1) * GAP + 1 && n > 0) setN(n - 1);
  });
  const chip = (on: boolean) => cn("flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-float backdrop-blur-xl", on ? "border-transparent bg-foreground text-background" : "border-border bg-glass");
  const limitsOn = p.limitIds.filter((id) => p.limits[id] !== undefined).length;
  const limitsChanged = p.limitIds.some((id) => p.base.limits[id] !== p.limits[id]);
  const toLimits = () => {
    p.open("profile");
    window.setTimeout(() => document.getElementById("r3-limits")?.scrollIntoView({ block: "start", behavior: "smooth" }), 320);
  };
  const dot = <i className="size-1.5 shrink-0 rounded-full bg-signal" />;
  return (
    <div ref={ref} className={cn("flex flex-wrap gap-1.5", p.status === "download" && "pointer-events-none opacity-50")}>
      <button type="button" onClick={() => p.open(p.sheet === "profile" ? null : "profile")} className={chip(p.sheet === "profile")} aria-label="Open the whole profile">
        {p.base.own ? <Bookmark className="size-3.5" /> : <SlidersHorizontal className="size-3.5" />}
        <span className="max-w-36 truncate font-bold">{p.base.name}</span>
        {p.changes.length > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-signal px-1 text-2xs font-bold text-signal-foreground">{p.changes.length}</span>}
        <ChevronUp className="size-3.5 opacity-60" />
      </button>
      {ids.slice(0, n).map((id) => {
        const v = p.prefs[id] ?? 0;
        return (
          <button type="button" key={id} onClick={() => p.setChip(p.chip === id ? null : id)} className={chip(p.chip === id)}>
            {changed(id) && dot}
            {chipName(id)}
            <span className="relative h-1 w-6 overflow-hidden rounded-full bg-current/20"><i className="absolute inset-y-0 rounded-full bg-current" style={{ left: `${(Math.min(v, 0) + 100) / 2}%`, width: `${Math.max(8, Math.abs(v) / 2)}%` }} /></span>
          </button>
        );
      })}
      {ids.length > n && <button type="button" onClick={() => p.open("profile")} className={chip(false)} aria-label={`${ids.length - n} more preferences`}>+{ids.length - n}</button>}
      {p.limitIds.length > 0 && <button type="button" onClick={toLimits} className={chip(false)} aria-label={`${limitsOn} limits`}>{limitsChanged && dot}<Lock className="size-3.5" /><span className="tabular-nums">{limitsOn}</span></button>}
      <button type="button" onClick={() => p.setPicker(true)} className={cn(chip(false), "border-dashed border-foreground/35 px-2.5")} aria-label="Add a preference or limit"><Plus className="size-4" /></button>
    </div>
  );
}

/** One chip's editor: a single slider (or limit) with its explanation. The map stays visible. */
function Tune({ p, id }: { p: Plan; id: string }) {
  const isPref = id in p.prefs;
  return (
    <div>
      {isPref ? <PrefRow p={p} id={id} /> : <LimitRow p={p} id={id} />}
      <div className="flex items-center gap-2 px-1 pt-0.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{isPref ? attr(id).hint : limitDef(id).hint}</span>
        <span className="shrink-0 tabular-nums">rerouted in {p.rerouteMs} ms</span>
        <IconButton label="Done" onClick={() => p.setChip(null)} className="-my-1 size-7"><X className="size-3.5" /></IconButton>
      </div>
    </div>
  );
}

/**
 * The card above the strip. On the phone it is the route's summary (tap it for the details) and
 * turns into whatever needs the map next to it: one chip's slider, a comparison, a state. On the
 * tablet the totals live in the route card, so it only appears for the slider and the comparison.
 */
function SummaryCard({ p, totals = true }: { p: Plan; totals?: boolean }) {
  const off = p.status === "empty" || p.status === "download" || p.status === "error";
  if (off) return totals ? <section className={cn(card, "p-3.5")}><StatusBody p={p} /></section> : null;
  if (p.compare) return <section className={cn(card, "p-3.5")}><CompareResult p={p} /></section>;
  if (!totals) return p.chip ? <section className={cn(card, "p-3.5 pt-2.5")}><Tune p={p} id={p.chip} /></section> : null;
  return (
    <section className={cn(card, "p-3.5")}>
      <div className="flex items-center gap-2.5">
        <button type="button" aria-label="Show the route details" onClick={() => p.open("route")} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Stats p={p} size={p.chip ? "sm" : "lg"} />
          <ChevronUp className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </button>
        <GpxButton compact />
      </div>
      <BusyBar p={p} />
      {!p.chip && <LaneStrip route={p.route} by="surface" className="mt-3 h-1.5" />}
      <DeltaLine p={p} max={p.chip ? 3 : 4} className="mt-2" />
      {p.chip && <div className="mt-2.5 border-t border-border pt-2"><Tune p={p} id={p.chip} /></div>}
    </section>
  );
}

// ------------------------------------------------------------------ sheets (phone, tablet)

/**
 * A sheet: from the bottom on a narrow screen (two detents, the grabber toggles or drags), a panel
 * on the right when there is room beside it. `clear` is hold-to-clear: everything but `data-keep`
 * and the held row fades, the map shows through.
 */
function Sheet({ side, full, clear, vh, head, onHeight, children }: { side: boolean; full?: boolean; clear?: boolean; vh: number; head: ReactNode; onHeight?: (h: number) => void; children: ReactNode }) {
  const stops = [Math.round(vh * 0.6), vh - 56];
  const [detent, setDetent] = useState(0);
  const [pull, setPull] = useState<number | null>(null);
  const at = full ? 1 : detent;
  const height = pull ?? (stops[at] as number);
  useEffect(() => onHeight?.(side ? 0 : Math.min(height, stops[0] as number)), [height, side, onHeight, stops[0]]);
  const grip = {
    onPointerDown: (e: React.PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      const h0 = stops[at] as number;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientY - y0) > 4) moved = true;
        if (moved) setPull(Math.max(160, Math.min(vh - 40, h0 + y0 - ev.clientY)));
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        setPull(null);
        const h = h0 + y0 - ev.clientY;
        setDetent(moved ? (Math.abs((stops[0] as number) - h) < Math.abs((stops[1] as number) - h) ? 0 : 1) : 1 - at);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    },
    style: { touchAction: "none" as const },
  };
  if (side)
    return <section className={cn("absolute bottom-(--gutter) right-(--gutter) top-(--gutter) z-20 flex w-[min(400px,calc(100%-2*var(--gutter)))] flex-col p-4", card)}><div className="shrink-0 pb-3">{head}</div><div className="thin-scroll -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">{children}</div></section>;
  return (
    <section data-grab={clear ? "" : undefined} className={cn("r3-sheet absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-sheet border border-b-0 border-border bg-glass shadow-sheet backdrop-blur-xl", pull !== null && "!transition-none")} style={{ height }}>
      <div {...grip} data-fade className="shrink-0 cursor-grab pb-1.5 pt-2"><i className="mx-auto block h-1 w-9 rounded-full bg-foreground/20" /></div>
      <div className="shrink-0 px-4 pb-3">{head}</div>
      <div className={cn("thin-scroll min-h-0 flex-1 px-4 pb-6", clear ? "overflow-hidden" : "overflow-y-auto")}>{children}</div>
    </section>
  );
}

function SheetHead({ title, onClose, children }: { title?: string; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {title && <span className="text-base font-extrabold tracking-tight">{title}</span>}
      {children}
      <span data-fade className="ml-auto"><IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton></span>
    </div>
  );
}

/** The whole profile: base, diff and preset, the list, compare. The same body in the phone's sheet, the tablet's panel and the desk's card. */
function ProfileBody({ p, held, onGrab, onRelease, result, onCompare }: { p: Plan; held?: string | null; onGrab?: (id: string) => void; onRelease?: () => void; result?: boolean; onCompare?: () => void }) {
  return (
    <div className="space-y-3">
      {result && p.compare && <div className="rounded-control border border-border p-3"><CompareResult p={p} /></div>}
      <div data-fade><DiffBar p={p} /></div>
      <ProfileList p={p} held={held} onGrab={onGrab} onRelease={onRelease} />
      <div data-fade className="border-t border-border pt-3"><ComparePick p={p} onPick={onCompare} /></div>
    </div>
  );
}

/** Whichever sheet is open. The picker wins over the others and returns to them. */
function Sheets({ p, theme, side, vh, onHeight, totals = true }: { p: Plan; theme: Theme; side: boolean; vh: number; onHeight?: (h: number) => void; totals?: boolean }) {
  const [held, setHeld] = useState<string | null>(p.hold);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = () => p.open(null);
  const open = p.picker || p.sheet !== null;
  useEffect(() => {
    if (!open) onHeight?.(0);
  }, [open, onHeight]);
  if (p.picker) return <Sheet side={side} full vh={vh} onHeight={onHeight} head={null}><Picker p={p} className="h-full" /></Sheet>;
  if (p.sheet === "route" && totals)
    return (
      <Sheet side={side} vh={vh} onHeight={onHeight} head={<SheetHead onClose={close}><Stats p={p} /><span className="ml-auto" /><GpxButton /></SheetHead>}>
        <BusyBar p={p} />
        <DeltaLine p={p} className="mb-3" />
        <RouteDetails p={p} />
      </Sheet>
    );
  if (p.sheet === "profile") {
    const clear = !side && held !== null;
    return (
      <Sheet side={side} clear={clear} vh={vh} onHeight={onHeight} head={
        <div data-keep className="-mx-2 flex items-center gap-2 px-2 py-1">
          {totals || clear ? <Stats p={p} size="sm" /> : <span className="text-base font-extrabold tracking-tight">Profile</span>}
          {clear ? <span className="ml-auto text-xs tabular-nums text-muted-foreground">rerouted in {p.rerouteMs} ms</span> : <span className="ml-auto"><IconButton label="Close" onClick={close}><X className="size-4" /></IconButton></span>}
        </div>
      }>
        <ProfileBody
          p={p}
          held={held}
          onCompare={close}
          onGrab={(id) => {
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setHeld(id), 110);
          }}
          onRelease={() => {
            window.clearTimeout(timer.current);
            setHeld(null);
          }}
        />
      </Sheet>
    );
  }
  if (p.sheet === "layers") return <Sheet side={side} vh={vh} onHeight={onHeight} head={<SheetHead title="Map & rides" onClose={close} />}><LayersPanel p={p} theme={theme} /></Sheet>;
  return null;
}

function useHeight(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(200);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setH(Math.round(e.contentRect.height)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, h];
}

// ------------------------------------------------------------------ phone

function Phone({ p, theme, toggleTheme, w, h }: LayoutProps & { w: number; h: number }) {
  const [stack, stackH] = useHeight();
  const [sheetH, setSheetH] = useState(0);
  // a phone in landscape: sheets open beside the map, not over it
  const side = w >= 600;
  const short = h < 560;
  // a bottom sheet takes the place of the stack
  const covered = !side && (p.picker || p.sheet !== null);
  const cover = sheetH || Math.min(stackH, Math.round(h * 0.62));
  return (
    <>
      <PlanMap p={p} theme={theme} pad={side ? { top: 60, bottom: 30, left: 480, right: 40 } : { top: 64, bottom: cover + 28, left: 34, right: 34 }} attribBottom={side ? 0 : cover + 14} />
      <TopBar p={p} theme={theme} toggleTheme={toggleTheme} />
      <LegendPill p={p} theme={theme} className="left-(--gutter) top-[calc(var(--gutter)+48px)]" />
      <div ref={stack} className={cn("absolute bottom-(--gutter) left-(--gutter) z-10 flex flex-col gap-2 transition-opacity", side ? "w-[min(440px,calc(100%-2*var(--gutter)))]" : "right-(--gutter)", covered && "pointer-events-none opacity-0")}>
        <SummaryCard p={p} />
        <Strip p={p} rows={short ? 1 : 2} />
        {!short && <AgentBar />}
      </div>
      <Sheets p={p} theme={theme} side={side} vh={h} onHeight={setSheetH} />
    </>
  );
}

// ------------------------------------------------------------------ tablet and desk

function Desk({ p, theme, toggleTheme, mode }: LayoutProps & { mode: Mode }) {
  const desk = mode === "desk";
  const [stack, stackH] = useHeight();
  const left = desk ? 372 : 340;
  const right = 404;
  const off = p.status === "empty" || p.status === "download" || p.status === "error";
  return (
    <>
      <PlanMap p={p} theme={theme} wide={desk} maxNotes={desk ? 3 : 2} pad={{ top: 90, bottom: desk ? 100 : stackH + 50, left: left + 48, right: desk ? right + 48 : 48 }} />
      <TopBar p={p} theme={theme} toggleTheme={toggleTheme} wide />
      <LegendPill p={p} theme={theme} className="top-[calc(var(--gutter)+52px)]" style={{ left: `calc(${left}px + 2*var(--gutter))` }} />

      {/* the route: totals, timeline, stops */}
      <section className={cn("thin-scroll absolute left-(--gutter) top-[calc(var(--gutter)+52px)] z-10 overflow-y-auto p-4", card)} style={{ width: left, maxHeight: "calc(100% - 2*var(--gutter) - 52px)" }}>
        <div className={cn(label, "mb-3")}>{off ? "New route" : "Ridge to the lake"}</div>
        {off ? <StatusBody p={p} /> : (
          <>
            <div className="flex items-end justify-between gap-2"><Stats p={p} /><GpxButton /></div>
            <BusyBar p={p} />
            <DeltaLine p={p} className="mt-2.5" />
            <div className="mt-3.5"><RouteDetails p={p} /></div>
          </>
        )}
      </section>

      {desk ? (
        <>
          {/* the profile: the whole list, always on screen */}
          <section className={cn("absolute right-(--gutter) top-[calc(var(--gutter)+52px)] z-10 flex flex-col p-4", card)} style={{ width: right, maxHeight: "calc(100% - 2*var(--gutter) - 52px)", height: p.picker ? "calc(100% - 2*var(--gutter) - 52px)" : undefined }}>
            {p.picker ? <Picker p={p} className="flex-1" /> : <div className="thin-scroll -mr-2 overflow-y-auto pr-2"><ProfileBody p={p} result /></div>}
          </section>
          {p.sheet === "layers" && (
            <section className={cn("thin-scroll absolute top-[calc(var(--gutter)+52px)] z-20 w-[344px] overflow-y-auto p-4", card)} style={{ right: `calc(${right}px + 2*var(--gutter))`, maxHeight: "calc(100% - 180px)" }}>
              <div className="mb-3 flex items-center"><span className="text-base font-extrabold tracking-tight">Map & rides</span><IconButton label="Close" onClick={() => p.open(null)} className="ml-auto"><X className="size-4" /></IconButton></div>
              <LayersPanel p={p} theme={theme} />
            </section>
          )}
          <AgentBar className="absolute bottom-(--gutter) left-1/2 z-10 -translate-x-1/2" style={{ width: `min(500px, calc(100% - ${left + right}px - 6*var(--gutter)))` }} />
        </>
      ) : (
        <>
          <div ref={stack} className={cn("absolute bottom-(--gutter) right-(--gutter) z-10 flex flex-col gap-2 transition-opacity", (p.picker || p.sheet === "profile" || p.sheet === "layers") && "pointer-events-none opacity-0")} style={{ left: `calc(${left}px + 2*var(--gutter))` }}>
            <SummaryCard p={p} totals={false} />
            <Strip p={p} />
            <AgentBar />
          </div>
          <Sheets p={p} theme={theme} side vh={0} totals={false} />
        </>
      )}
    </>
  );
}
