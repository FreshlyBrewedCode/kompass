import { ArrowLeftRight, GripVertical, Moon, Plus, Sun, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { HARD, ROADS, type RouteData, SOFT, SURFACES, compareRows, fmtKm, fmtTime, legs, pct } from "@/mock/data";
import { LEGENDS } from "@/shared/attrs";
import { Bipolar } from "@/shared/Bipolar";
import { MapView, STYLES } from "@/shared/MapView";
import { type LayerMode, type Planner, type Theme, type View, useIsDesktop, usePlanner, useReorder, useTheme } from "@/shared/usePlanner";
import { Elevation, ImportDrop, Mark, SegStrip } from "@/shared/viz";

/**
 * B · Mixer. The profile is a mixing desk: one fader per preference, two decks to A/B routes.
 * The route is a timeline with lanes. Phone: fixed split, map above, console below. Desktop: console docked at the bottom.
 */
const LAMP = { light: ["#d9480f", "#0b7285"], dark: ["#ffb020", "#3bc9db"] } as const;

const Eng = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("cond text-[11px] font-semibold leading-none text-muted-foreground", className)}>{children}</span>
);
/** A latching hardware key with a lamp. */
function Key({ on, lamp = "var(--lamp-a)", onClick, children, className, disabled }: { on?: boolean; lamp?: string; onClick?: () => void; children: React.ReactNode; className?: string; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={on} className={cn("cond relative flex h-9 items-center justify-center gap-1.5 rounded-[3px] border border-border bg-card px-2.5 text-[12px] font-semibold leading-none shadow-[inset_0_-2px_0_rgb(0_0_0/0.18),0_1px_0_rgb(255_255_255/0.06)] transition-transform active:translate-y-px disabled:border-dashed disabled:opacity-45 disabled:shadow-none", className)}>
      <i className="size-1.5 shrink-0 rounded-full" style={{ background: on ? lamp : "var(--muted)", boxShadow: on ? `0 0 6px ${lamp}` : "none" }} />
      {children}
    </button>
  );
}

function Lcd({ p }: { p: Planner }) {
  const cells = (r: RouteData) => [["DIST", `${fmtKm(r.km)} km`], ["CLIMB", `${r.climb} m`], ["TIME", fmtTime(r.minutes)], ["UNPAVED", `${pct(r.km - (r.surface.paved ?? 0), r.km)} %`], ["NEW", `${pct(r.newKm, r.km)} %`]];
  const a = cells(p.route);
  const b = p.compareRoute ? cells(p.compareRoute) : null;
  return (
    <div className="rounded-[3px] bg-[var(--lcd)] px-3 py-2 font-mono text-[var(--lcd-fg)] shadow-[inset_0_2px_6px_rgb(0_0_0/0.6)]">
      <div className="grid grid-cols-[14px_repeat(5,1fr)] items-baseline gap-x-2">
        <span />
        {a.map(([k]) => <span key={k} className="cond text-[10px] opacity-60">{k}</span>)}
        <span className="text-[11px] font-semibold" style={{ color: "var(--lamp-a)" }}>A</span>
        {a.map(([k, v]) => <span key={k} className="whitespace-nowrap text-[14px] font-medium leading-5 tabular-nums">{v}</span>)}
        {b && <span className="text-[11px] font-semibold text-[#3bc9db]">B</span>}
        {b?.map(([k, v]) => <span key={k} className="whitespace-nowrap text-[13px] leading-5 tabular-nums opacity-75">{v}</span>)}
      </div>
    </div>
  );
}

/** The route as a timeline: elevation on top, one lane per attribute below. */
function Timeline({ p }: { p: Planner }) {
  const lg = legs(p.route, p.waypoints);
  const marks = p.waypoints.slice(1, -1).map((_, i) => ({ km: lg[i]?.to ?? 0, label: String(i + 1) }));
  const lanes = [["SURF", "surface"], ["WAY", "road"], ["NEW", "novel"]] as const;
  return (
    <div className="rounded-[3px] bg-[var(--well)] p-2 shadow-[inset_0_1px_4px_rgb(0_0_0/0.35)]">
      <div className="pl-9"><Elevation route={p.route} compare={p.compareRoute} color="var(--lamp-a)" compareColor="var(--lamp-b)" height={62} marks={marks} fillOpacity={0.22} /></div>
      {lanes.map(([label, by]) => (
        <div key={by} className="mt-1 flex items-center">
          <Eng className="w-9 text-[10px]">{label}</Eng>
          <SegStrip route={p.route} by={by} className="h-2.5 flex-1 rounded-[1px]" />
        </div>
      ))}
      <div className="mt-1 flex flex-wrap gap-x-2.5 pl-9 text-[9.5px] leading-4 text-muted-foreground">
        {SURFACES.map((s) => <span key={s.key} className="inline-flex items-center gap-1"><i className="size-1.5" style={{ background: s.color }} />{s.label.split(" ")[0]}</span>)}
        <span className="inline-flex items-center gap-1"><i className="size-1.5 bg-[#c2409a]" />never ridden</span>
      </div>
      <div className="mt-1.5 flex items-stretch pl-9">
        {lg.map((l, i) => (
          <div key={`${l.from}-${i}`} className="mr-px flex min-w-0 flex-col justify-center border border-dashed border-foreground/30 px-1.5 py-1" style={{ width: `${(l.km / p.route.km) * 100}%` }} title="Later: a profile per leg">
            <span className="cond truncate text-[10px] font-semibold leading-none">LEG {i + 1} · {fmtKm(l.km)} km</span>
            <span className="cond mt-0.5 truncate text-[9.5px] leading-none text-muted-foreground">= deck A</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Waypoints({ p }: { p: Planner }) {
  const ROW = 34;
  const { drag, handle } = useReorder(ROW, p.moveWaypoint);
  return (
    <div>
      <ol className="border-t border-border">
        {p.waypoints.map((w, i) => {
          const end = i === 0 || i === p.waypoints.length - 1;
          return (
            <li key={w.id} className={cn("flex items-center gap-2 border-b border-border text-[12.5px]", drag?.index === i && "relative z-10 bg-muted")} style={{ height: ROW, transform: drag?.index === i ? `translateY(${drag.dy}px)` : undefined }}>
              <button type="button" aria-label={`Move ${w.name}`} className="text-muted-foreground" {...handle(i)}><GripVertical className="size-3.5" /></button>
              <span className={cn("grid size-[18px] place-items-center rounded-[3px] text-[10px] font-semibold", end ? "bg-[var(--lamp-a)] text-black" : "bg-foreground text-background")}>{i === 0 ? "A" : end ? "B" : i}</span>
              <span className="flex-1 truncate font-medium">{w.name}</span>
              <button type="button" aria-label={`Remove ${w.name}`} onClick={() => p.removeWaypoint(w.id)} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Key on onClick={p.addWaypoint} className="h-8"><Plus className="size-3.5" />Waypoint</Key>
        {["Via zone", "Avoid zone", "Sketch", "Loop"].map((k) => <Key key={k} disabled className="h-8">{k}</Key>)}
      </div>
    </div>
  );
}

function useDecks(p: Planner, deckB: string, setDeckB: (id: string) => void) {
  const b = p.profiles.find((x) => x.id === deckB);
  const swap = () => {
    const old = p.active.id;
    p.setActive(deckB);
    setDeckB(old);
    if (p.compare) p.setCompare(old);
  };
  return { b, swap, others: p.profiles.filter((x) => x.id !== p.active.id) };
}
interface DeckProps { p: Planner; deckB: string; setDeckB: (id: string) => void }

function Decks({ p, deckB, setDeckB }: DeckProps) {
  const { b, swap } = useDecks(p, deckB, setDeckB);
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-1.5">
      <div className="rounded-[3px] border-2 px-2.5 py-1.5" style={{ borderColor: "var(--lamp-a)" }}>
        <Eng className="text-[10px]">Deck A · on the faders</Eng>
        <div className="cond mt-1 truncate text-[16px] font-semibold leading-none" style={{ color: "var(--lamp-a)" }}>{p.active.name}</div>
      </div>
      <button type="button" onClick={swap} title="Swap decks" className="grid w-9 place-items-center rounded-[3px] border border-border bg-card"><ArrowLeftRight className="size-4" /></button>
      <button type="button" onClick={() => p.setCompare(p.compare ? null : deckB)} className={cn("rounded-[3px] border-2 px-2.5 py-1.5 text-left", !p.compare && "border-dashed opacity-70")} style={{ borderColor: p.compare ? "var(--lamp-b)" : "var(--border)" }}>
        <Eng className="text-[10px]">Deck B · {p.compare ? "on the map" : "muted, tap to show"}</Eng>
        <div className="cond mt-1 truncate text-[16px] font-semibold leading-none" style={{ color: "var(--lamp-b)" }}>{b?.name}</div>
      </button>
    </div>
  );
}

function Faders({ p, deckB, setDeckB }: DeckProps) {
  const { b } = useDecks(p, deckB, setDeckB);
  return (
    <div className="rounded-[3px] bg-[var(--well)] px-1 pb-2 pt-2.5 shadow-[inset_0_1px_4px_rgb(0_0_0/0.35)]">
      <div className="grid grid-cols-8">
        {SOFT.map((s) => {
          const v = p.active.soft[s.key];
          const bv = b?.soft[s.key] ?? 0;
          return (
            <div key={s.key} className="flex flex-col items-center">
              <span className={cn("text-[11px] font-medium leading-none tabular-nums", v === 0 && "text-muted-foreground")}>{v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0"}</span>
              <div className="relative my-1.5 h-40 w-full">
                <div className="absolute inset-y-2 left-1/2 flex w-7 -translate-x-1/2 flex-col justify-between">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((t) => <i key={t} className={cn("h-px bg-foreground/25", t % 4 === 0 ? "w-full" : "mx-auto w-3")} />)}
                </div>
                <i title={`Deck B: ${bv}`} className="absolute left-1/2 z-10 h-[3px] w-5 -translate-x-1/2 rounded-full" style={{ background: "var(--lamp-b)", top: `calc(8px + ${(100 - bv) / 200} * (100% - 16px) - 1px)`, marginLeft: 13 }} />
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 [--thumb-border:var(--lamp-a)] [--thumb:var(--card)] [--track:color-mix(in_oklab,var(--foreground)_22%,transparent)] [&_[data-slot=slider-thumb]]:!h-3.5 [&_[data-slot=slider-thumb]]:!w-7 [&_[data-slot=slider-thumb]]:!rounded-[2px]">
                  <Bipolar vertical label={s.label} value={v} onChange={(n) => p.setSoft(p.active.id, s.key, n)} color="var(--lamp-a)" />
                </div>
              </div>
              <Eng className="text-center text-[10.5px] text-foreground">{s.short}</Eng>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between px-2"><Eng className="text-[9.5px]">▲ seek · centre neutral · ▼ avoid · <span style={{ color: "var(--lamp-b)" }}>▬</span> deck B</Eng><Eng className="text-[9.5px]">rerouted {p.rerouteMs} ms</Eng></div>
    </div>
  );
}

function Cuts({ p, stack }: { p: Planner; stack?: boolean }) {
  return (
    <div>
      <Eng>Cuts · edges removed</Eng>
      <div className={cn("mt-1.5 gap-1.5", stack ? "grid" : "flex flex-wrap")}>
        {HARD.map((h) => <Key key={h.key} on={p.active.hard[h.key]} lamp="#e03131" onClick={() => p.toggleHard(p.active.id, h.key)} className={cn("h-8", stack && "justify-start")}>{h.short}</Key>)}
      </div>
    </div>
  );
}

function Presets({ p, deckB, setDeckB }: DeckProps) {
  const { others } = useDecks(p, deckB, setDeckB);
  return (
    <div>
      <Eng>Presets · load to deck B</Eng>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {others.map((o) => <Key key={o.id} on={o.id === deckB} lamp="var(--lamp-b)" onClick={() => { setDeckB(o.id); p.setCompare(o.id); }} className="h-8">{o.name}</Key>)}
        <Key disabled className="h-8">Learn from rides</Key>
      </div>
    </div>
  );
}

function Diff({ p }: { p: Planner }) {
  if (!p.compareRoute) return null;
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[11.5px]">
      {compareRows(p.route, p.compareRoute).map((r) => (
        <div key={r.label} className="contents">
          <Eng className="border-b border-border py-1.5 text-[11px]">{r.label}</Eng>
          <span className="border-b border-border py-1 text-right tabular-nums" style={{ color: "var(--lamp-a)" }}>{r.a}</span>
          <span className="border-b border-border py-1 text-right tabular-nums" style={{ color: "var(--lamp-b)" }}>{r.b}</span>
          <span className="border-b border-border py-1 text-right tabular-nums text-muted-foreground">{r.deltaText}</span>
        </div>
      ))}
    </div>
  );
}

const MODES: { key: LayerMode; label: string }[] = [{ key: "normal", label: "Map" }, { key: "debug", label: "Attr" }, { key: "explored", label: "Explored" }];
const ModeKeys = ({ p, className }: { p: Planner; className?: string }) => (
  <div className={cn("flex gap-1", className)}>{MODES.map((m) => <Key key={m.key} on={p.layer === m.key} onClick={() => p.setLayer(m.key)} className="h-8 flex-1">{m.label}</Key>)}</div>
);

function MapDesk({ p, bare }: { p: Planner; bare?: boolean }) {
  const legend = LEGENDS.find((l) => l.key === p.attr) ?? LEGENDS[0];
  return (
    <div className="space-y-3">
      {!bare && <ModeKeys p={p} />}
      {p.layer === "debug" && legend && (
        <div>
          <Eng>Colour every edge by</Eng>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {LEGENDS.map((l) => <Key key={l.key} on={l.key === p.attr} onClick={() => p.setAttr(l.key)} className="h-8 justify-start">{l.label}</Key>)}
            <Key disabled className="h-8 justify-start">Gradient</Key><Key disabled className="h-8 justify-start">Forest edge</Key>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {legend.items.map((it) => <span key={it.label} className="inline-flex items-center gap-1.5"><i className="h-1.5 w-4" style={{ background: it.color }} />{it.label}</span>)}
          </div>
        </div>
      )}
      {p.layer === "explored" && (
        <div className="space-y-1 text-[11.5px]">
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 bg-gradient-to-r from-[#5bbfae] to-[#0b6b5d]" />ridden (brighter = more often)</div>
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 bg-[#d9a441]" />never ridden · 62 % of this window</div>
        </div>
      )}
      {p.layer === "normal" && <p className="text-[11.5px] leading-relaxed text-muted-foreground">ATTR colours every edge by one attribute. EXPLORED shows what you have ridden and what you have not.</p>}
      <div>
        <Eng>Tape in · ride history</Eng>
        <ImportDrop imports={p.imports} onImport={p.addImport} className="mt-1.5 rounded-[3px]" />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
        {SURFACES.map((s) => <span key={s.key} className="inline-flex items-center gap-1"><i className="size-2" style={{ background: s.color }} />{s.label}</span>)}
        {ROADS.map((s) => <span key={s.key} className="inline-flex items-center gap-1"><i className="size-2" style={{ background: s.color }} />{s.label}</span>)}
      </div>
    </div>
  );
}

const Prompt = () => (
  <div className="flex items-center gap-2 rounded-[3px] bg-[var(--lcd)] px-3 py-1.5 font-mono text-[12px] text-[var(--lcd-fg)]" title="Later: the agent moves the same faders">
    <span className="opacity-60">agent&gt;</span>
    <span className="truncate">40 km loop north-west, quiet gravel<span className="animate-pulse">▍</span></span>
    <span className="cond ml-auto shrink-0 text-[10px] opacity-60">later · moves these faders</span>
  </div>
);

function mapRoutes(p: Planner, theme: Theme) {
  return [
    { id: p.active.id, route: p.route, color: LAMP[theme][0] },
    ...(p.compareRoute && p.compare ? [{ id: p.compare.id, route: p.compareRoute, color: LAMP[theme][1], width: 4 }] : []),
  ];
}
const Brand = ({ theme, toggleTheme }: { theme: Theme; toggleTheme: () => void }) => (
  <div className="flex items-center gap-2 rounded-[3px] border border-border bg-card px-2 py-1.5 shadow-md">
    <Mark size={18} accent="var(--lamp-a)" />
    <span className="cond text-[15px] font-semibold leading-none tracking-[0.22em]">Kompass</span>
    <button type="button" onClick={toggleTheme} aria-label="Toggle theme" className="ml-1 text-muted-foreground">{theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}</button>
  </div>
);

export function DirectionB() {
  const { theme, toggleTheme } = useTheme();
  const p = usePlanner();
  const desktop = useIsDesktop();
  const [deckB, setDeckB] = useState("paved");
  const decks = { p, deckB, setDeckB };
  const mapEl = (pad: number) => (
    <MapView theme={theme} styles={{ light: STYLES.positron, dark: STYLES.dark }} forest={{ light: "#cfdcc4", dark: "#1a2b20" }} routes={mapRoutes(p, theme)} waypoints={p.waypoints} layer={p.layer} attr={p.attr} profile={p.active} padding={{ top: pad + 14, bottom: pad, left: pad, right: pad }} className="absolute inset-0" />
  );
  const panel = "border-border bg-background";

  if (desktop)
    return (
      <div className="dir-b flex h-full flex-col bg-background text-foreground">
        <div className="relative min-h-0 flex-1">
          {mapEl(56)}
          <div className="absolute left-3 top-3"><Brand theme={theme} toggleTheme={toggleTheme} /></div>
          <div className="absolute right-3 top-3 flex items-center gap-1.5">
            <Key disabled className="h-8 bg-card">Ride mode</Key>
            <Key on className="h-8">Export GPX</Key>
          </div>
        </div>
        <div className={cn("shrink-0 border-t-2 px-4 pb-3 pt-3 shadow-[0_-10px_30px_rgb(0_0_0/0.25)]", panel)}>
          <div className="mb-3 grid grid-cols-[370px_1fr_300px] items-center gap-x-4">
            <div className="flex items-center gap-2"><Eng className="text-[12px] text-foreground">Ridge to the lake</Eng><Eng>· 3 legs · 4 waypoints</Eng></div>
            <Prompt />
            <ModeKeys p={p} />
          </div>
          <div className="grid grid-cols-[370px_230px_1fr_130px_300px] gap-x-4">
            <div className="space-y-2.5"><Timeline p={p} /><Presets {...decks} /></div>
            <Waypoints p={p} />
            <div className="space-y-2"><Decks {...decks} /><Faders {...decks} /></div>
            <Cuts p={p} stack />
            <div className="thin-scroll max-h-[318px] space-y-3 overflow-y-auto">
              <Lcd p={p} />
              {p.layer !== "normal" && <MapDesk p={p} bare />}
              <Diff p={p} />
              {p.layer === "normal" && <div><Eng>Tape in · ride history</Eng><ImportDrop imports={p.imports} onImport={p.addImport} className="mt-1.5 rounded-[3px] py-2" /></div>}
            </div>
          </div>
        </div>
      </div>
    );

  const TABS: { key: View; label: string }[] = [{ key: "plan", label: "Route" }, { key: "profile", label: "Mix" }, { key: "layers", label: "Map" }];
  return (
    <div className="dir-b flex h-full flex-col bg-background text-foreground">
      <div className="relative h-[37%] shrink-0">
        {mapEl(30)}
        <div className="absolute left-2 top-2"><Brand theme={theme} toggleTheme={toggleTheme} /></div>
        <div className="absolute right-2 top-2 flex gap-1"><Key disabled className="h-8 bg-card">Ride</Key><Key on className="h-8">GPX</Key></div>
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col border-t-2", panel)}>
        <div className="shrink-0 space-y-2 px-3 pt-2.5">
          <Lcd p={p} />
          <div className="grid grid-cols-3 gap-1.5">
            {TABS.map((t) => <Key key={t.key} on={p.view === t.key} onClick={() => p.setView(t.key)}>{t.label}</Key>)}
          </div>
        </div>
        <div className="thin-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-3 pt-2.5">
          {p.view === "plan" && <><Timeline p={p} /><Waypoints p={p} /><Prompt /></>}
          {p.view === "profile" && <><Decks {...decks} /><Faders {...decks} /><Cuts p={p} /><Presets {...decks} /><Diff p={p} /></>}
          {p.view === "layers" && <MapDesk p={p} />}
        </div>
      </div>
    </div>
  );
}
