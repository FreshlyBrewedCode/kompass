import { ArrowLeft, ArrowUp, Bookmark, Car, Check, ChevronDown, Download, Footprints, Grid3x3, GripVertical, History, Lock, type LucideIcon, Minus, Mountain, Plus, RotateCcw, Route as RouteIcon, Search, Signpost, Sparkles, Trees, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { NOVEL_COLOR, type Profile, ROADS, type RouteData, SURFACES, compareRows, fmtKm, fmtTime, legs, kmOf, pct, pointAtKm, unpavedKm } from "@/mock/data";
import { LEGENDS, attrColor } from "@/shared/attrs";
import { useReorder } from "@/shared/usePlanner";
import { Elevation, ImportDrop, SegStrip, Soon } from "@/shared/viz";
import { ATTRS, CORE, GROUPS, type GroupId, LIMITS, attr, limitDef, sections, word } from "./model";
import type { DebugAttr, Tuner } from "./useTuner";

export const glass = "border border-border bg-card shadow-[0_8px_30px_rgb(0_0_0/0.14)] backdrop-blur-xl";
export const HOT = { light: ["#f0451f", "#2563eb"], dark: ["#ff6a45", "#6ea8ff"] } as const;
const GROUP_ICON: Record<GroupId, LucideIcon> = { surface: Grid3x3, ways: RouteIcon, traffic: Car, landscape: Trees, terrain: Mountain, signs: Signpost, trail: Footprints, history: History };
const tone = (v: number) => (v > 7 ? "var(--more)" : v < -7 ? "var(--less)" : "var(--muted-foreground)");
const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");

// ------------------------------------------------------------------ sliders

/** A slider that is neutral in the middle: left avoids, right seeks. The tick is the base profile's value. */
export function Dial({ value, base, onChange, onGrab, onRelease, label }: { value: number; base?: number; onChange: (v: number) => void; onGrab?: () => void; onRelease?: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  const PAD = 11;
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
      aria-label={label}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={value}
      className="relative h-6 w-full cursor-pointer touch-pan-y select-none outline-none"
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
      <div className="absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full bg-foreground/12" style={{ left: PAD, right: PAD }}>
        <i className="absolute inset-y-0 rounded-full" style={{ left: `${(Math.min(value, 0) + 100) / 2}%`, width: `${Math.abs(value) / 2}%`, background: tone(value) }} />
        <i className="absolute left-1/2 top-1/2 h-[11px] w-[1.5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/35" />
        {base !== undefined && base !== value && <i title="The base profile's value" className="absolute top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-foreground/55 bg-background" style={{ left: `${(base + 100) / 2}%` }} />}
        <i className="absolute top-1/2 size-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/10 bg-white shadow-[0_1px_5px_rgb(0_0_0/0.3)]" style={{ left: `${(value + 100) / 2}%` }} />
      </div>
    </div>
  );
}

interface RowProps {
  t: Tuner;
  id: string;
  /** One line (label, slider, number) instead of two. */
  dense?: boolean;
  held?: boolean;
  onGrab?: (id: string) => void;
  onRelease?: () => void;
}
function ChangeDot({ on, onClick }: { on: boolean; onClick: () => void }) {
  if (!on) return null;
  return <button type="button" title="Changed against the base. Tap to put it back." aria-label="Back to the base value" onClick={onClick} className="-m-1.5 grid size-5 shrink-0 place-items-center"><i className="size-[7px] rounded-full bg-[var(--hot)]" /></button>;
}

/** One soft preference: avoid ↔ seek. */
export function PrefRow({ t, id, dense, held, onGrab, onRelease }: RowProps) {
  const a = attr(id);
  const v = t.prefs[id] ?? 0;
  const b = t.base.prefs[id];
  const back = () => (b === undefined ? t.removePref(id) : t.setPref(id, b));
  const dial = <Dial label={a.label} value={v} base={b} onChange={(x) => t.setPref(id, x)} onGrab={() => onGrab?.(id)} onRelease={onRelease} />;
  const remove = !CORE.includes(id) && <button type="button" aria-label={`Remove ${a.label}`} onClick={() => t.removePref(id)} className="-mr-1 grid size-6 shrink-0 place-items-center text-muted-foreground/70 hover:text-foreground"><X className="size-3.5" /></button>;
  const flash = t.fresh === id && "r2-flash";
  if (dense)
    return (
      <div data-row data-held={held || undefined} className={cn("grid h-9 grid-cols-[minmax(0,116px)_1fr_auto] items-center gap-1.5 rounded-lg", flash)}>
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold"><ChangeDot on={b !== v} onClick={back} /><span className="truncate" title={a.label}>{a.short === "New" ? "Never ridden" : a.short}</span></span>
        {dial}
        <span className="flex items-center"><span className="w-8 text-right text-[11.5px] font-bold tabular-nums" style={{ color: tone(v) }}>{signed(v)}</span>{remove || <i className="w-5" />}</span>
      </div>
    );
  return (
    <div data-row data-held={held || undefined} className={cn("rounded-xl px-1 pb-0.5 pt-1", flash)}>
      <div className="flex h-5 items-center gap-1.5">
        <ChangeDot on={b !== v} onClick={back} />
        <span className="min-w-0 truncate text-[13.5px] font-semibold">{a.label}</span>
        {b === undefined && <span className="shrink-0 rounded-full bg-[var(--hot)]/12 px-1.5 text-[10px] font-bold leading-4 text-[var(--hot)]">added</span>}
        <span className="ml-auto shrink-0 whitespace-nowrap text-[12px] font-semibold" style={{ color: tone(v) }}>{word(a, v)}</span>
        <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{signed(v)}</span>
        {remove}
      </div>
      {dial}
    </div>
  );
}

/** One hard limit: a lock, not a slider. It excludes ways, and may carry a number. */
export function LimitRow({ t, id }: { t: Tuner; id: string }) {
  const def = limitDef(id);
  const v = t.limits[id];
  const b = t.base.limits[id];
  const on = v !== undefined;
  const p = def.param;
  const step = (d: number) => p && typeof v === "number" && t.setLimit(id, Math.max(p.min, Math.min(p.max, v + d * p.step)));
  return (
    <div data-row className={cn("flex h-10 items-center gap-2 rounded-lg px-1", t.fresh === id && "r2-flash")}>
      <ChangeDot on={b !== v} onClick={() => t.setLimit(id, b ?? null)} />
      <Lock className={cn("size-3.5 shrink-0", on ? "text-[var(--hot)]" : "text-muted-foreground/50")} />
      <span className={cn("min-w-0 flex-1 truncate text-[13.5px] font-semibold", !on && "text-muted-foreground line-through")}>{def.label}</span>
      {p && typeof v === "number" && (
        <span className="flex h-7 shrink-0 items-center rounded-full bg-foreground/8 text-[12.5px] font-bold tabular-nums">
          <button type="button" aria-label="Lower" onClick={() => step(-1)} className="grid size-7 place-items-center"><Minus className="size-3" /></button>
          <span className="min-w-9 text-center">{p.fmt(v)}</span>
          <button type="button" aria-label="Higher" onClick={() => step(1)} className="grid size-7 place-items-center"><Plus className="size-3" /></button>
        </span>
      )}
      <button type="button" role="switch" aria-checked={on} aria-label={def.label} onClick={() => t.setLimit(id, on ? null : (b ?? p?.start ?? true))} className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors", on ? "bg-[var(--hot)]" : "bg-foreground/15")}>
        <i className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
      </button>
    </div>
  );
}

export function AddButton({ t, className, children = "Add a preference" }: { t: Tuner; className?: string; children?: ReactNode }) {
  return (
    <button type="button" onClick={() => t.setPicker(true)} className={cn("flex h-10 w-full items-center gap-2 rounded-xl border border-dashed border-foreground/30 px-3 text-[13px] font-semibold hover:border-foreground/60", className)}>
      <Plus className="size-4" />{children}
      <span className="ml-auto text-[11.5px] font-medium text-muted-foreground">{ATTRS.length + LIMITS.length} to pick from</span>
    </button>
  );
}

export function ScaleHint() {
  return <div className="flex justify-between px-[11px] text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80"><span style={{ color: "var(--less)" }}>← avoid</span><span>no opinion</span><span style={{ color: "var(--more)" }}>seek →</span></div>;
}

/** The whole editor list: sliders, the add button, limits. */
export function Editor({ t, dense, held, onGrab, onRelease, hideAdd }: { t: Tuner; dense?: boolean; held?: string | null; onGrab?: (id: string) => void; onRelease?: () => void; hideAdd?: boolean }) {
  return (
    <div>
      <div data-fade className={dense ? "grid grid-cols-[minmax(0,116px)_1fr_auto] gap-1.5" : undefined}>{dense && <i />}<ScaleHint />{dense && <i className="w-[52px]" />}</div>
      <div className={dense ? "" : "space-y-0.5"}>{t.prefIds.map((id) => <PrefRow key={id} t={t} id={id} dense={dense} held={held === id} onGrab={onGrab} onRelease={onRelease} />)}</div>
      {!hideAdd && <div data-fade className="mt-2"><AddButton t={t} /></div>}
      <div data-fade className="mt-3">
        <div className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground"><Lock className="size-3" />Limits · never broken</div>
        {t.limitIds.map((id) => <LimitRow key={id} t={t} id={id} />)}
        {t.limitIds.length === 0 && <p className="py-1.5 text-[12px] text-muted-foreground">None. Add one from the picker.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ base profile, diff, preset

export function BaseChooser({ t, className }: { t: Tuner; className?: string }) {
  return (
    <div className={cn("no-scrollbar flex gap-1.5 overflow-x-auto", className)}>
      {t.bases.map((b) => (
        <button type="button" key={b.id} title={b.blurb} onClick={() => t.setBase(b.id)} className={cn("flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-[12.5px] font-semibold", b.id === t.base.id ? "border-foreground bg-foreground text-background" : "border-border")}>
          {b.own && <Bookmark className="size-3" />}{b.name}
        </button>
      ))}
      <Soon>Learn from my rides</Soon>
    </div>
  );
}

/** "Gravel explorer · 3 changes", the same in words, reset and save as preset. */
/** With `pick`, the name opens the base profile chooser (for narrow screens, where the pills cost a row). */
export function DiffBar({ t, words = true, pick }: { t: Tuner; words?: boolean; pick?: boolean }) {
  const [choosing, setChoosing] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const n = t.changes.length;
  const save = () => {
    t.savePreset(name.trim() || `${t.base.name} +`);
    setNaming(false);
    setName("");
  };
  return (
    <div className="rounded-2xl bg-foreground/[0.055] p-2.5 pl-3">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13.5px]">
          {pick ? <button type="button" aria-expanded={choosing} onClick={() => setChoosing(!choosing)} className="flex min-w-0 items-center gap-0.5 font-bold"><span className="truncate">{t.base.name}</span><ChevronDown className={cn("size-4 shrink-0 transition-transform", choosing && "rotate-180")} /></button> : <span className="truncate font-bold">{t.base.name}</span>}
          <span className={cn("shrink-0 whitespace-nowrap font-semibold", n ? "text-[var(--hot)]" : "text-muted-foreground")}>· {n === 0 ? "untouched" : `${n} change${n > 1 ? "s" : ""}`}</span>
        </div>
        {n > 0 && !naming && (
          <>
            <button type="button" onClick={t.reset} title="Back to the base profile" className="flex h-7 shrink-0 items-center gap-1 rounded-full px-1.5 text-[12px] font-semibold text-muted-foreground hover:text-foreground"><RotateCcw className="size-3.5" /></button>
            <button type="button" onClick={() => setNaming(true)} className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-foreground px-2.5 text-[12px] font-semibold text-background"><Bookmark className="size-3" />Save<span className="max-[420px]:hidden"> as preset</span></button>
          </>
        )}
      </div>
      {pick && choosing && <div className="mt-2" onClickCapture={() => setChoosing(false)}><BaseChooser t={t} /></div>}
      {words && <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{n ? t.summary : t.base.blurb}</p>}
      {naming && (
        <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {/* biome-ignore lint/a11y/noAutofocus: the field appears because the user asked for it */}
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`${t.base.name} +`} aria-label="Preset name" className="h-8 min-w-0 flex-1 rounded-full border border-border bg-background px-3 text-[13px] font-semibold outline-none focus:border-foreground" />
          <button type="submit" className="h-8 rounded-full bg-[var(--hot)] px-3 text-[12px] font-bold text-white">Save</button>
          <button type="button" onClick={() => setNaming(false)} className="h-8 px-1.5 text-[12px] font-semibold text-muted-foreground">Cancel</button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ picker

type PickerMode = "list" | "chips" | "grid";
interface Item { kind: "pref" | "limit"; id: string; group: GroupId; label: string; short: string; hint: string; coverage?: number; has: boolean }

/** The catalogue: every attribute the region data offers, to search or browse, and add. */
export function Picker({ t, mode, className }: { t: Tuner; mode: PickerMode; className?: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<GroupId | null>(null);
  const [sel, setSel] = useState<string | null>(mode === "chips" ? "water" : null);
  const all: Item[] = [
    ...ATTRS.map((a) => ({ kind: "pref" as const, id: a.id, group: a.group, label: a.label, short: a.short === "New" ? "Never ridden" : a.short, hint: a.hint, coverage: a.coverage, has: a.id in t.prefs })),
    ...LIMITS.map((l) => ({ kind: "limit" as const, id: l.id, group: l.group, label: l.label, short: l.label, hint: l.hint, has: l.id in t.limits })),
  ];
  const needle = q.trim().toLowerCase();
  const hit = (i: Item) => !needle || `${i.label} ${i.hint} ${GROUPS.find((g) => g.id === i.group)?.label}`.toLowerCase().includes(needle);
  const add = (i: Item) => !i.has && (i.kind === "pref" ? t.addPref(i.id) : t.addLimit(i.id));
  const groups = GROUPS.map((g) => ({ ...g, items: all.filter((i) => i.group === g.id && hit(i)), total: all.filter((i) => i.group === g.id) })).filter((g) => g.items.length);
  const selItem = all.find((i) => i.id === sel);

  const row = (i: Item) => (
    <button type="button" key={i.id} disabled={i.has} onClick={() => add(i)} className={cn("flex w-full items-center gap-3 rounded-xl px-2 py-[7px] text-left hover:bg-foreground/6", i.has && "opacity-45")}>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
          {i.kind === "limit" && <Lock className="size-3 shrink-0 text-[var(--hot)]" />}<span className="truncate">{i.label}</span>
          {i.kind === "limit" && <span className="shrink-0 rounded-full bg-[var(--hot)]/12 px-1.5 text-[10px] font-bold leading-4 text-[var(--hot)]">limit</span>}
        </span>
        <span className="block truncate text-[12px] text-muted-foreground">{i.hint}{i.coverage ? ` Mapped on ${i.coverage} % of ways.` : ""}</span>
      </span>
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-full", i.has ? "text-muted-foreground" : "bg-foreground text-background")}>{i.has ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}</span>
    </button>
  );
  const heading = (g: (typeof groups)[number]) => {
    const Icon = GROUP_ICON[g.id];
    return <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-2.5 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground"><Icon className="size-3.5" />{g.label}<span className="font-medium normal-case tracking-normal opacity-70">· {g.blurb}</span></div>;
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 pb-2">
        {mode === "grid" && open && !needle ? <button type="button" aria-label="Back" onClick={() => setOpen(null)} className="grid size-7 place-items-center rounded-full bg-foreground/8"><ArrowLeft className="size-4" /></button> : null}
        <span className="text-[15px] font-extrabold tracking-tight">{mode === "grid" && open && !needle ? GROUPS.find((g) => g.id === open)?.label : "Add a preference"}</span>
        <button type="button" aria-label="Close" onClick={() => t.setPicker(false)} className="ml-auto grid size-7 place-items-center rounded-full bg-foreground/8"><X className="size-4" /></button>
      </div>
      <label className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-background/70 px-3.5">
        <Search className="size-4 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: forest, cobbles, traffic, never ridden…" aria-label="Search preferences" className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium outline-none" />
        {q && <button type="button" aria-label="Clear" onClick={() => setQ("")}><X className="size-3.5 text-muted-foreground" /></button>}
      </label>

      <div className="thin-scroll -mx-1 mt-1 min-h-0 flex-1 overflow-y-auto px-1">
        {groups.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">Nothing in the data matches “{q}”.</p>}
        {mode === "list" && groups.map((g) => <div key={g.id}>{heading(g)}{g.items.map(row)}</div>)}
        {mode === "chips" && groups.map((g) => (
          <div key={g.id}>
            {heading(g)}
            <div className="flex flex-wrap gap-1.5 px-1 pb-1 pt-1">
              {g.items.map((i) => (
                <button type="button" key={i.id} disabled={i.has} title={i.hint} onClick={() => (sel === i.id ? add(i) : setSel(i.id))} className={cn("flex h-8 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-semibold", i.has ? "border-transparent bg-foreground/6 text-muted-foreground" : sel === i.id ? "border-foreground bg-foreground text-background" : "border-border")}>
                  {i.kind === "limit" && <Lock className="size-3 text-[var(--hot)]" />}{i.short}{i.has && <Check className="size-3" />}
                </button>
              ))}
            </div>
          </div>
        ))}
        {mode === "grid" && (needle || open ? (
          groups.filter((g) => needle || g.id === open).map((g) => <div key={g.id}>{needle ? heading(g) : <p className="px-2 pb-1 pt-2 text-[12px] text-muted-foreground">{g.blurb}</p>}{g.items.map(row)}</div>)
        ) : (
          <div className="grid grid-cols-2 gap-2 pt-2">
            {groups.map((g) => {
              const Icon = GROUP_ICON[g.id];
              const used = g.total.filter((i) => i.has).length;
              return (
                <button type="button" key={g.id} onClick={() => setOpen(g.id)} className="rounded-2xl border border-border bg-background/50 p-3 text-left hover:border-foreground/40">
                  <span className="flex items-center justify-between"><Icon className="size-[18px]" /><span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{used ? `${used} in use · ` : ""}{g.total.length}</span></span>
                  <span className="mt-2 block text-[13.5px] font-bold">{g.label}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">{g.blurb}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {mode === "chips" && selItem && !selItem.has && (
        <div className="mt-2 flex shrink-0 items-center gap-2.5 rounded-2xl bg-foreground/[0.055] p-2 pl-3">
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold">{selItem.label}</span><span className="block truncate text-[12px] text-muted-foreground">{selItem.hint}</span></span>
          <button type="button" onClick={() => add(selItem)} className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-foreground px-3 text-[12.5px] font-bold text-background"><Plus className="size-3.5" />Add</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ route: numbers, timeline, stops

export function deltas(a: RouteData, ref: RouteData): string[] {
  const out: string[] = [];
  const d = (v: number, unit: string, min: number, f: (n: number) => string = (n) => n.toFixed(1)) => Math.abs(v) >= min && out.push(`${v > 0 ? "+" : "−"}${f(Math.abs(v))}${unit}`);
  d(a.km - ref.km, " km", 0.1);
  d(a.climb - ref.climb, " m", 5, (n) => String(Math.round(n)));
  d(a.minutes - ref.minutes, " min", 1, (n) => String(Math.round(n)));
  return out;
}
export function moreDeltas(a: RouteData, ref: RouteData): string[] {
  const out: string[] = [];
  const d = (v: number, what: string) => Math.abs(v) >= 0.3 && out.push(`${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} km ${what}`);
  d(unpavedKm(a) - unpavedKm(ref), "gravel");
  d((a.road.main ?? 0) - (ref.road.main ?? 0), "main road");
  d(a.newKm - ref.newKm, "new to you");
  return out;
}

/** Distance, climb, time; with what the tweaks did to them against the base profile's route. */
export function Stats({ t, size = "lg", className }: { t: Tuner; size?: "lg" | "sm"; className?: string }) {
  const r = t.route;
  const ds = t.moved && !t.compareRoute ? deltas(r, t.baseRoute) : [];
  return (
    <div className={cn("flex items-baseline gap-x-3", className)}>
      {[[fmtKm(r.km), "km"], [String(r.climb), "m ↑"], [fmtTime(r.minutes), "h"]].map(([v, u], i) => (
        <div key={u} className="whitespace-nowrap leading-none">
          <span className={cn("font-bold tracking-tight tabular-nums", size === "lg" ? "text-[24px]" : "text-[17px]")}>{v}</span>
          <span className={cn("ml-0.5 text-muted-foreground", size === "lg" ? "text-[12px]" : "text-[11px]")}>{u}</span>
          {ds[i] !== undefined && <span className="ml-1 text-[10.5px] font-bold tabular-nums text-[var(--hot)]">{(ds[i] as string).replace(/ (km|m|min)$/, "")}</span>}
        </div>
      ))}
    </div>
  );
}

/** Small chips: what the tweaks cost and bought against the base. */
export function DeltaChips({ t, className }: { t: Tuner; className?: string }) {
  if (!t.moved) return <span className={cn("block text-[11.5px] text-muted-foreground", className)}>{t.changes.length ? "Your changes do not move the route yet." : "Same route as the base profile."}</span>;
  return (
    <div className={cn("no-scrollbar flex items-center gap-1 overflow-x-auto text-[11px] font-bold tabular-nums", className)}>
      <span className="flex shrink-0 items-center gap-1 font-semibold text-muted-foreground"><svg width="16" height="4" aria-hidden="true"><line x1="0" y1="2" x2="16" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray="4 2.5" /></svg>vs base</span>
      {[...deltas(t.route, t.baseRoute), ...moreDeltas(t.route, t.baseRoute)].map((d) => <span key={d} className="shrink-0 rounded-full bg-foreground/8 px-1.5 py-0.5">{d}</span>)}
    </div>
  );
}

const LANES = [["surface", "Surface"], ["road", "Way"], ["novel", "New"]] as const;
/** Round 1's timeline (direction B), compact: elevation over lanes for surface, way type and never ridden. Drag across it to follow along on the map. */
export function Lanes({ t, height = 46, className }: { t: Tuner; height?: number; className?: string }) {
  const r = t.route;
  const max = Math.max(r.km, t.compareRoute?.km ?? 0);
  const [at, setAt] = useState<number | null>(null);
  const base = sections(t.baseRoute);
  const changed = t.compareRoute ? [] : sections(r).filter((s, k) => s.src !== base[k]?.src);
  const marks = t.waypoints.slice(1, -1).map((w, i) => ({ km: kmOf(r, w.lngLat), label: String(i + 1) }));
  const scrub = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    const km = Math.max(0, Math.min(r.km, ((e.clientX - b.left) / b.width) * max));
    setAt(km);
    t.setCursor(pointAtKm(r, km));
  };
  const leave = () => {
    setAt(null);
    t.setCursor(null);
  };
  const seg = at === null ? null : r.segs.find((s) => s.to >= at) ?? r.segs[r.segs.length - 1];
  const ele = at === null ? 0 : (r.profile.find((p) => p[0] >= at) ?? r.profile[r.profile.length - 1])?.[1];
  return (
    <div className={className}>
      <div className="grid grid-cols-[48px_1fr] items-center gap-x-1.5 gap-y-[3px] text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
        <span>Climb</span>
        <div className="relative touch-pan-y" onPointerMove={scrub} onPointerDown={scrub} onPointerLeave={leave}>
          <Elevation route={r} compare={t.compareRoute} color="var(--foreground)" compareColor="var(--cool)" height={height} grid={false} fillOpacity={0.07} marks={marks} className="normal-case tracking-normal text-foreground" />
          {at !== null && <i className="pointer-events-none absolute inset-y-0 w-px bg-[var(--hot)]" style={{ left: `${(at / max) * 100}%` }} />}
        </div>
        {LANES.map(([by, label]) => (
          <div key={by} className="contents"><span>{label}</span><SegStrip route={r} by={by} maxKm={max} className="h-[7px] rounded-[3px]" /></div>
        ))}
        {changed.length > 0 && (
          <div className="contents">
            <span className="text-[var(--hot)]">Moved</span>
            <div className="relative h-[5px]">{changed.map((s) => <i key={s.from} title="Differs from the base profile's route" className="absolute inset-y-0 rounded-full bg-[var(--hot)]" style={{ left: `${(s.from / max) * 100}%`, width: `${((s.to - s.from) / max) * 100}%` }} />)}</div>
          </div>
        )}
      </div>
      <div className="mt-1 h-4 truncate pl-[54px] text-[11px] tabular-nums text-muted-foreground">
        {at !== null && seg ? (
          <span><b className="text-foreground">{fmtKm(at)} km</b> · {ele} m · {SURFACES.find((s) => s.key === seg.surface)?.label} · {ROADS.find((x) => x.key === seg.road)?.label}{seg.novel ? " · new to you" : ""}</span>
        ) : (
          <span className="flex justify-between"><span>0</span><span>{changed.length ? "the marked stretches differ from the base" : "drag across to follow on the map"}</span><span>{fmtKm(max)} km</span></span>
        )}
      </div>
    </div>
  );
}

/** Both breakdowns as legends with shares: the lanes above are the bars. */
export function Shares({ route, className }: { route: RouteData; className?: string }) {
  const line = (defs: { key: string; label: string; color: string }[], vals: Record<string, number | undefined>) => (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
      {defs.filter((d) => (vals[d.key] ?? 0) / route.km >= 0.015).map((d) => <span key={d.key} className="inline-flex items-center gap-1 whitespace-nowrap"><i className="size-2 rounded-[2px]" style={{ background: d.color }} />{d.label} <b className="text-foreground tabular-nums">{pct(vals[d.key] ?? 0, route.km)}%</b></span>)}
    </div>
  );
  return (
    <div className={cn("space-y-1 text-[11px] text-muted-foreground", className)}>
      {line(SURFACES, route.surface)}
      {line(ROADS, route.road)}
      <div className="inline-flex items-center gap-1"><i className="size-2 rounded-[2px]" style={{ background: NOVEL_COLOR.novel }} />New to you <b className="text-foreground tabular-nums">{pct(route.newKm, route.km)}%</b><span className="opacity-70">· {fmtKm(route.newKm)} km</span></div>
    </div>
  );
}

export function Waypoints({ t }: { t: Tuner }) {
  const ROW = 36;
  const { drag, handle } = useReorder(ROW, t.moveWaypoint);
  const lg = legs(t.route, t.waypoints);
  return (
    <div>
      <ol>
        {t.waypoints.map((w, i) => {
          const end = i === 0 || i === t.waypoints.length - 1;
          return (
            <li key={w.id} className={cn("flex items-center gap-2.5 border-t border-border text-[13.5px]", drag?.index === i && "relative z-10 rounded-xl bg-muted")} style={{ height: ROW, transform: drag?.index === i ? `translateY(${drag.dy}px)` : undefined }}>
              <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[10.5px] font-bold", end ? "bg-foreground text-background" : "border-[1.5px] border-foreground")}>{i === 0 ? "A" : end ? "B" : i}</span>
              <span className="flex-1 truncate font-semibold">{w.name}</span>
              {lg[i] && <span className="text-[11.5px] tabular-nums text-muted-foreground">{fmtKm(lg[i].km)} km</span>}
              <button type="button" aria-label={`Remove ${w.name}`} onClick={() => t.removeWaypoint(w.id)} className="text-muted-foreground"><X className="size-4" /></button>
              <button type="button" aria-label={`Move ${w.name}`} className="text-muted-foreground" {...handle(i)}><GripVertical className="size-4" /></button>
            </li>
          );
        })}
      </ol>
      <div className="no-scrollbar -mx-1 mt-1.5 flex gap-1.5 overflow-x-auto px-1">
        <button type="button" onClick={t.addWaypoint} className="flex shrink-0 items-center gap-1 rounded-full bg-foreground px-3 py-1 text-[12px] font-semibold text-background"><Plus className="size-3.5" /> Stop</button>
        <Soon>Profile per leg</Soon><Soon>Through this area</Soon><Soon>Avoid this area</Soon><Soon>Draw it</Soon><Soon>Make it a loop</Soon>
      </div>
    </div>
  );
}

export function GpxButton({ compact }: { compact?: boolean }) {
  return <button type="button" aria-label="Export GPX" title="Export GPX" className={cn("flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-foreground text-[12.5px] font-semibold text-background", compact ? "w-8" : "px-3")}><Download className="size-3.5" />{!compact && "GPX"}</button>;
}

/** Everything about the route in one column. */
export function RoutePanel({ t, stats = true }: { t: Tuner; stats?: boolean }) {
  return (
    <div className="space-y-3">
      {stats && <div className="flex items-end justify-between gap-2"><Stats t={t} /><GpxButton compact={t.moved} /></div>}
      <Lanes t={t} />
      <Shares route={t.route} />
      <Waypoints t={t} />
    </div>
  );
}

// ------------------------------------------------------------------ compare

/** The comparison in words, the way the agent would put it. `b` is the alternative. */
export function tradeoff(a: RouteData, b: RouteData): { first: string; second: ReactNode } {
  const dKm = b.km - a.km;
  const dMin = b.minutes - a.minutes;
  const dClimb = b.climb - a.climb;
  const dUnp = unpavedKm(b) - unpavedKm(a);
  const main = b.road.main ?? 0;
  const dMain = main - (a.road.main ?? 0);
  const first = `is ${fmtKm(Math.abs(dKm))} km ${dKm >= 0 ? "longer" : "shorter"} ${dKm >= 0 === dMin >= 0 ? "and" : "but"} ${Math.abs(dMin)} min ${dMin >= 0 ? "slower" : "faster"}, with ${Math.abs(dClimb)} m ${dClimb >= 0 ? "more" : "less"} climbing.`;
  const second = (
    <>
      It {dUnp < 0 ? "gives up" : "adds"} {fmtKm(Math.abs(dUnp))} km of gravel
      {dMain > 0.3 ? <> and <b>puts you on main roads for {fmtKm(main)} km</b></> : dMain < -0.3 ? <> and <b>takes {fmtKm(-dMain)} km off main roads</b></> : null}; {fmtKm(b.newKm)} km of it would be new to you.
    </>
  );
  return { first, second };
}

/** Pick a second profile, see both routes and the trade-off. */
export function Compare({ t, table = true }: { t: Tuner; table?: boolean }) {
  const others = t.bases.filter((b) => b.id !== t.base.id);
  const rows = t.compareRoute ? compareRows(t.route, t.compareRoute) : [];
  const words = t.compareRoute ? tradeoff(t.route, t.compareRoute) : null;
  return (
    <div>
      <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto text-[12px]">
        <span className="shrink-0 font-semibold text-muted-foreground">Compare with</span>
        {others.map((o) => (
          <button type="button" key={o.id} onClick={() => t.setCompare(t.compare?.id === o.id ? null : o.id)} className={cn("shrink-0 rounded-full border px-2.5 py-1 font-semibold", t.compare?.id === o.id ? "border-transparent bg-[var(--cool)] text-white dark:text-black" : "border-border")}>{o.name}</button>
        ))}
      </div>
      {t.compare && words && (
        <div className="mt-2 rounded-2xl border border-[var(--cool)]/40 bg-[var(--cool)]/8 p-3">
          <p className="text-[13px] leading-snug"><b style={{ color: "var(--cool)" }}>{t.compare.name}</b> {words.first} {words.second}</p>
          {table && (
            <div className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-1.5 text-[11.5px]">
              {rows.map((x) => (
                <div key={x.label}>
                  <div className="text-muted-foreground">{x.label}</div>
                  <div className="whitespace-nowrap font-semibold tabular-nums"><span style={{ color: "var(--hot)" }}>{x.a.replace(/ (km|m)$/, "")}</span> <span className="text-muted-foreground">→</span> <span style={{ color: "var(--cool)" }}>{x.b}</span></div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex gap-1.5">
            <button type="button" onClick={() => t.setBase(t.compare?.id ?? "")} className="flex h-7 items-center gap-1 rounded-full bg-foreground px-3 text-[12px] font-semibold text-background"><Check className="size-3.5" />Ride it this way</button>
            <button type="button" onClick={() => t.setCompare(null)} className="h-7 rounded-full px-2 text-[12px] font-semibold text-muted-foreground">Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ map layers, rides

const TRAIL = ["#3f9b6c", "#c9c23f", "#f08a3c", "#d6423a"];
export const DEBUG: { key: DebugAttr; label: string; hint: string; items: { label: string; color: string }[] }[] = [
  ...LEGENDS.filter((l) => l.key !== "cost").map((l) => ({ key: l.key as DebugAttr, label: l.key === "road" ? "Way type" : l.label, hint: l.hint, items: l.items })),
  { key: "trail", label: "Trail difficulty", hint: "MTB scale where mapped; grey means nobody rated it.", items: [...["S0", "S1", "S2", "S3+"].map((l, i) => ({ label: l, color: TRAIL[i] as string })), { label: "Not rated", color: "#b9b4aa" }] },
  ...LEGENDS.filter((l) => l.key === "cost").map((l) => ({ key: "cost" as const, label: "Cost in this profile", hint: "What your sliders and limits make of every way. Tune and watch it change.", items: l.items })),
];
/** MapLibre colour for the attribute map. The cost view reads the live profile. */
export function debugColor(t: Tuner): unknown {
  if (t.dbg === "trail")
    return ["case", ["has", "mtb_scale"], ["match", ["slice", ["to-string", ["get", "mtb_scale"]], 0, 1], "0", TRAIL[0], "1", TRAIL[1], "2", TRAIL[2], TRAIL[3]], ["match", ["get", "class"], ["track", "path"], true, false], "#b9b4aa", "rgba(150,150,150,0.25)"];
  const zero = { gravel: 0, bikepath: 0, quiet: 0, forest: 0, edge: 0, water: 0, climb: 0, novelty: 0 };
  const fake = { soft: { ...zero, gravel: t.prefs.unpaved ?? 0, quiet: (t.prefs.quiet ?? 0) - (t.prefs.main ?? 0) * 0.5, bikepath: t.prefs.cycleway_sep ?? 0 }, hard: { noMain: "noMain" in t.limits, pavedOnly: "pavedOnly" in t.limits, noUnknown: "noUnknown" in t.limits, maxGrade: false, noStairs: false } } as Profile;
  return attrColor(t.dbg, fake);
}
export const debugKey = (t: Tuner) => (t.dbg === "cost" ? `cost:${t.prefs.unpaved}:${t.prefs.quiet}:${t.prefs.main}:${t.prefs.cycleway_sep}:${Object.keys(t.limits)}` : t.dbg);

const RIDES = [
  { name: "Sunday ridge loop", when: "3 days ago", km: 62, fresh: 18 },
  { name: "After-work gravel", when: "last week", km: 34, fresh: 4 },
  { name: "Lake and back", when: "2 weeks ago", km: 48, fresh: 0 },
  { name: "Rain check", when: "3 weeks ago", km: 27, fresh: 9 },
];
const MODES = [["normal", "Map"], ["debug", "Attributes"], ["explored", "Explored"]] as const;

/** Map views (normal, attribute map, explored map) and the rides behind the explored map. */
export function LayersPanel({ t }: { t: Tuner }) {
  const legend = DEBUG.find((d) => d.key === t.dbg) ?? DEBUG[0];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 rounded-full bg-foreground/8 p-1 text-[12.5px] font-semibold">
        {MODES.map(([key, label]) => <button type="button" key={key} onClick={() => t.setLayer(key)} className={cn("rounded-full py-1.5", t.layer === key && "bg-background shadow-sm")}>{label}</button>)}
      </div>
      {t.layer === "normal" && <p className="text-[12px] leading-snug text-muted-foreground">The route is coloured by surface; the notes on the map say why it went this way. The dashed line is the base profile's route, while your tweaks differ from it.</p>}
      {t.layer === "debug" && legend && (
        <>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {DEBUG.map((d) => <button type="button" key={d.key} onClick={() => t.setDbg(d.key)} className={cn("rounded-full border px-2.5 py-1 font-semibold", d.key === t.dbg ? "border-foreground bg-foreground text-background" : "border-border")}>{d.label}</button>)}
            <Soon><Search className="size-3" />{ATTRS.length - 4} more from the catalogue</Soon>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">{legend.items.map((it) => <span key={it.label} className="inline-flex items-center gap-1.5"><i className="h-1.5 w-4 rounded-full" style={{ background: it.color }} />{it.label}</span>)}</div>
          <p className="text-[11.5px] leading-snug text-muted-foreground">{legend.hint}</p>
        </>
      )}
      {t.layer === "explored" && (
        <div className="space-y-1 text-[12px]">
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 rounded-full bg-gradient-to-r from-[#5bbfae] to-[#0b6b5d]" />Ridden, stronger the more often</div>
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 rounded-full bg-[#c98a1b]" />Never ridden</div>
        </div>
      )}
      <div className="border-t border-border pt-3">
        <div className="mb-1.5 flex items-baseline justify-between text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground"><span>My rides</span><span className="font-medium normal-case tracking-normal">214 rides · 38 % of the area ridden</span></div>
        <ImportDrop imports={t.imports} onImport={t.addImport} className="rounded-2xl" />
        <ul className="mt-1.5">
          {RIDES.map((r) => (
            <li key={r.name} className="flex h-8 items-center gap-2 border-t border-border text-[12.5px] first:border-0">
              <span className="min-w-0 flex-1 truncate font-semibold">{r.name}</span>
              <span className="tabular-nums text-muted-foreground">{r.km} km</span>
              <span className={cn("w-[74px] text-right tabular-nums", r.fresh ? "font-semibold" : "text-muted-foreground")} style={r.fresh ? { color: NOVEL_COLOR.novel } : undefined}>{r.fresh ? `${r.fresh} km new` : "nothing new"}</span>
              <span className="w-[76px] text-right text-[11.5px] text-muted-foreground">{r.when}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ agent

/** The agent's place. Not wired up: it will edit the same sliders, and say so in the same words as the diff. */
export function AgentBar({ className, hint = "40 km loop north-west, quiet gravel…" }: { className?: string; hint?: string }) {
  return (
    <div className={cn("flex h-11 items-center gap-2 rounded-full pl-3.5 pr-1.5", glass, className)} title="Later: the agent edits the same profile">
      <Sparkles className="size-4 shrink-0" style={{ color: "var(--hot)" }} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">{hint}</span>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">later</span>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background"><ArrowUp className="size-4" /></span>
    </div>
  );
}

/** Clears the "just added" flash after it played. */
export function useFlashScroll(fresh: string | null) {
  useEffect(() => {
    if (!fresh) return;
    document.querySelector(".r2-flash")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [fresh]);
}
