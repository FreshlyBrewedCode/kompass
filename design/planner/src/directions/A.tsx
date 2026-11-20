import { Ban, Bike, CircleDashed, Download, Eye, EyeOff, GripVertical, Layers, Map as MapIcon, MessageSquareText, Moon, PenLine, Plus, Repeat, Route, Sun, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { HARD, ROUTES, type RouteData, SOFT, SURFACES, compareRows, fmtKm, fmtTime, legs, pct } from "@/mock/data";
import { LEGENDS } from "@/shared/attrs";
import { Bipolar } from "@/shared/Bipolar";
import { MapView, STYLES } from "@/shared/MapView";
import { type LayerMode, type Planner, type View, useIsDesktop, usePlanner, useReorder, useTheme } from "@/shared/usePlanner";
import { Breakdown, Elevation, ImportDrop, Mark, SegStrip, Soon } from "@/shared/viz";

/**
 * A · Field sheet. The map is a printed sheet, the planner a card you pull up over it.
 * Phone: bottom sheet with three detents. Desktop: route on the left, profile on the right.
 */
const Label = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h3 className={cn("text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground", className)}>{children}</h3>
);

function Stats({ route }: { route: RouteData }) {
  const items = [
    [fmtKm(route.km), "km"],
    [route.climb.toLocaleString("en").replace(",", " "), "m up"],
    [fmtTime(route.minutes), "h"],
    [fmtKm(route.newKm), "km new"],
  ];
  return (
    <div className="grid grid-cols-4 divide-x divide-border">
      {items.map(([v, u]) => (
        <div key={u} className="px-3 first:pl-0">
          <div className="display text-[26px] font-medium leading-none tracking-tight tabular-nums">{v}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">{u}</div>
        </div>
      ))}
    </div>
  );
}

function RoutePanel({ p }: { p: Planner }) {
  const ROW = 46;
  const { drag, handle } = useReorder(ROW, p.moveWaypoint);
  const lg = legs(p.route, p.waypoints);
  const marks = p.waypoints.slice(1, -1).map((w, i) => ({ km: lg[i]?.to ?? 0, label: String(i + 1), id: w.id }));
  return (
    <div className="space-y-4">
      <Stats route={p.route} />
      <div>
        <Elevation route={p.route} compare={p.compareRoute} color="var(--route)" compareColor="var(--route-2)" height={76} marks={marks} />
        <SegStrip route={p.route} by="surface" maxKm={Math.max(p.route.km, p.compareRoute?.km ?? 0)} className="mt-1 h-1.5 rounded-full" />
        <div className="mt-1.5 flex gap-3 text-[11px] text-muted-foreground">
          {SURFACES.map((s) => <span key={s.key} className="inline-flex items-center gap-1"><i className="size-2 rounded-[2px]" style={{ background: s.color }} />{s.label.split(" ")[0]} <b className="font-semibold text-foreground">{pct(p.route.surface[s.key] ?? 0, p.route.km)}%</b></span>)}
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label>Waypoints</Label>
          <span className="text-[11px] text-muted-foreground">drag to reorder</span>
        </div>
        <ol>
          {p.waypoints.map((w, i) => {
            const end = i === 0 || i === p.waypoints.length - 1;
            return (
              <li key={w.id} className={cn("relative flex items-center gap-2 border-b border-border/70", drag?.index === i && "z-10 rounded-md bg-muted shadow-md")} style={{ height: ROW, transform: drag?.index === i ? `translateY(${drag.dy}px)` : undefined }}>
                <button type="button" aria-label={`Move ${w.name}`} className="-ml-1 p-1 text-muted-foreground" {...handle(i)}><GripVertical className="size-4" /></button>
                <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold", end ? "bg-[var(--route)] text-white dark:text-background" : "bg-foreground text-background")}>{i === 0 ? "A" : end ? "B" : i}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium leading-tight">{w.name}</span>
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground">{w.note}</span>
                </span>
                {lg[i] && <span className="text-[11px] tabular-nums text-muted-foreground">{fmtKm(lg[i].km)} km ↓</span>}
                <button type="button" aria-label={`Remove ${w.name}`} onClick={() => p.removeWaypoint(w.id)} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
              </li>
            );
          })}
        </ol>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={p.addWaypoint} className="h-7 rounded-full bg-transparent"><Plus /> Waypoint</Button>
          <Soon><CircleDashed className="size-3" /> Via-zone</Soon>
          <Soon><Ban className="size-3" /> Avoid-zone</Soon>
          <Soon><PenLine className="size-3" /> Sketch</Soon>
          <Soon><Repeat className="size-3" /> Loop</Soon>
          <Soon><Route className="size-3" /> Profile per leg</Soon>
        </div>
      </div>
      <div className="grid gap-3">
        <div><Label className="mb-1.5">Surface</Label><Breakdown route={p.route} by="surface" /></div>
        <div><Label className="mb-1.5">Way type</Label><Breakdown route={p.route} by="road" /></div>
      </div>
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-foreground/25 px-3 py-2 text-[12.5px] text-muted-foreground">
        <MessageSquareText className="size-4 shrink-0" />
        <span className="truncate italic">“40 km loop north-west, quiet gravel”</span>
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider">agent · later</span>
      </div>
    </div>
  );
}

function ProfilePanel({ p }: { p: Planner }) {
  const rows = p.compareRoute ? compareRows(p.route, p.compareRoute) : [];
  return (
    <div className="space-y-4">
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {p.profiles.map((pr) => {
          const r = ROUTES[pr.routeId] as RouteData;
          const on = pr.id === p.active.id;
          const cmp = pr.id === p.compare?.id;
          return (
            <div key={pr.id} className={cn("relative w-[150px] shrink-0 rounded-lg border bg-card p-2.5 transition-colors", on ? "border-foreground shadow-[3px_3px_0_0_var(--foreground)]" : "border-border")}>
              <button type="button" onClick={() => p.setActive(pr.id)} className="block w-full text-left">
                <span className="mb-1.5 block h-1 w-8 rounded-full" style={{ background: on ? "var(--route)" : cmp ? "var(--route-2)" : "var(--border)" }} />
                <span className="display block text-[15px] font-medium leading-tight">{pr.name}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{pr.blurb}</span>
                <span className="mt-1.5 block text-[11px] tabular-nums">{fmtKm(r.km)} km · {r.climb} m</span>
              </button>
              {on ? <span className="mt-2 block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--route)]">Routing with this</span> : (
                <button type="button" onClick={() => p.setCompare(cmp ? null : pr.id)} aria-pressed={cmp} className={cn("mt-1.5 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium", cmp ? "bg-[var(--route-2)] text-white dark:text-background" : "bg-muted text-muted-foreground")}>
                  {cmp ? <Eye className="size-3" /> : <EyeOff className="size-3" />} {cmp ? "comparing" : "compare"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {p.compare && (
        <div className="rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-3 px-3 py-2 text-[12px]">
            <span />
            <span className="flex items-center gap-1 text-[11px] font-semibold"><i className="h-0.5 w-4 bg-[var(--route)]" />{p.active.name.split(" ")[0]}</span>
            <span className="flex items-center gap-1 text-[11px] font-semibold"><i className="h-0 w-4 border-t-2 border-dashed border-[var(--route-2)]" />{p.compare.name.split(" ")[0]}</span>
            <span />
            {rows.map((r) => (
              <div key={r.label} className="contents">
                <span className="border-t border-border/60 py-1 text-muted-foreground">{r.label}</span>
                <span className="border-t border-border/60 py-1 text-right font-medium tabular-nums">{r.a}</span>
                <span className="border-t border-border/60 py-1 text-right tabular-nums">{r.b}</span>
                <span className="border-t border-border/60 py-1 text-right text-[11px] tabular-nums text-muted-foreground">{r.deltaText}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <Label>Hard limits · edges removed</Label>
        </div>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-1">
          {HARD.map((h) => (
            <label key={h.key} className="flex items-center justify-between border-b border-border/60 py-1.5 text-[13px]">
              {h.label}
              <Switch checked={p.active.hard[h.key]} onCheckedChange={() => p.toggleHard(p.active.id, h.key)} />
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <Label>Preferences · edges weighed</Label>
          <span className="text-[11px] tabular-nums text-muted-foreground">rerouted in {p.rerouteMs} ms</span>
        </div>
        <div className="space-y-2.5">
          {SOFT.map((s) => {
            const v = p.active.soft[s.key];
            return (
              <div key={s.key}>
                <div className="flex items-baseline justify-between text-[13px]">
                  <span>{s.label}</span>
                  <span className={cn("display text-[13px] tabular-nums", v === 0 && "text-muted-foreground")}>{v > 0 ? `+${v}` : v === 0 ? "neutral" : `−${-v}`}</span>
                </div>
                <Bipolar label={s.label} value={v} onChange={(n) => p.setSoft(p.active.id, s.key, n)} color="var(--primary)" />
                <div className="-mt-0.5 flex justify-between text-[10px] text-muted-foreground"><span>{s.lo}</span><span>{s.hi}</span></div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 pb-2">
        <Button size="sm" variant="outline" className="h-7 rounded-full bg-transparent">Save as preset</Button>
        <Soon>Learn from my rides</Soon>
        <Soon>Edit with the agent</Soon>
      </div>
    </div>
  );
}

const MODES: { key: LayerMode; label: string; desc: string }[] = [
  { key: "normal", label: "Map", desc: "Just the route" },
  { key: "debug", label: "Attributes", desc: "Colour every edge" },
  { key: "explored", label: "Explored", desc: "Ridden vs. never" },
];

function LayersPanel({ p }: { p: Planner }) {
  const legend = LEGENDS.find((l) => l.key === p.attr) ?? LEGENDS[0];
  return (
    <div className="space-y-4">
      <ToggleGroup value={[p.layer]} onValueChange={(v) => v[0] && p.setLayer(v[0] as LayerMode)} className="grid w-full grid-cols-3 gap-0 overflow-hidden rounded-lg border border-border">
        {MODES.map((m) => (
          <ToggleGroupItem key={m.key} value={m.key} className="h-auto flex-col items-start gap-0 rounded-none px-2.5 py-2 text-left data-[pressed]:bg-foreground data-[pressed]:text-background">
            <span className="text-[13px] font-semibold">{m.label}</span>
            <span className="text-[10.5px] font-normal opacity-70">{m.desc}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {p.layer === "debug" && legend && (
        <div>
          <Label className="mb-1.5">Colour edges by</Label>
          <div className="flex flex-wrap gap-1.5">
            {LEGENDS.map((l) => (
              <button type="button" key={l.key} onClick={() => p.setAttr(l.key)} className={cn("rounded-full border px-2.5 py-1 text-[12px]", l.key === p.attr ? "border-foreground bg-foreground text-background" : "border-border")}>{l.label}</button>
            ))}
            <Soon>Gradient</Soon><Soon>Forest edge</Soon>
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">{legend.hint}</p>
          <div className={cn("mt-2 flex text-[11px]", legend.ramp ? "gap-0" : "flex-wrap gap-x-3 gap-y-1")}>
            {legend.items.map((it) => legend.ramp
              ? <span key={it.label} className="flex-1"><i className="block h-2" style={{ background: it.color }} /><span className="mt-0.5 block text-muted-foreground">{it.label}</span></span>
              : <span key={it.label} className="inline-flex items-center gap-1.5"><i className="h-1 w-4 rounded-full" style={{ background: it.color }} />{it.label}</span>)}
          </div>
        </div>
      )}
      {p.layer === "explored" && (
        <div className="space-y-2 text-[12px]">
          <div className="flex items-center gap-2"><i className="h-1 w-7 rounded-full bg-gradient-to-r from-[#5bbfae] to-[#0b6b5d]" />Ridden, darker the more often</div>
          <div className="flex items-center gap-2"><i className="h-0.5 w-7 rounded-full bg-[#c98a1b]" />Never ridden</div>
          <p className="text-muted-foreground">38 % of the rideable ways in this map window are explored.</p>
        </div>
      )}
      <div>
        <Label className="mb-1.5">Ride history</Label>
        <ImportDrop imports={p.imports} onImport={p.addImport} />
      </div>
    </div>
  );
}

const TABS: { key: View; label: string }[] = [{ key: "plan", label: "Route" }, { key: "profile", label: "Profile" }, { key: "layers", label: "Layers" }];
const Tabs = ({ p }: { p: Planner }) => (
  <div className="flex gap-5 border-b border-border">
    {TABS.map((t) => (
      <button type="button" key={t.key} onClick={() => p.setView(t.key)} className={cn("display -mb-px border-b-2 pb-1.5 text-[17px] font-medium", p.view === t.key ? "border-[var(--route)]" : "border-transparent text-muted-foreground")}>{t.label}</button>
    ))}
  </div>
);

// MapLibre wants literal colours: the same values as --route / --route-2 in themes.css
const LINE = { light: ["#c2255c", "#1c6fb8"], dark: ["#ff5f96", "#6db8ff"] } as const;
function mapRoutes(p: Planner, theme: "light" | "dark") {
  return [
    { id: p.active.id, route: p.route, color: LINE[theme][0] },
    ...(p.compareRoute && p.compare ? [{ id: p.compare.id, route: p.compareRoute, color: LINE[theme][1], width: 4, dashed: true }] : []),
  ];
}

function TopBar({ p, theme, toggleTheme, className }: { p: Planner; theme: string; toggleTheme: () => void; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="flex items-center gap-2 rounded-full border border-border bg-card/95 py-1.5 pl-2 pr-3.5 shadow-sm backdrop-blur">
        <Mark accent="var(--route)" />
        <span className="display text-[17px] font-semibold italic leading-none">Kompass</span>
      </div>
      <div className="ml-auto flex items-center gap-1 rounded-full border border-border bg-card/95 p-1 shadow-sm backdrop-blur">
        {MODES.map((m) => (
          <button type="button" key={m.key} title={m.label} onClick={() => p.setLayer(m.key)} className={cn("grid size-7 place-items-center rounded-full", p.layer === m.key && "bg-foreground text-background")}>
            {m.key === "normal" ? <MapIcon className="size-4" /> : m.key === "debug" ? <Layers className="size-4" /> : <Route className="size-4" />}
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" onClick={toggleTheme} aria-label="Toggle theme" className="grid size-7 place-items-center rounded-full">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
      </div>
    </div>
  );
}

export function DirectionA() {
  const { theme, toggleTheme } = useTheme();
  const p = usePlanner();
  const desktop = useIsDesktop();
  const [snap, setSnap] = useState<"peek" | "half" | "full">(p.view === "profile" ? "full" : "half");
  const [dragH, setDragH] = useState<number | null>(null);
  const vh = window.innerHeight;
  const heights = { peek: 118, half: Math.round(vh * 0.56), full: Math.round(vh * 0.7) };
  const h = dragH ?? heights[snap];
  const routes = mapRoutes(p, theme);

  const onHandle = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = heights[snap];
    let cur = h0;
    const move = (ev: PointerEvent) => {
      cur = Math.max(90, Math.min(vh - 70, h0 + y0 - ev.clientY));
      setDragH(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragH(null);
      if (Math.abs(cur - h0) < 6) setSnap(snap === "half" ? "full" : "half");
      else setSnap((Object.entries(heights) as [typeof snap, number][]).reduce((a, b) => (Math.abs(b[1] - cur) < Math.abs(a[1] - cur) ? b : a))[0]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const map = (pad: { top: number; bottom: number; left: number; right: number }) => (
    <MapView theme={theme} styles={{ light: STYLES.liberty, dark: STYLES.dark }} routes={routes} waypoints={p.waypoints} layer={p.layer} attr={p.attr} profile={p.active} padding={pad} attribBottom={desktop ? 0 : heights[snap]} forest={{ dark: "#1c3a26" }} className="absolute inset-0" />
  );
  const exportBtn = <Button size="sm" className="h-8 rounded-full"><Download /> GPX</Button>;
  const ride = <Soon className="py-1.5"><Bike className="size-3.5" /> Ride</Soon>;

  if (desktop)
    return (
      <div className="dir-a flex h-full bg-background text-foreground">
        <aside className="thin-scroll flex w-[392px] shrink-0 flex-col overflow-y-auto border-r border-border bg-card">
          <header className="flex items-center gap-2.5 px-5 pb-3 pt-4">
            <Mark size={26} accent="var(--route)" />
            <span className="display text-[22px] font-semibold italic leading-none">Kompass</span>
            <span className="ml-auto flex items-center gap-1.5">{ride}{exportBtn}</span>
          </header>
          <div className="px-5 pb-1">
            <div className="display text-[13px] italic text-muted-foreground">Sheet 8014 · Hochschwarzwald</div>
            <h1 className="display text-[26px] font-medium leading-tight">Ridge to the lake</h1>
          </div>
          <div className="px-5 py-4"><RoutePanel p={p} /></div>
        </aside>
        <main className="relative min-w-0 flex-1">
          {map({ top: 80, bottom: 60, left: 60, right: 60 })}
          <TopBar p={p} theme={theme} toggleTheme={toggleTheme} className="absolute right-3 top-3 [&>div:first-child]:hidden" />
          {p.layer !== "normal" && <div className="absolute bottom-4 left-4 w-[330px] rounded-xl border border-border bg-card/95 p-3.5 shadow-lg backdrop-blur"><LayersPanel p={p} /></div>}
          {p.layer === "normal" && (
            <button type="button" onClick={() => p.setLayer("explored")} className="absolute bottom-4 left-4 w-[310px] rounded-xl border border-border bg-card/95 p-2 text-left shadow-lg backdrop-blur">
              <ImportDrop imports={p.imports} onImport={p.addImport} className="border-0 py-1" />
            </button>
          )}
        </main>
        <aside className="thin-scroll w-[340px] shrink-0 overflow-y-auto border-l border-border bg-background px-4 py-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="display text-[20px] font-medium">Profile</h2>
            <span className="text-[11px] text-muted-foreground">applies to the whole route</span>
          </div>
          <ProfilePanel p={p} />
        </aside>
      </div>
    );

  return (
    <div className="dir-a relative h-full overflow-hidden bg-background text-foreground">
      {map({ top: 76, bottom: heights[snap] + 24, left: 40, right: 40 })}
      <TopBar p={p} theme={theme} toggleTheme={toggleTheme} className="absolute inset-x-3 top-3" />
      <section className={cn("absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t border-border bg-card shadow-[0_-8px_30px_rgb(0_0_0/0.18)]", dragH === null && "transition-[height] duration-300")} style={{ height: h }}>
        <div className="shrink-0 cursor-grab touch-none px-4 pb-2 pt-2" onPointerDown={onHandle}>
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-foreground/25" />
          <div className="flex items-end justify-between">
            <div>
              <div className="display text-[12px] italic leading-none text-muted-foreground">{p.active.name}{p.compare ? ` vs. ${p.compare.name}` : ""}</div>
              <h1 className="display mt-1 text-[20px] font-medium leading-none">Ridge to the lake</h1>
            </div>
            <span className="flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>{ride}{exportBtn}</span>
          </div>
        </div>
        <div className="shrink-0 px-4 pt-1"><Tabs p={p} /></div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          {p.view === "plan" ? <RoutePanel p={p} /> : p.view === "profile" ? <ProfilePanel p={p} /> : <LayersPanel p={p} />}
        </div>
      </section>
    </div>
  );
}
