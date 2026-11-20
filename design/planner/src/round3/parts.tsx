import { ArrowUp, Bookmark, Car, Check, ChevronDown, ChevronRight, Crosshair, Download, Footprints, Grid3x3, GripVertical, History, Lock, type LucideIcon, Minus, Mountain, Plus, RotateCcw, Route as RouteIcon, Search, Signpost, Sparkles, Trees, TriangleAlert, Upload, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { type RouteData, compareRows, fmtKm, fmtTime, kmOf, legs, pct, pointAtKm } from "@/mock/data";
import { ATTRS, CORE, GROUPS, type GroupId, LIMITS, attr, limitDef, sections, word } from "@/round2/model";
import { deltas, moreDeltas, tradeoff } from "@/round2/parts";
import type { DebugAttr } from "@/round2/useTuner";
import type { Theme } from "@/shared/usePlanner";
import { useReorder } from "@/shared/usePlanner";
import { Elevation, Soon } from "@/shared/viz";
import { SEQ, SURFACE, UNKNOWN, WAY } from "./palette";
import { ERROR_LIMIT, type Plan } from "./state";

/**
 * Round 3: the shared components. Every one of them is used at every breakpoint; `Final.tsx` only
 * arranges them. The chrome is neutral: ink, greys and the one accent (`signal`) for the primary
 * action and the "changed from the base" marker. Anything else that is coloured is data.
 */

/** A card floating over the map. */
export const card = "rounded-card border border-border bg-glass shadow-float backdrop-blur-xl";
/** A section label. */
export const label = "text-2xs font-bold uppercase tracking-wider text-muted-foreground";
const pill = "flex shrink-0 items-center gap-1.5 rounded-full text-xs font-semibold";
const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
const GROUP_ICON: Record<GroupId, LucideIcon> = { surface: Grid3x3, ways: RouteIcon, traffic: Car, landscape: Trees, terrain: Mountain, signs: Signpost, trail: Footprints, history: History };
export const chipName = (id: string) => (attr(id).short === "New" ? "Never ridden" : attr(id).short);

export function IconButton({ label: text, onClick, children, className, on }: { label: string; onClick?: () => void; children: ReactNode; className?: string; on?: boolean }) {
  return <button type="button" aria-label={text} title={text} onClick={onClick} className={cn("grid size-8 shrink-0 place-items-center rounded-full", on ? "bg-foreground text-background" : "bg-foreground/8 hover:bg-foreground/12", className)}>{children}</button>;
}

// ------------------------------------------------------------------ sliders, limits

/**
 * The slider: neutral in the middle, left avoids, right seeks. Direction is told by position and by
 * the word next to the label, never by colour: the fill is ink. The small ring is the base profile's value.
 */
export function Dial({ value, base, onChange, onGrab, onRelease, name }: { value: number; base?: number; onChange: (v: number) => void; onGrab?: () => void; onRelease?: () => void; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  const PAD = 12;
  const at = (x: number) => {
    const r = (ref.current as HTMLDivElement).getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (x - r.left - PAD) / (r.width - 2 * PAD)));
    const v = Math.round((f * 200 - 100) / 5) * 5;
    return Math.abs(v) <= 5 ? 0 : v;
  };
  const drop = () => {
    if (!held.current) return;
    held.current = false;
    onRelease?.();
  };
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={name}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={value}
      className="relative h-7 w-full cursor-pointer touch-pan-y select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(Math.max(-100, value - 5));
        if (e.key === "ArrowRight") onChange(Math.min(100, value + 5));
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        held.current = true;
        onGrab?.();
        onChange(at(e.clientX));
      }}
      onPointerMove={(e) => held.current && onChange(at(e.clientX))}
      onPointerUp={drop}
      onPointerCancel={drop}
    >
      <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-track" style={{ left: PAD, right: PAD }}>
        <i className="absolute inset-y-0 rounded-full bg-foreground" style={{ left: `${(Math.min(value, 0) + 100) / 2}%`, width: `${Math.abs(value) / 2}%` }} />
        <i className="absolute left-1/2 top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40" />
        {base !== undefined && base !== value && <i title="The base profile's value" className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-muted-foreground bg-card" style={{ left: `${(base + 100) / 2}%` }} />}
        <i className="absolute top-1/2 size-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-card shadow-[0_1px_4px_rgb(0_0_0/0.25)]" style={{ left: `${(value + 100) / 2}%` }} />
      </div>
    </div>
  );
}

/** The marker of "changed against the base": the accent's main job. Tap it to put the row back. */
function ChangeDot({ on, onClick }: { on: boolean; onClick: () => void }) {
  if (!on) return null;
  return <button type="button" title="Changed against the base. Tap to put it back." aria-label="Back to the base value" onClick={onClick} className="-m-2 grid size-6 shrink-0 place-items-center"><i className="size-[7px] rounded-full bg-signal" /></button>;
}
const Tag = ({ children }: { children: ReactNode }) => <span className="shrink-0 rounded-full border border-border px-1.5 text-2xs font-semibold text-muted-foreground">{children}</span>;

interface RowProps { p: Plan; id: string; held?: boolean; onGrab?: (id: string) => void; onRelease?: () => void }

/** One soft preference: avoid ↔ seek. */
export function PrefRow({ p, id, held, onGrab, onRelease }: RowProps) {
  const a = attr(id);
  const v = p.prefs[id] ?? 0;
  const b = p.base.prefs[id];
  return (
    <div data-row data-held={held || undefined} className={cn("rounded-control px-1 pt-1", p.fresh === id && "r3-flash")}>
      <div className="flex h-5 items-center gap-1.5">
        <ChangeDot on={b !== v} onClick={() => (b === undefined ? p.removePref(id) : p.setPref(id, b))} />
        <span className="min-w-0 truncate text-sm font-semibold">{a.label}</span>
        {b === undefined && <Tag>added</Tag>}
        <span className="ml-auto shrink-0 whitespace-nowrap text-xs font-medium text-muted-foreground">{word(a, v)}</span>
        <span className="w-8 shrink-0 text-right text-xs font-bold tabular-nums">{signed(v)}</span>
        {!CORE.includes(id) && <button type="button" aria-label={`Remove ${a.label}`} onClick={() => p.removePref(id)} className="-mr-1.5 grid size-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>}
      </div>
      <Dial name={a.label} value={v} base={b} onChange={(x) => p.setPref(id, x)} onGrab={() => onGrab?.(id)} onRelease={onRelease} />
    </div>
  );
}

export function Switch({ on, onClick, name }: { on: boolean; onClick: () => void; name: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={name} onClick={onClick} className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors", on ? "bg-foreground" : "bg-track")}>
      <i className={cn("absolute top-0.5 size-5 rounded-full shadow transition-all", on ? "left-[18px] bg-background" : "left-0.5 bg-card")} />
    </button>
  );
}

/** One hard limit: a lock and a switch, with a stepper where it carries a number. Never a slider. */
export function LimitRow({ p, id }: { p: Plan; id: string }) {
  const def = limitDef(id);
  const v = p.limits[id];
  const b = p.base.limits[id];
  const on = v !== undefined;
  const par = def.param;
  const step = (d: number) => par && typeof v === "number" && p.setLimit(id, Math.max(par.min, Math.min(par.max, v + d * par.step)));
  const blamed = p.status === "error" && id === ERROR_LIMIT;
  return (
    <div data-row className={cn("flex h-11 items-center gap-2 rounded-control px-1", p.fresh === id && "r3-flash")}>
      <ChangeDot on={b !== v} onClick={() => p.setLimit(id, b ?? null)} />
      <Lock className={cn("size-3.5 shrink-0", !on && "text-muted-foreground/60")} />
      <span className={cn("min-w-0 flex-1 truncate text-sm font-semibold", !on && "text-muted-foreground line-through")}>{def.label}{blamed && <span className="ml-1.5 text-xs font-medium text-muted-foreground">· blocks the route</span>}</span>
      {par && typeof v === "number" && (
        <span className="flex h-8 shrink-0 items-center rounded-full bg-foreground/8 text-xs font-bold tabular-nums">
          <button type="button" aria-label="Lower" onClick={() => step(-1)} className="grid size-8 place-items-center"><Minus className="size-3.5" /></button>
          <span className="min-w-9 text-center">{par.fmt(v)}</span>
          <button type="button" aria-label="Higher" onClick={() => step(1)} className="grid size-8 place-items-center"><Plus className="size-3.5" /></button>
        </span>
      )}
      <Switch on={on} name={def.label} onClick={() => p.setLimit(id, on ? null : (b ?? par?.start ?? true))} />
    </div>
  );
}

export function AddButton({ p }: { p: Plan }) {
  return (
    <button type="button" onClick={() => p.setPicker(true)} className="flex h-11 w-full items-center gap-2 rounded-control border border-dashed border-foreground/30 px-3 text-sm font-semibold hover:border-foreground/60">
      <Plus className="size-4" />Add a preference or limit
      <span className="ml-auto text-xs font-medium text-muted-foreground">{ATTRS.length + LIMITS.length} in this region</span>
    </button>
  );
}

/** The whole profile as a list: sliders, the add button, limits. `limitsRef` lets the strip's limits chip scroll to them. */
export function ProfileList({ p, held, onGrab, onRelease }: { p: Plan; held?: string | null; onGrab?: (id: string) => void; onRelease?: () => void }) {
  return (
    <div>
      <div data-fade className="flex justify-between px-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground"><span>← avoid</span><span>no opinion</span><span>seek →</span></div>
      <div className="space-y-0.5">{p.prefIds.map((id) => <PrefRow key={id} p={p} id={id} held={held === id} onGrab={onGrab} onRelease={onRelease} />)}</div>
      <div data-fade className="mt-2"><AddButton p={p} /></div>
      <div data-fade id="r3-limits" className="mt-4">
        <div className={cn(label, "flex items-center gap-1.5")}><Lock className="size-3" />Limits · never broken</div>
        {p.limitIds.map((id) => <LimitRow key={id} p={p} id={id} />)}
        {p.limitIds.length === 0 && <p className="py-2 text-xs text-muted-foreground">None. Add one from the picker.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ base profile, diff, preset

function BaseChooser({ p }: { p: Plan }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {p.bases.map((b) => (
        <button type="button" key={b.id} title={b.blurb} onClick={() => p.setBase(b.id)} className={cn(pill, "h-8 border px-3", b.id === p.base.id ? "border-foreground bg-foreground text-background" : "border-border hover:border-foreground/40")}>
          {b.own && <Bookmark className="size-3" />}{b.name}
        </button>
      ))}
      <Soon className="h-8">Learn from my rides</Soon>
    </div>
  );
}

/**
 * The head of the profile: "Gravel explorer · 2 changes", the changes in words, reset, save as
 * preset. The name opens the base chooser in place (a permanent row of pills would cost a slider).
 */
export function DiffBar({ p }: { p: Plan }) {
  const [choosing, setChoosing] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const n = p.changes.length;
  const save = () => {
    p.savePreset(name.trim() || `${p.base.name} +`);
    setNaming(false);
    setName("");
  };
  const count = (
    <>
      {n > 0 && <i className="size-[7px] shrink-0 rounded-full bg-signal" />}
      <span className="shrink-0 whitespace-nowrap font-medium text-muted-foreground">{n === 0 ? "· as it comes" : `${n} change${n > 1 ? "s" : ""}`}</span>
    </>
  );
  return (
    <div className="rounded-control bg-foreground/[0.055] p-3">
      <div className="flex min-h-6 items-center gap-1.5 text-sm">
        <button type="button" aria-expanded={choosing} aria-label="Choose the base profile" onClick={() => setChoosing(!choosing)} className="flex min-w-0 items-center gap-0.5 font-bold"><span className="truncate">{p.base.name}</span><ChevronDown className={cn("size-4 shrink-0 transition-transform", choosing && "rotate-180")} /></button>
        {count}
      </div>
      {choosing && <div className="mt-2 mb-1" onClickCapture={() => setChoosing(false)}><BaseChooser p={p} /></div>}
      <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{n ? p.summary : p.base.blurb}</p>
      {n > 0 && !naming && (
        <div className="mt-2.5 flex gap-1.5">
          <button type="button" onClick={() => setNaming(true)} className={cn(pill, "h-8 border border-foreground/25 px-3 hover:border-foreground")}><Bookmark className="size-3.5" />Save as preset</button>
          <button type="button" onClick={p.reset} className={cn(pill, "h-8 px-2.5 text-muted-foreground hover:text-foreground")}><RotateCcw className="size-3.5" />Reset</button>
        </div>
      )}
      {naming && (
        <form className="mt-2.5 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {/* biome-ignore lint/a11y/noAutofocus: the field appears because the user asked for it */}
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`${p.base.name} +`} aria-label="Preset name" className="h-9 min-w-0 flex-1 rounded-full border border-input bg-card px-3.5 text-sm font-semibold outline-none focus:border-foreground" />
          <button type="submit" className={cn(pill, "h-9 bg-foreground px-4 text-background")}>Save</button>
          <button type="button" onClick={() => setNaming(false)} className={cn(pill, "h-9 px-2 text-muted-foreground")}>Cancel</button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ picker

interface Item { kind: "pref" | "limit"; id: string; group: GroupId; label: string; hint: string; coverage?: number; has: boolean }

/** The catalogue: every attribute the region data offers. Search first, grouped below; a tap adds. */
export function Picker({ p, className }: { p: Plan; className?: string }) {
  const [q, setQ] = useState("");
  const all: Item[] = [
    ...ATTRS.map((a) => ({ kind: "pref" as const, id: a.id, group: a.group, label: a.label, hint: a.hint, coverage: a.coverage, has: a.id in p.prefs })),
    ...LIMITS.map((l) => ({ kind: "limit" as const, id: l.id, group: l.group, label: l.label, hint: l.hint, has: l.id in p.limits })),
  ];
  const needle = q.trim().toLowerCase();
  const hit = (i: Item) => !needle || `${i.label} ${i.hint} ${GROUPS.find((g) => g.id === i.group)?.label}`.toLowerCase().includes(needle);
  const groups = GROUPS.map((g) => ({ ...g, items: all.filter((i) => i.group === g.id && hit(i)) })).filter((g) => g.items.length);
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 pb-2.5">
        <span className="text-base font-extrabold tracking-tight">Add a preference</span>
        <IconButton label="Close" onClick={() => p.setPicker(false)} className="ml-auto"><X className="size-4" /></IconButton>
      </div>
      <label className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-input bg-card px-4 focus-within:border-foreground">
        <Search className="size-4 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: forest, cobbles, traffic…" aria-label="Search preferences" className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none" />
        {q && <button type="button" aria-label="Clear" onClick={() => setQ("")}><X className="size-4 text-muted-foreground" /></button>}
      </label>
      <div className="thin-scroll -mx-1 mt-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {groups.length === 0 && <p className="px-2 py-8 text-center text-sm text-muted-foreground">Nothing in this region's data matches “{q}”.</p>}
        {groups.map((g) => {
          const Icon = GROUP_ICON[g.id];
          return (
            <div key={g.id}>
              <div className={cn(label, "flex items-center gap-1.5 px-2 pb-0.5 pt-3.5")}><Icon className="size-3.5" />{g.label}<span className="font-medium normal-case tracking-normal">· {g.blurb}</span></div>
              {g.items.map((i) => (
                <button type="button" key={i.id} disabled={i.has} onClick={() => (i.kind === "pref" ? p.addPref(i.id) : p.addLimit(i.id))} className={cn("flex min-h-12 w-full items-center gap-3 rounded-control px-2 py-1.5 text-left hover:bg-foreground/6", i.has && "opacity-45")}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      {i.kind === "limit" && <Lock className="size-3.5 shrink-0" />}<span className="truncate">{i.label}</span>{i.kind === "limit" && <Tag>limit</Tag>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{i.hint}{i.coverage ? ` Mapped on ${i.coverage} % of ways.` : ""}</span>
                  </span>
                  <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", i.has ? "text-muted-foreground" : "bg-foreground/8")}>{i.has ? <Check className="size-4" /> : <Plus className="size-4" />}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ route: totals, timeline, stops

/** Distance, climb, time. Dimmed with a running bar while the engine works. */
export function Stats({ p, size = "lg", className }: { p: Plan; size?: "lg" | "sm"; className?: string }) {
  const r = p.route;
  return (
    <div className={cn("flex items-baseline gap-x-3.5", p.status === "busy" && "opacity-45", className)}>
      {[[fmtKm(r.km), "km"], [String(r.climb), "m ↑"], [fmtTime(r.minutes), "h"]].map(([v, u]) => (
        <div key={u} className="whitespace-nowrap leading-none">
          <span className={cn("font-bold tracking-tight tabular-nums", size === "lg" ? "text-2xl" : "text-lg")}>{v}</span>
          <span className="ml-0.5 text-xs text-muted-foreground">{u}</span>
        </div>
      ))}
    </div>
  );
}
export const BusyBar = ({ p }: { p: Plan }) => (p.status === "busy" ? <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><span className="r3-busy h-[3px] flex-1 rounded-full bg-track" />Routing…</div> : null);

const DashKey = () => <svg width="18" height="4" aria-hidden="true" className="shrink-0"><line x1="0" y1="2" x2="18" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray="4 2.5" /></svg>;

/** What the tweaks cost and bought against the base profile's route (the dashed line on the map). Numbers, in ink. */
export function DeltaLine({ p, max, className }: { p: Plan; max?: number; className?: string }) {
  if (p.status !== "ready" && p.status !== "busy") return null;
  if (!p.moved) return p.changes.length ? <p className={cn("text-xs text-muted-foreground", className)}>Your changes do not move the route yet.</p> : null;
  const all = [...deltas(p.route, p.baseRoute), ...moreDeltas(p.route, p.baseRoute)];
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs tabular-nums", className)}>
      <span className="flex items-center gap-1.5 text-muted-foreground"><DashKey />vs base</span>
      {all.slice(0, max).map((d) => <span key={d} className="whitespace-nowrap font-semibold">{d}</span>)}
    </div>
  );
}

const HATCH = "repeating-linear-gradient(135deg, transparent 0 2px, rgb(0 0 0 / 0.3) 2px 3.5px)";
type LaneBy = "surface" | "way" | "ridden";
/** The route unrolled along its distance, coloured by one attribute. Data colours. */
export function LaneStrip({ route, by, maxKm, className }: { route: RouteData; by: LaneBy; maxKm?: number; className?: string }) {
  const total = maxKm ?? route.km;
  const color = (s: RouteData["segs"][number]) => (by === "surface" ? `var(--surface-${s.surface})` : by === "way" ? `var(--way-${s.road})` : s.novel ? "transparent" : "var(--ridden)");
  return (
    <div className={cn("flex w-full overflow-hidden rounded-[3px] bg-track", className)}>
      {route.segs.map((s) => <i key={s.i0} style={{ width: `${((s.to - s.from) / total) * 100}%`, background: color(s), backgroundImage: by === "surface" && s.surface === "unknown" ? HATCH : undefined }} />)}
    </div>
  );
}

const LANES: [LaneBy, string][] = [["surface", "Surface"], ["way", "Way"], ["ridden", "Ridden"]];
/** The timeline: elevation over lanes for surface, way type and ridden-before, plus the stretches the tweaks moved. Drag across it to follow on the map. */
export function Lanes({ p, height = 48, className }: { p: Plan; height?: number; className?: string }) {
  const r = p.route;
  const max = Math.max(r.km, p.compareRoute?.km ?? 0);
  const [at, setAt] = useState<number | null>(null);
  const base = sections(p.baseRoute);
  const changed = p.compareRoute ? [] : sections(r).filter((s, k) => s.src !== base[k]?.src);
  const marks = p.waypoints.slice(1, -1).map((w, i) => ({ km: kmOf(r, w.lngLat), label: String(i + 1) }));
  const scrub = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    const km = Math.max(0, Math.min(r.km, ((e.clientX - b.left) / b.width) * max));
    setAt(km);
    p.setCursor(pointAtKm(r, km));
  };
  const leave = () => {
    setAt(null);
    p.setCursor(null);
  };
  const seg = at === null ? null : (r.segs.find((s) => s.to >= at) ?? r.segs[r.segs.length - 1]);
  const ele = at === null ? 0 : (r.profile.find((q) => q[0] >= at) ?? r.profile[r.profile.length - 1])?.[1];
  return (
    <div className={className}>
      <div className={cn(label, "grid grid-cols-[52px_1fr] items-center gap-x-2 gap-y-1")}>
        <span>Climb</span>
        <div className="relative touch-pan-y" onPointerMove={scrub} onPointerDown={scrub} onPointerLeave={leave}>
          <Elevation route={r} compare={p.compareRoute} color="var(--foreground)" compareColor="var(--route-alt)" height={height} grid={false} fillOpacity={0.07} marks={marks} className="normal-case tracking-normal text-foreground" />
          {at !== null && <i className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--route)]" style={{ left: `${(at / max) * 100}%` }} />}
        </div>
        {LANES.map(([by, name]) => <div key={by} className="contents"><span>{name}</span><LaneStrip route={r} by={by} maxKm={max} className="h-2" /></div>)}
        {changed.length > 0 && (
          <div className="contents">
            <span className="flex items-center gap-1 text-foreground"><i className="size-[6px] rounded-full bg-signal" />Moved</span>
            <div className="relative h-1">{changed.map((s) => <i key={s.from} title="Differs from the base profile's route" className="absolute inset-y-0 rounded-full bg-signal" style={{ left: `${(s.from / max) * 100}%`, width: `${((s.to - s.from) / max) * 100}%` }} />)}</div>
          </div>
        )}
      </div>
      <div className="mt-1.5 h-4 truncate pl-[60px] text-xs tabular-nums text-muted-foreground">
        {at !== null && seg ? (
          <span><b className="text-foreground">{fmtKm(at)} km</b> · {ele} m · {SURFACE.find((s) => s.key === seg.surface)?.label} · {WAY.find((x) => x.key === seg.road)?.label}{seg.novel ? " · new to you" : ""}</span>
        ) : (
          <span className="flex justify-between"><span>0</span><span>{changed.length ? "marked: differs from the base" : "drag to follow on the map"}</span><span>{fmtKm(max)} km</span></span>
        )}
      </div>
    </div>
  );
}

const Swatch = ({ color, hatch }: { color: string; hatch?: boolean }) => <i className="size-2 shrink-0 rounded-[2px]" style={{ background: color, backgroundImage: hatch ? HATCH : undefined }} />;
/** Both breakdowns as legends with shares: the lanes above are the bars. */
export function Shares({ route, className }: { route: RouteData; className?: string }) {
  const line = (defs: { key: string; label: string }[], vals: Record<string, number | undefined>, prefix: string) => (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      {defs.filter((d) => (vals[d.key] ?? 0) / route.km >= 0.015).map((d) => <span key={d.key} className="inline-flex items-center gap-1 whitespace-nowrap"><Swatch color={`var(--${prefix}-${d.key})`} hatch={d.key === "unknown"} />{d.label} <b className="text-foreground tabular-nums">{pct(vals[d.key] ?? 0, route.km)}%</b></span>)}
    </div>
  );
  return (
    <div className={cn("space-y-1 text-xs text-muted-foreground", className)}>
      {line(SURFACE, route.surface, "surface")}
      {line(WAY, route.road, "way")}
      <div className="inline-flex items-center gap-1"><Swatch color="var(--ridden)" />Ridden before <b className="text-foreground tabular-nums">{100 - pct(route.newKm, route.km)}%</b><span>· {fmtKm(route.newKm)} km new to you</span></div>
    </div>
  );
}

/** The stops, reorderable. Each leg has room for its own profile later. */
export function Waypoints({ p }: { p: Plan }) {
  const ROW = 44;
  const { drag, handle } = useReorder(ROW, p.moveWaypoint);
  const lg = legs(p.route, p.waypoints);
  return (
    <div>
      <ol>
        {p.waypoints.map((w, i) => {
          const end = i === 0 || i === p.waypoints.length - 1;
          return (
            <li key={w.id} className={cn("flex items-center gap-2.5 border-t border-border text-sm", drag?.index === i && "relative z-10 rounded-control bg-muted")} style={{ height: ROW, transform: drag?.index === i ? `translateY(${drag.dy}px)` : undefined }}>
              <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-2xs font-bold", end ? "bg-foreground text-background" : "border-[1.5px] border-foreground")}>{i === 0 ? "A" : end ? "B" : i}</span>
              <span className="min-w-0 flex-1 truncate font-semibold">{w.name}</span>
              {lg[i] && <span className="text-xs tabular-nums text-muted-foreground">{fmtKm(lg[i].km)} km</span>}
              <button type="button" aria-label={`Remove ${w.name}`} onClick={() => p.removeWaypoint(w.id)} className="grid size-7 place-items-center text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
              <button type="button" aria-label={`Move ${w.name}`} className="grid size-7 place-items-center text-muted-foreground" {...handle(i)}><GripVertical className="size-4" /></button>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" onClick={p.addWaypoint} className={cn(pill, "h-8 bg-foreground px-3 text-background")}><Plus className="size-3.5" />Stop</button>
        <Soon className="h-8">Profile per leg</Soon><Soon className="h-8">Through this area</Soon><Soon className="h-8">Avoid this area</Soon><Soon className="h-8">Draw it</Soon><Soon className="h-8">Make it a loop</Soon>
      </div>
    </div>
  );
}

/** The primary action of the planner, and the one filled use of the accent. */
export function GpxButton({ compact, disabled }: { compact?: boolean; disabled?: boolean }) {
  return <button type="button" disabled={disabled} aria-label="Export GPX" title="Export GPX" className={cn(pill, "h-9 justify-center bg-signal text-signal-foreground disabled:bg-foreground/10 disabled:text-muted-foreground", compact ? "w-9" : "px-3.5")}><Download className="size-4" />{!compact && "GPX"}</button>;
}

/** Everything about the route below its totals: timeline, shares, stops. */
export function RouteDetails({ p }: { p: Plan }) {
  return (
    <div className="space-y-3.5">
      <Lanes p={p} />
      <Shares route={p.route} />
      <Waypoints p={p} />
    </div>
  );
}

// ------------------------------------------------------------------ compare

/** Pick a second profile to compare with. */
export function ComparePick({ p, onPick }: { p: Plan; onPick?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-semibold text-muted-foreground">Compare with</span>
      {p.bases.filter((b) => b.id !== p.base.id).map((o) => (
        <button type="button" key={o.id} onClick={() => { p.setCompare(p.compare?.id === o.id ? null : o.id); onPick?.(); }} className={cn(pill, "h-8 border px-3", p.compare?.id === o.id ? "border-foreground bg-foreground text-background" : "border-border hover:border-foreground/40")}>{o.name}</button>
      ))}
    </div>
  );
}
const LineKey = ({ color }: { color: string }) => <i className="h-1 w-4 shrink-0 rounded-full" style={{ background: color }} />;
/** Two routes and their trade-off in words. The two colours are the two lines on the map. */
export function CompareResult({ p, table = true }: { p: Plan; table?: boolean }) {
  if (!p.compare || !p.compareRoute) return null;
  const words = tradeoff(p.route, p.compareRoute);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-semibold">
        <span className="flex items-center gap-1.5"><LineKey color="var(--route)" />{p.base.name}{p.changes.length > 0 && " +"}</span>
        <span className="flex items-center gap-1.5"><LineKey color="var(--route-alt)" />{p.compare.name}</span>
      </div>
      <p className="mt-1.5 text-sm leading-snug"><b>{p.compare.name}</b> {words.first} {words.second}</p>
      {table && (
        <div className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
          {compareRows(p.route, p.compareRoute).map((x) => (
            <div key={x.label}>
              <div className="text-muted-foreground">{x.label}</div>
              <div className="whitespace-nowrap font-semibold tabular-nums">{x.a.replace(/ (km|m)$/, "")} <span className="font-normal text-muted-foreground">→</span> {x.b}</div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-1.5">
        <button type="button" onClick={() => p.setBase(p.compare?.id ?? "")} className={cn(pill, "h-9 bg-foreground px-3.5 text-background")}><Check className="size-4" />Ride it this way</button>
        <button type="button" onClick={() => p.setCompare(null)} className={cn(pill, "h-9 px-3 text-muted-foreground hover:text-foreground")}>Dismiss</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ map layers, rides

export interface LayerDef { key: DebugAttr; label: string; hint: string; items: { label: string; color: string }[] }
/** The attribute layers the sandbox can paint, with their legends in the data palette. */
export function layerDefs(theme: Theme): LayerDef[] {
  const seq = SEQ[theme];
  const ramp = (names: string[]) => names.map((l, i) => ({ label: l, color: seq[i] as string }));
  return [
    { key: "surface", label: "Surface", hint: "OSM surface and track grade. Unknown stays unknown.", items: [...SURFACE.filter((s) => s.key === "paved" || s.key === "gravel").map((s) => ({ label: s.key === "gravel" ? "Unpaved" : s.label, color: s.color[theme] })), { label: "Unknown", color: UNKNOWN[theme] }] },
    { key: "road", label: "Way type", hint: "What kind of way it is.", items: WAY.map((w) => ({ label: w.label, color: w.color[theme] })) },
    { key: "traffic", label: "Traffic", hint: "Guessed from class, lanes and speed limit.", items: ramp(["Car-free", "Calm", "Some", "Busy", "Heavy"]) },
    { key: "trail", label: "Trail difficulty", hint: "MTB scale where mapped; grey means nobody rated it.", items: [...ramp(["S0", "S1", "S2", "S3+"]), { label: "Not rated", color: UNKNOWN[theme] }] },
    { key: "cost", label: "Cost in this profile", hint: "What your sliders and limits make of every way. Tune and watch it change.", items: [...ramp(["Loves it", "Likes", "Neutral", "Dislikes"]), { label: "Excluded", color: UNKNOWN[theme] }] },
  ];
}

/** The legend of the active layer: swatches are data, the rest is ink. */
export function Legend({ p, theme, className }: { p: Plan; theme: Theme; className?: string }) {
  if (p.layer === "explored") return <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}><span className="inline-flex items-center gap-1.5"><LineKey color="var(--ridden)" />Ridden, stronger the more often</span><span className="text-muted-foreground">Never ridden stays the map</span></div>;
  const def = layerDefs(theme).find((d) => d.key === p.dbg);
  if (!def) return null;
  return <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-xs", className)}>{def.items.map((it) => <span key={it.label} className="inline-flex items-center gap-1.5 whitespace-nowrap"><LineKey color={it.color} />{it.label}</span>)}</div>;
}

const RIDES = [
  { name: "Sunday ridge loop", when: "3 days ago", km: 62, fresh: 18 },
  { name: "After-work gravel", when: "last week", km: 34, fresh: 4 },
  { name: "Lake and back", when: "2 weeks ago", km: 48, fresh: 0 },
];
const MODES = [["normal", "Map"], ["debug", "Attribute"], ["explored", "Explored"]] as const;

/** The layers control: the plain map, ONE attribute layer with its legend, or the explored map; and the rides that feed it. */
export function LayersPanel({ p, theme }: { p: Plan; theme: Theme }) {
  const defs = layerDefs(theme);
  const def = defs.find((d) => d.key === p.dbg);
  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-3 rounded-full bg-foreground/8 p-1 text-xs font-semibold">
        {MODES.map(([key, name]) => <button type="button" key={key} onClick={() => p.setLayer(key)} className={cn("h-8 rounded-full", p.layer === key ? "bg-card shadow-sm" : "text-muted-foreground")}>{name}</button>)}
      </div>
      {p.layer === "normal" && (
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">Colour the route by surface</span><span className="block text-xs text-muted-foreground">Off: one line in the route colour. The timeline shows surface either way.</span></span>
          <Switch on={p.lineBy === "surface"} name="Colour the route by surface" onClick={() => p.setLineBy(p.lineBy === "surface" ? "plain" : "surface")} />
        </div>
      )}
      {p.layer === "debug" && def && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {defs.map((d) => <button type="button" key={d.key} onClick={() => p.setDbg(d.key)} className={cn(pill, "h-8 border px-3", d.key === p.dbg ? "border-foreground bg-foreground text-background" : "border-border")}>{d.label}</button>)}
            <Soon className="h-8"><Search className="size-3" />{ATTRS.length - 4} more</Soon>
          </div>
          <Legend p={p} theme={theme} />
          <p className="text-xs leading-snug text-muted-foreground">{def.hint}</p>
        </>
      )}
      {p.layer === "explored" && <Legend p={p} theme={theme} />}
      <div className="border-t border-border pt-3.5">
        <div className="mb-2 flex items-baseline justify-between"><span className={label}>My rides</span><span className="text-xs text-muted-foreground">214 rides · 38 % of the area ridden</span></div>
        <label className="flex h-11 cursor-pointer items-center gap-2 rounded-control border border-dashed border-foreground/30 px-3 text-sm font-semibold hover:border-foreground/60" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); p.addImport([...e.dataTransfer.files].map((f) => f.name)); }}>
          <input type="file" accept=".gpx,.fit" multiple className="hidden" onChange={(e) => p.addImport([...(e.target.files ?? [])].map((f) => f.name))} />
          <Upload className="size-4" />Import GPX or FIT
          <span className="ml-auto truncate text-xs font-medium text-muted-foreground">{p.imports.length ? `${p.imports.length} added just now` : "or drop files here"}</span>
        </label>
        <ul className="mt-1">
          {RIDES.map((r) => (
            <li key={r.name} className="flex h-10 items-center gap-2 border-b border-border text-sm">
              <span className="min-w-0 flex-1 truncate font-semibold">{r.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{r.km} km</span>
              <span className={cn("w-20 text-right text-xs tabular-nums", r.fresh ? "font-semibold" : "text-muted-foreground")}>{r.fresh ? `${r.fresh} km new` : "nothing new"}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="flex h-10 w-full items-center text-sm font-semibold">All rides<ChevronRight className="ml-auto size-4 text-muted-foreground" /></button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ agent, states

/** The agent's place. Not wired: it will edit the same profile, and say what it did in the words of the diff. */
export function AgentBar({ className, style, hint = "40 km loop north-west, quiet gravel…" }: { className?: string; style?: React.CSSProperties; hint?: string }) {
  return (
    <div style={style} className={cn(card, "flex h-11 items-center gap-2 rounded-full pl-4 pr-1.5", className)} title="Later: the agent edits the same profile">
      <Sparkles className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{hint}</span>
      <span className="shrink-0 rounded-full border border-dashed border-foreground/30 px-2 text-2xs font-semibold text-muted-foreground">later</span>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/10 text-muted-foreground"><ArrowUp className="size-4" /></span>
    </div>
  );
}

/** What stands in for the route's totals when there is no route: nothing planned yet, the region still downloading, or no way through. */
export function StatusBody({ p }: { p: Plan }) {
  if (p.status === "empty")
    return (
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground/8"><Crosshair className="size-5" /></span>
        <span className="min-w-0 flex-1"><span className="block text-base font-bold">Tap the map to set a start</span><span className="block text-xs text-muted-foreground">Then tap again for where to go. {p.base.name} decides the way.</span></span>
      </div>
    );
  if (p.status === "download") {
    const total = 460;
    return (
      <div>
        <div className="flex items-baseline justify-between gap-2"><span className="text-base font-bold">Getting the region ready</span><span className="text-xs font-semibold tabular-nums">{Math.round(p.progress * 100)} %</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-track"><i className="block h-full rounded-full bg-foreground transition-[width]" style={{ width: `${p.progress * 100}%` }} /></div>
        <p className="mt-2 text-xs text-muted-foreground"><span className="tabular-nums">{Math.round(p.progress * total)} of {total} MB</span> · routing data, then the map. Once, then it works offline.</p>
      </div>
    );
  }
  if (p.status === "error") {
    const def = limitDef(ERROR_LIMIT);
    return (
      <div>
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground/8"><TriangleAlert className="size-5" /></span>
          <span className="min-w-0 flex-1"><span className="block text-base font-bold">No route with “{def.label}”</span><span className="block text-xs leading-snug text-muted-foreground">Between St. Peter and St. Märgen every way through is unpaved for at least 2.1 km. The dashed line is the route without this limit.</span></span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button type="button" onClick={p.liftLimit} className={cn(pill, "h-9 bg-foreground px-3.5 text-background")}><Lock className="size-3.5" />Lift “{def.label}”</button>
          <button type="button" onClick={() => p.open("profile")} className={cn(pill, "h-9 border border-foreground/25 px-3.5")}>Show the limits</button>
        </div>
      </div>
    );
  }
  return null;
}

/** The profile sheet scrolls to a just-added row. */
export function useFlashScroll(fresh: string | null) {
  useEffect(() => {
    if (fresh) document.querySelector(".r3-flash")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [fresh]);
}
