import { Bike, Compass, Download, GripVertical, Layers, Map as MapIcon, Minus, Moon, Plus, Sun, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HARD, type Profile, ROUTES, type RouteData, SOFT, type SoftKey, compareRows, fmtKm, fmtTime, legs, pct } from "@/mock/data";
import { LEGENDS } from "@/shared/attrs";
import { MapView, STYLES } from "@/shared/MapView";
import { type LayerMode, type Planner, type View, useIsDesktop, usePlanner, useReorder, useTheme } from "@/shared/usePlanner";
import { Breakdown, Elevation, ImportDrop, Mark, SegStrip, Soon } from "@/shared/viz";

/**
 * D · Rose. Compare first: every profile is a candidate route, always on the map, and you pick a line.
 * A profile is a shape on a compass rose; two profiles are two shapes. Phone: tab bar. Desktop: three columns.
 */
const Cap = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn("text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground", className)}>{children}</div>
);

function Candidate({ pr, p, className }: { pr: Profile; p: Planner; className?: string }) {
  const r = ROUTES[pr.routeId] as RouteData;
  const on = pr.id === p.active.id;
  return (
    <button type="button" onClick={() => p.setActive(pr.id)} className={cn("relative shrink-0 snap-center overflow-hidden rounded-xl border bg-card p-3 pl-4 text-left transition-shadow", on ? "border-foreground shadow-lg" : "border-border", className)}>
      <i className="absolute inset-y-0 left-0 w-1.5" style={{ background: pr.color }} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[15px] font-bold leading-tight">{pr.name}</span>
        {on ? <span className="rounded-full px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white" style={{ background: pr.color }}>chosen</span> : <span className="text-[10.5px] text-muted-foreground">tap to choose</span>}
      </div>
      <div className="mt-1 flex items-baseline gap-2.5 tabular-nums">
        <span className="text-[19px] font-bold leading-none">{fmtKm(r.km)}<small className="ml-0.5 text-[11px] font-medium text-muted-foreground">km</small></span>
        <span className="text-[19px] font-bold leading-none">{r.climb}<small className="ml-0.5 text-[11px] font-medium text-muted-foreground">m</small></span>
        <span className="text-[19px] font-bold leading-none">{fmtTime(r.minutes)}<small className="ml-0.5 text-[11px] font-medium text-muted-foreground">h</small></span>
      </div>
      <Elevation route={r} color={pr.color} height={34} grid={false} className="mt-1.5 [&>span]:hidden" />
      <SegStrip route={r} by="surface" className="h-1.5 rounded-full" />
      <div className="mt-1.5 flex justify-between gap-2 whitespace-nowrap text-[11px] text-muted-foreground">
        <span><b className="text-foreground">{pct(r.km - (r.surface.paved ?? 0), r.km)}%</b> unpaved</span>
        <span><b className="text-foreground">{fmtKm(r.road.main ?? 0)} km</b> main rd</span>
        <span><b className="text-foreground">{pct(r.newKm, r.km)}%</b> new</span>
      </div>
    </button>
  );
}

function Waypoints({ p }: { p: Planner }) {
  const ROW = 38;
  const { drag, handle } = useReorder(ROW, p.moveWaypoint);
  const lg = legs(p.route, p.waypoints);
  return (
    <div>
      <ol>
        {p.waypoints.map((w, i) => {
          const end = i === 0 || i === p.waypoints.length - 1;
          return (
            <li key={w.id} className={cn("flex items-center gap-2.5 border-b border-border text-[14px]", drag?.index === i && "relative z-10 rounded-lg bg-muted")} style={{ height: ROW, transform: drag?.index === i ? `translateY(${drag.dy}px)` : undefined }}>
              <button type="button" aria-label={`Move ${w.name}`} className="text-muted-foreground" {...handle(i)}><GripVertical className="size-4" /></button>
              <span className={cn("grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] font-bold", end ? "bg-primary text-primary-foreground" : "border-2 border-foreground")}>{i === 0 ? "A" : end ? "B" : i}</span>
              <span className="flex-1 truncate font-semibold">{w.name}</span>
              {lg[i] && <span className="text-[11.5px] tabular-nums text-muted-foreground">{fmtKm(lg[i].km)} km</span>}
              <button type="button" aria-label={`Remove ${w.name}`} onClick={() => p.removeWaypoint(w.id)} className="text-muted-foreground"><X className="size-4" /></button>
            </li>
          );
        })}
      </ol>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button size="sm" onClick={p.addWaypoint} className="h-7 rounded-full"><Plus /> Waypoint</Button>
        <Soon>Via-zone</Soon><Soon>Avoid-zone</Soon><Soon>Sketch</Soon><Soon>Loop</Soon><Soon>Per-leg profile</Soon>
      </div>
    </div>
  );
}

/** The profile as a shape. Centre avoids, the dashed ring is neutral, the rim seeks. Drag a point. */
function Rose({ p, sel, setSel, size = 320 }: { p: Planner; sel: SoftKey; setSel: (k: SoftKey) => void; size?: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const C = 160;
  const R = 104;
  const R0 = 16;
  const rad = (v: number) => R0 + ((v + 100) / 200) * (R - R0);
  const dir = (i: number) => {
    const a = (i / SOFT.length) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(a), Math.sin(a)] as const;
  };
  const pt = (i: number, v: number) => {
    const [dx, dy] = dir(i);
    return [C + dx * rad(v), C + dy * rad(v)] as const;
  };
  const shape = (pr: Profile) => SOFT.map((s, i) => pt(i, pr.soft[s.key]).map((n) => n.toFixed(1)).join(",")).join(" ");
  const drag = (i: number, key: SoftKey) => (e: React.PointerEvent) => {
    e.preventDefault();
    setSel(key);
    const move = (ev: PointerEvent) => {
      const box = svg.current?.getBoundingClientRect();
      if (!box) return;
      const k = 320 / box.width;
      const [dx, dy] = dir(i);
      const along = ((ev.clientX - box.left) * k - C) * dx + ((ev.clientY - box.top) * k - C) * dy;
      const v = Math.round((((along - R0) / (R - R0)) * 200 - 100) / 10) * 10;
      p.setSoft(p.active.id, key, Math.max(-100, Math.min(100, v)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <svg ref={svg} viewBox="0 0 320 320" width={size} height={size} className="mx-auto block max-w-full touch-none select-none" role="img" aria-label="Preference rose">
      {Array.from({ length: 72 }, (_, t) => t).map((t) => (
        <line key={t} x1={C} y1={C - R - 9} x2={C} y2={C - R - (t % 9 === 0 ? 17 : 12)} stroke="currentColor" strokeOpacity={t % 9 === 0 ? 0.55 : 0.22} transform={`rotate(${t * 5} ${C} ${C})`} />
      ))}
      <circle cx={C} cy={C} r={R + 9} fill="none" stroke="currentColor" strokeOpacity="0.3" />
      <circle cx={C} cy={C} r={R} fill="var(--card)" stroke="currentColor" strokeOpacity="0.18" />
      <circle cx={C} cy={C} r={rad(50)} fill="none" stroke="currentColor" strokeOpacity="0.08" />
      <circle cx={C} cy={C} r={rad(-50)} fill="none" stroke="currentColor" strokeOpacity="0.08" />
      <circle cx={C} cy={C} r={rad(0)} fill="none" stroke="currentColor" strokeOpacity="0.45" strokeDasharray="3 3" />
      {SOFT.map((s, i) => {
        const [dx, dy] = dir(i);
        return <line key={s.key} x1={C + dx * R0} y1={C + dy * R0} x2={C + dx * R} y2={C + dy * R} stroke="currentColor" strokeOpacity={s.key === sel ? 0.6 : 0.15} />;
      })}
      {p.compare && <polygon points={shape(p.compare)} fill={p.compare.color} fillOpacity="0.1" stroke={p.compare.color} strokeWidth="2" strokeDasharray="5 3" strokeLinejoin="round" />}
      <polygon points={shape(p.active)} fill={p.active.color} fillOpacity="0.22" stroke={p.active.color} strokeWidth="2.5" strokeLinejoin="round" />
      {SOFT.map((s, i) => {
        const [x, y] = pt(i, p.active.soft[s.key]);
        const [dx, dy] = dir(i);
        const lx = C + dx * (R + 30);
        const ly = C + dy * (R + 27);
        return (
          <g key={s.key}>
            <circle cx={x} cy={y} r={s.key === sel ? 8 : 6} fill="var(--card)" stroke={p.active.color} strokeWidth="2.5" />
            <circle cx={x} cy={y} r={18} fill="transparent" style={{ cursor: "grab" }} onPointerDown={drag(i, s.key)} />
            <text x={lx} y={ly} textAnchor={Math.abs(dx) < 0.3 ? "middle" : dx > 0 ? "start" : "end"} dominantBaseline="middle" fontSize="12.5" fontWeight={s.key === sel ? 700 : 500} fill="currentColor" fillOpacity={s.key === sel ? 1 : 0.75} onClick={() => setSel(s.key)} style={{ cursor: "pointer" }} dx={Math.abs(dx) < 0.3 ? 0 : dx > 0 ? -12 : 12}>
              {s.short}
            </text>
          </g>
        );
      })}
      <path d={`M${C} ${C - 9}L${C + 4} ${C}L${C} ${C + 9}L${C - 4} ${C}Z`} fill="var(--brass)" />
    </svg>
  );
}

function Tune({ p, roseSize }: { p: Planner; roseSize?: number }) {
  const [sel, setSel] = useState<SoftKey>("gravel");
  const def = SOFT.find((s) => s.key === sel) ?? SOFT[0];
  const v = p.active.soft[sel];
  const bv = p.compare?.soft[sel];
  const others = p.profiles.filter((x) => x.id !== p.active.id);
  const select = "h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2 text-[13px] font-semibold";
  return (
    <div className="space-y-3.5">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <i className="size-2.5 shrink-0 rounded-full" style={{ background: p.active.color }} />
        <select aria-label="Profile to tune" value={p.active.id} onChange={(e) => p.setActive(e.target.value)} className={select}>{p.profiles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <span>vs.</span>
        <i className="size-2.5 shrink-0 rounded-full border-2 border-dashed" style={{ borderColor: p.compare?.color ?? "var(--border)" }} />
        <select aria-label="Profile to compare with" value={p.compare?.id ?? ""} onChange={(e) => p.setCompare(e.target.value || null)} className={select}><option value="">nothing</option>{others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      </div>
      <div className="text-foreground"><Rose p={p} sel={sel} setSel={setSel} size={roseSize} /></div>
      {def && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-2 pl-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-bold">{def.label}</div>
            <div className="text-[11.5px] text-muted-foreground">
              {v === 0 ? "neutral" : v > 0 ? `${def.hi} +${v}` : `${def.lo} −${-v}`}
              {bv !== undefined && <span style={{ color: p.compare?.color }}> · {p.compare?.name.split(" ")[0]} {bv > 0 ? `+${bv}` : bv}</span>}
            </div>
          </div>
          <Button size="icon" variant="outline" aria-label="Less" onClick={() => p.setSoft(p.active.id, sel, Math.max(-100, v - 10))} className="size-8 rounded-full bg-transparent"><Minus /></Button>
          <Button size="icon" variant="outline" aria-label="More" onClick={() => p.setSoft(p.active.id, sel, Math.min(100, v + 10))} className="size-8 rounded-full bg-transparent"><Plus /></Button>
        </div>
      )}
      <div>
        <Cap className="mb-1.5">Bounds · hard limits</Cap>
        <div className="flex flex-wrap gap-1.5">
          {HARD.map((h) => (
            <button type="button" key={h.key} aria-pressed={p.active.hard[h.key]} onClick={() => p.toggleHard(p.active.id, h.key)} className={cn("rounded-full border px-2.5 py-1 text-[12px] font-semibold", p.active.hard[h.key] ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground")}>{h.short}</button>
          ))}
        </div>
      </div>
      {p.compare && p.compareRoute && (
        <div>
          <Cap className="mb-1">What the shapes do to the route</Cap>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[12.5px]">
            {compareRows(p.route, p.compareRoute).map((r) => (
              <div key={r.label} className="contents">
                <span className="border-b border-border py-1 text-muted-foreground">{r.label}</span>
                <b className="border-b border-border py-1 text-right tabular-nums" style={{ color: p.active.color }}>{r.a}</b>
                <b className="border-b border-border py-1 text-right tabular-nums" style={{ color: p.compare?.color }}>{r.b}</b>
                <span className="border-b border-border py-1 text-right text-[11.5px] tabular-nums text-muted-foreground">{r.deltaText}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5"><Soon>Learn the shape from my rides</Soon><Soon>Tell the agent</Soon></div>
    </div>
  );
}

const MODES: { key: LayerMode; label: string }[] = [{ key: "normal", label: "Chart" }, { key: "debug", label: "Attributes" }, { key: "explored", label: "Explored" }];
function LayersPanel({ p }: { p: Planner }) {
  const legend = LEGENDS.find((l) => l.key === p.attr) ?? LEGENDS[0];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-border p-1 text-[12.5px] font-semibold">
        {MODES.map((m) => <button type="button" key={m.key} onClick={() => p.setLayer(m.key)} className={cn("rounded-lg py-1.5", p.layer === m.key && "bg-primary text-primary-foreground")}>{m.label}</button>)}
      </div>
      {p.layer === "debug" && legend && (
        <>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {LEGENDS.map((l) => <button type="button" key={l.key} onClick={() => p.setAttr(l.key)} className={cn("rounded-full border px-2.5 py-1 font-semibold", l.key === p.attr ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{l.label}</button>)}
            <Soon>Gradient</Soon><Soon>Forest edge</Soon>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">{legend.items.map((it) => <span key={it.label} className="inline-flex items-center gap-1.5"><i className="h-1.5 w-4 rounded-full" style={{ background: it.color }} />{it.label}</span>)}</div>
          <p className="text-[11.5px] text-muted-foreground">{legend.hint}</p>
        </>
      )}
      {p.layer === "explored" && (
        <div className="space-y-1 text-[12px]">
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 rounded-full bg-gradient-to-r from-[#5bbfae] to-[#0b6b5d]" />Ridden, stronger the more often</div>
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 rounded-full bg-[#c98a1b]" />Never ridden · 62 % of this window</div>
        </div>
      )}
      <div><Cap className="mb-1.5">Ride history</Cap><ImportDrop imports={p.imports} onImport={p.addImport} /></div>
    </div>
  );
}

export function DirectionD() {
  const { theme, toggleTheme } = useTheme();
  const p = usePlanner();
  const desktop = useIsDesktop();
  const tuning = p.view === "profile";
  // plan: every candidate is on the map. tune: the tuned one and its comparison.
  const shown = p.profiles.filter((x) => x.id !== p.active.id && (tuning ? x.id === p.compare?.id : true));
  const routes = [
    { id: p.active.id, route: p.route, color: p.active.color, width: 5.5 },
    ...shown.map((x) => ({ id: x.id, route: ROUTES[x.routeId] as RouteData, color: x.color, width: 3, opacity: 0.85 })),
  ];
  const mapEl = (pad: { top: number; bottom: number; left: number; right: number }) => (
    <MapView theme={theme} styles={{ light: STYLES.bright, dark: STYLES.fiord }} forest={{ dark: "#1f3d3a" }} routes={routes} waypoints={p.waypoints} layer={p.layer} attr={p.attr} profile={p.active} padding={pad} className="absolute inset-0" />
  );
  const brand = (
    <div className="flex items-center gap-2">
      <Mark size={24} accent="var(--brass)" />
      <span className="text-[19px] font-extrabold leading-none tracking-tight">Kompass</span>
    </div>
  );
  const themeBtn = <button type="button" onClick={toggleTheme} aria-label="Toggle theme" className="grid size-8 place-items-center rounded-full border border-border bg-card">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>;

  if (desktop)
    return (
      <div className="dir-d flex h-full bg-background text-foreground">
        <aside className="thin-scroll flex w-[320px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-card p-5">
          <div className="flex items-center justify-between">{brand}{themeBtn}</div>
          <div>
            <Cap>Kirchzarten → Titisee</Cap>
            <h1 className="mt-0.5 text-[24px] font-extrabold leading-tight tracking-tight">Ridge to the lake</h1>
          </div>
          <Waypoints p={p} />
          <div><Cap className="mb-2">Chosen route · way types</Cap><Breakdown route={p.route} by="road" /></div>
          <div><Cap className="mb-2">Chart</Cap><LayersPanel p={p} /></div>
          <div className="mt-auto flex gap-1.5"><Button className="h-9 flex-1 rounded-full"><Download /> Export GPX</Button><Soon className="px-3"><Bike className="size-3.5" /> Ride</Soon></div>
        </aside>
        <main className="relative min-w-0 flex-1">
          {mapEl({ top: 50, bottom: 230, left: 50, right: 50 })}
          <div className="absolute inset-x-3 bottom-3">
            <div className="mb-1.5 inline-block rounded-full bg-card/90 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground backdrop-blur">Three ways there · one per profile</div>
            <div className="grid grid-cols-3 gap-2.5">{p.profiles.map((pr) => <Candidate key={pr.id} pr={pr} p={p} />)}</div>
          </div>
        </main>
        <aside className="thin-scroll w-[380px] shrink-0 overflow-y-auto border-l border-border bg-background p-5">
          <h2 className="mb-3 text-[19px] font-extrabold tracking-tight">Tune the profile</h2>
          <Tune p={p} />
        </aside>
      </div>
    );

  const TABS: { key: View; label: string; icon: React.ReactNode }[] = [
    { key: "plan", label: "Plan", icon: <MapIcon className="size-5" /> },
    { key: "profile", label: "Tune", icon: <Compass className="size-5" /> },
    { key: "layers", label: "Chart", icon: <Layers className="size-5" /> },
  ];
  return (
    <div className="dir-d flex h-full flex-col bg-background text-foreground">
      <div className={cn("relative shrink-0 transition-[height]", tuning ? "h-[24%]" : "h-[38%]")}>
        {mapEl({ top: 54, bottom: 22, left: 30, right: 30 })}
        <div className="absolute inset-x-3 top-3 flex items-center justify-between">
          <div className="rounded-full border border-border bg-card py-1.5 pl-2 pr-3 shadow-sm">{brand}</div>
          {themeBtn}
        </div>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-border">
        {p.view === "plan" && (
          <div className="py-3">
            <div className="flex items-baseline justify-between px-4"><Cap>Three ways there · swipe</Cap><span className="text-[11px] text-muted-foreground">all on the map</span></div>
            <div className="no-scrollbar mt-2 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-1">{p.profiles.map((pr) => <Candidate key={pr.id} pr={pr} p={p} className="w-[292px]" />)}</div>
            <div className="mt-3 px-4"><Cap className="mb-0.5">Waypoints</Cap><Waypoints p={p} /></div>
          </div>
        )}
        {p.view === "profile" && <div className="p-4"><Tune p={p} roseSize={300} /></div>}
        {p.view === "layers" && <div className="p-4"><LayersPanel p={p} /></div>}
      </div>
      <nav className="grid shrink-0 grid-cols-5 border-t border-border bg-card pb-1.5 pt-1.5 text-[10.5px] font-semibold">
        {TABS.map((t) => (
          <button type="button" key={t.key} onClick={() => p.setView(t.key)} className={cn("flex flex-col items-center gap-0.5", p.view === t.key ? "text-foreground" : "text-muted-foreground")}>
            <span className={cn("grid h-7 w-12 place-items-center rounded-full", p.view === t.key && "bg-primary text-primary-foreground")}>{t.icon}</span>{t.label}
          </button>
        ))}
        <span className="flex flex-col items-center gap-0.5 text-muted-foreground opacity-50" title="Later"><span className="grid h-7 w-12 place-items-center"><Bike className="size-5" /></span>Ride · later</span>
        <span className="flex flex-col items-center gap-0.5 text-muted-foreground"><span className="grid h-7 w-12 place-items-center"><Download className="size-5" /></span>GPX</span>
      </nav>
    </div>
  );
}
