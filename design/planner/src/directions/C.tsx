import { ArrowUp, Check, Download, GripVertical, Layers, Minus, Moon, Plus, Sparkles, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HARD, type Profile, SOFT, type SoftKey, SURFACES, WHY, compareRows, fmtKm, fmtTime, legs, pct, pointAtKm } from "@/mock/data";
import { LEGENDS } from "@/shared/attrs";
import { MapView, STYLES } from "@/shared/MapView";
import { type LayerMode, type Planner, type Theme, type View, useIsDesktop, usePlanner, useReorder, useTheme } from "@/shared/usePlanner";
import { Breakdown, Elevation, ImportDrop, Mark, SegStrip, Soon } from "@/shared/viz";

/**
 * C · Sentence. The map is the app; everything else floats. The profile is a sentence you can read,
 * each phrase can be nudged (more of this, less of that), and the agent bar edits the same sentence.
 */
const HOT = { light: ["#f0451f", "#2563eb"], dark: ["#ff6a45", "#6ea8ff"] } as const;
const glass = "border border-border bg-card shadow-[0_8px_30px_rgb(0_0_0/0.14)] backdrop-blur-xl";

const LEVELS = [-80, -40, 0, 40, 80];
const level = (v: number) => LEVELS.reduce((b, l, i) => (Math.abs(l - v) < Math.abs((LEVELS[b] as number) - v) ? i : b), 0);
const GROUPS: { test: (v: number) => boolean; lead: string; tone: string }[] = [
  { test: (v) => v >= 60, lead: "Take me along", tone: "var(--more)" },
  { test: (v) => v >= 20 && v < 60, lead: "I like", tone: "var(--more)" },
  { test: (v) => v <= -20 && v > -60, lead: "Go easy on", tone: "var(--less)" },
  { test: (v) => v <= -60, lead: "Keep me away from", tone: "var(--less)" },
];

function Sentence({ p, big }: { p: Planner; big?: boolean }) {
  const [sel, setSel] = useState<SoftKey | null>("edge");
  const pr = p.active;
  const selDef = SOFT.find((s) => s.key === sel);
  const neutral = SOFT.filter((s) => Math.abs(pr.soft[s.key]) < 20);
  const nudge = (k: SoftKey, d: number) => p.setSoft(pr.id, k, LEVELS[Math.max(0, Math.min(4, level(pr.soft[k]) + d))] as number);
  return (
    <div>
      <p className={cn("font-medium leading-[1.55] tracking-[-0.01em]", big ? "text-[21px]" : "text-[18px]")}>
        {GROUPS.map((g) => {
          const items = SOFT.filter((s) => g.test(pr.soft[s.key]));
          if (!items.length) return null;
          return (
            <span key={g.lead}>
              <span className="text-muted-foreground">{g.lead} </span>
              {items.map((s, i) => (
                <span key={s.key}>
                  <span role="button" tabIndex={0} onClick={() => setSel(s.key)} onKeyDown={(e) => e.key === "Enter" && setSel(s.key)} className={cn("-mx-[3px] cursor-pointer rounded-md box-decoration-clone px-[3px] py-px underline decoration-2 underline-offset-[5px] transition-colors", sel === s.key && "bg-foreground text-background no-underline")} style={{ textDecorationColor: g.tone }}>{s.phrase}</span>
                  <span className="text-muted-foreground">{i < items.length - 2 ? ", " : i === items.length - 2 ? " and " : ". "}</span>
                </span>
              ))}
            </span>
          );
        })}
        <span className="text-muted-foreground">Never </span>
        {HARD.filter((h) => pr.hard[h.key]).map((h, i, arr) => (
          <span key={h.key}>
            <span role="button" tabIndex={0} onClick={() => p.toggleHard(pr.id, h.key)} onKeyDown={(e) => e.key === "Enter" && p.toggleHard(pr.id, h.key)} title="Tap to lift this rule" className="cursor-pointer underline decoration-[var(--hot)] decoration-wavy decoration-1 underline-offset-[5px]">{h.label.replace(/^No(thing)? /, "").toLowerCase()}</span>
            <span className="text-muted-foreground">{i < arr.length - 1 ? ", " : "."}</span>
          </span>
        ))}
      </p>

      {selDef && (
        <div className="mt-3 flex items-center gap-2 rounded-2xl bg-muted/70 p-1.5 pl-3">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{selDef.label}</span>
          <button type="button" onClick={() => nudge(selDef.key, -1)} className="flex h-8 items-center gap-1 rounded-xl bg-card px-2.5 text-[12.5px] font-semibold shadow-sm"><Minus className="size-3.5" style={{ color: "var(--less)" }} />less</button>
          <span className="flex gap-[3px]" title={`${pr.soft[selDef.key]}`}>
            {LEVELS.map((l, i) => <i key={l} className={cn("h-4 w-1.5 rounded-full", i === level(pr.soft[selDef.key]) ? "bg-foreground" : "bg-foreground/20", i === 2 && "h-2.5 self-center")} />)}
          </span>
          <button type="button" onClick={() => nudge(selDef.key, 1)} className="flex h-8 items-center gap-1 rounded-xl bg-card px-2.5 text-[12.5px] font-semibold shadow-sm"><Plus className="size-3.5" style={{ color: "var(--more)" }} />more</button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="text-muted-foreground">No opinion on</span>
        {neutral.map((s) => <button type="button" key={s.key} onClick={() => { setSel(s.key); }} className={cn("rounded-full border border-border px-2 py-0.5", sel === s.key && "border-foreground")}>{s.short.toLowerCase()}</button>)}
        {neutral.length === 0 && <span>anything</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="text-muted-foreground">Add a rule</span>
        {HARD.filter((h) => !pr.hard[h.key]).map((h) => <button type="button" key={h.key} onClick={() => p.toggleHard(pr.id, h.key)} className="rounded-full border border-dashed border-foreground/30 px-2 py-0.5">{h.short.toLowerCase()}</button>)}
      </div>
    </div>
  );
}

/** The comparison as a trade-off sentence, the way the agent would put it. */
function WhatIf({ p }: { p: Planner }) {
  const others = p.profiles.filter((x) => x.id !== p.active.id);
  const rows = p.compareRoute ? compareRows(p.route, p.compareRoute) : [];
  const r = (l: string) => rows.find((x) => x.label === l);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="text-muted-foreground">What if I rode it as</span>
        {others.map((o) => (
          <button type="button" key={o.id} onClick={() => p.setCompare(p.compare?.id === o.id ? null : o.id)} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold", p.compare?.id === o.id ? "border-transparent bg-[var(--cool)] text-white dark:text-black" : "border-border")}>
            {o.name}
          </button>
        ))}
      </div>
      {p.compare && p.compareRoute && (
        <div className="mt-2.5 rounded-2xl border border-[var(--cool)]/40 bg-[var(--cool)]/8 p-3">
          <p className="text-[13.5px] leading-snug">
            <b style={{ color: "var(--cool)" }}>{p.compare.name}</b> is {r("Distance")?.deltaText.replace("+", "")} longer but {r("Time")?.deltaText.replace("−", "")} faster, with {r("Climb")?.deltaText.replace("−", "")} less climbing. It trades {fmtKm(-(r("Unpaved")?.delta ?? 0))} km of gravel for <b>{r("Main road")?.deltaText.replace("+", "")} on main roads</b>, and only {fmtKm(p.compareRoute.newKm)} km of it would be new to you.
          </p>
          <div className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-1.5 text-[11.5px]">
            {rows.map((x) => (
              <div key={x.label}>
                <div className="text-muted-foreground">{x.label}</div>
                <div className="font-semibold tabular-nums"><span style={{ color: "var(--hot)" }}>{x.a.replace(" km", "")}</span> <span className="text-muted-foreground">→</span> <span style={{ color: "var(--cool)" }}>{x.b}</span></div>
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex gap-1.5">
            <Button size="sm" onClick={() => p.setActive(p.compare?.id ?? "")} className="h-7 rounded-full text-[12px]"><Check /> Ride it this way</Button>
            <Button size="sm" variant="ghost" onClick={() => p.setCompare(null)} className="h-7 rounded-full text-[12px]">Dismiss</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RouteCard({ p, roomy }: { p: Planner; roomy?: boolean }) {
  const ROW = 36;
  const { drag, handle } = useReorder(ROW, p.moveWaypoint);
  const lg = legs(p.route, p.waypoints);
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3.5">
        {[[fmtKm(p.route.km), "km"], [String(p.route.climb), "m ↑"], [fmtTime(p.route.minutes), "h"]].map(([v, u]) => (
          <div key={u} className="whitespace-nowrap leading-none"><span className="text-[25px] font-bold tracking-tight tabular-nums">{v}</span><span className="ml-1 text-[12px] text-muted-foreground">{u}</span></div>
        ))}
        <Button size="sm" className="ml-auto h-8 rounded-full"><Download /> GPX</Button>
      </div>
      <div>
        <Elevation route={p.route} compare={p.compareRoute} color="var(--foreground)" compareColor="var(--cool)" height={roomy ? 64 : 40} grid={false} fillOpacity={0.07} />
        <SegStrip route={p.route} by="surface" maxKm={Math.max(p.route.km, p.compareRoute?.km ?? 0)} className="h-2 rounded-full" />
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
          {SURFACES.map((s) => <span key={s.key} className="inline-flex items-center gap-1"><i className="size-2 rounded-full" style={{ background: s.color }} />{s.label.split(" ")[0]} <b className="text-foreground">{pct(p.route.surface[s.key] ?? 0, p.route.km)}%</b></span>)}
          <span className="ml-auto"><b className="text-foreground">{pct(p.route.newKm, p.route.km)}%</b> new to you</span>
        </div>
      </div>
      <ol>
        {p.waypoints.map((w, i) => {
          const end = i === 0 || i === p.waypoints.length - 1;
          return (
            <li key={w.id} className={cn("flex items-center gap-2.5 border-t border-border text-[13.5px]", drag?.index === i && "relative z-10 rounded-xl bg-muted")} style={{ height: ROW, transform: drag?.index === i ? `translateY(${drag.dy}px)` : undefined }}>
              <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[10.5px] font-bold", end ? "bg-foreground text-background" : "border-[1.5px] border-foreground")}>{i === 0 ? "A" : end ? "B" : i}</span>
              <span className="flex-1 truncate font-semibold">{w.name}</span>
              {lg[i] && <span className="text-[11.5px] tabular-nums text-muted-foreground">{fmtKm(lg[i].km)} km</span>}
              <button type="button" aria-label={`Remove ${w.name}`} onClick={() => p.removeWaypoint(w.id)} className="text-muted-foreground"><X className="size-4" /></button>
              <button type="button" aria-label={`Move ${w.name}`} className="text-muted-foreground" {...handle(i)}><GripVertical className="size-4" /></button>
            </li>
          );
        })}
      </ol>
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
        <button type="button" onClick={p.addWaypoint} className="flex shrink-0 items-center gap-1 rounded-full bg-foreground px-3 py-1 text-[12px] font-semibold text-background"><Plus className="size-3.5" /> Stop</button>
        <Soon>Through this area</Soon><Soon>Avoid this area</Soon><Soon>Draw it</Soon><Soon>Make it a loop</Soon><Soon>Profile per leg</Soon>
      </div>
      {roomy && <div className="grid gap-3 pt-1"><Breakdown route={p.route} by="road" /></div>}
    </div>
  );
}

const MODES: { key: LayerMode; label: string }[] = [{ key: "normal", label: "Map" }, { key: "debug", label: "Attributes" }, { key: "explored", label: "Explored" }];
function LayersCard({ p }: { p: Planner }) {
  const legend = LEGENDS.find((l) => l.key === p.attr) ?? LEGENDS[0];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 rounded-full bg-muted p-1 text-[12.5px] font-semibold">
        {MODES.map((m) => <button type="button" key={m.key} onClick={() => p.setLayer(m.key)} className={cn("rounded-full py-1.5", p.layer === m.key && "bg-card shadow-sm")}>{m.label}</button>)}
      </div>
      {p.layer === "debug" && legend && (
        <>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {LEGENDS.map((l) => <button type="button" key={l.key} onClick={() => p.setAttr(l.key)} className={cn("rounded-full border px-2.5 py-1 font-semibold", l.key === p.attr ? "border-foreground bg-foreground text-background" : "border-border")}>{l.label}</button>)}
            <Soon>Gradient</Soon><Soon>Forest edge</Soon>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
            {legend.items.map((it) => <span key={it.label} className="inline-flex items-center gap-1.5"><i className="h-1.5 w-4 rounded-full" style={{ background: it.color }} />{it.label}</span>)}
          </div>
          <p className="text-[11.5px] text-muted-foreground">{legend.hint}</p>
        </>
      )}
      {p.layer === "explored" && (
        <div className="space-y-1 text-[12px]">
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 rounded-full bg-gradient-to-r from-[#5bbfae] to-[#0b6b5d]" />Ridden, stronger the more often</div>
          <div className="flex items-center gap-2"><i className="h-1.5 w-6 rounded-full bg-[#c98a1b]" />Never ridden</div>
        </div>
      )}
      {p.layer === "normal" && <p className="text-[12px] text-muted-foreground">The route is coloured by surface. The notes on the map say why it went this way.</p>}
      <ImportDrop imports={p.imports} onImport={p.addImport} className="rounded-2xl" />
    </div>
  );
}

/** The agent's place. Not wired up: the quick nudges above it are, and they edit the same profile. */
function AgentBar({ p, className }: { p: Planner; className?: string }) {
  const nudges: [string, SoftKey, number][] = [["quieter", "quiet", 40], ["less climbing", "climb", -40], ["more forest edge", "edge", 40], ["more new roads", "novelty", 40]];
  return (
    <div className={className}>
      <div className="no-scrollbar mb-1.5 flex gap-1.5 overflow-x-auto">
        {nudges.map(([label, key, d]) => (
          <button type="button" key={label} onClick={() => p.setSoft(p.active.id, key, Math.max(-80, Math.min(80, p.active.soft[key] + d)))} className={cn("shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold", glass)}>{label}</button>
        ))}
      </div>
      <div className={cn("flex h-11 items-center gap-2 rounded-full pl-3.5 pr-1.5", glass)} title="Later: the agent edits the same sentence">
        <Sparkles className="size-4 shrink-0" style={{ color: "var(--hot)" }} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">40 km loop north-west, quiet gravel…</span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">later</span>
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background"><ArrowUp className="size-4" /></span>
      </div>
    </div>
  );
}

function ProfilePick({ p }: { p: Planner }) {
  return (
    <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
      {p.profiles.map((pr: Profile) => (
        <button type="button" key={pr.id} onClick={() => p.setActive(pr.id)} className={cn("shrink-0 rounded-full border px-3 py-1 text-[12.5px] font-semibold", pr.id === p.active.id ? "border-foreground bg-foreground text-background" : "border-border")}>{pr.name}</button>
      ))}
      <Soon>Learn from my rides</Soon>
    </div>
  );
}

export function DirectionC() {
  const { theme, toggleTheme } = useTheme();
  const p = usePlanner();
  const desktop = useIsDesktop();
  const comparing = !!p.compareRoute;
  const routes = [
    { id: p.active.id, route: p.route, color: HOT[theme as Theme][0], width: 5.5, colorBy: comparing || p.layer !== "normal" ? ("solid" as const) : ("surface" as const) },
    ...(p.compareRoute && p.compare ? [{ id: p.compare.id, route: p.compareRoute, color: HOT[theme as Theme][1], width: 4 }] : []),
  ];
  const callouts = comparing || p.layer !== "normal" ? [] : WHY.slice(0, desktop ? 3 : 2).map((w) => ({ lngLat: pointAtKm(p.route, w.km), html: desktop ? `<b>${w.title}</b>${w.text} <i>${w.delta}</i>` : `<b>${w.short}</b><i>${w.delta}</i>` }));
  const mapEl = (pad: { top: number; bottom: number; left: number; right: number }, attribBottom = 0) => (
    <MapView theme={theme} styles={{ light: STYLES.positron, dark: STYLES.dark }} forest={{ light: "#d5e3cb", dark: "#17281d" }} routes={routes} waypoints={p.waypoints} layer={p.layer} attr={p.attr} profile={p.active} padding={pad} callouts={callouts} attribBottom={attribBottom} className="absolute inset-0" />
  );
  const brand = (
    <div className={cn("flex h-10 items-center gap-2 rounded-full pl-2.5 pr-3.5", glass)}>
      <Mark size={20} accent="var(--hot)" /><span className="text-[15px] font-extrabold tracking-tight">kompass</span>
    </div>
  );
  const tools = (
    <div className={cn("flex h-10 items-center gap-0.5 rounded-full px-1", glass)}>
      <button type="button" onClick={() => p.setView(p.view === "layers" ? "plan" : "layers")} aria-label="Map layers" className={cn("grid size-8 place-items-center rounded-full", (p.view === "layers" || p.layer !== "normal") && "bg-foreground text-background")}><Layers className="size-4" /></button>
      <button type="button" onClick={toggleTheme} aria-label="Toggle theme" className="grid size-8 place-items-center rounded-full">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
    </div>
  );
  const TABS: { key: View; label: string }[] = [{ key: "plan", label: "Route" }, { key: "profile", label: "How" }, { key: "layers", label: "Map" }];

  if (desktop)
    return (
      <div className="dir-c relative h-full overflow-hidden bg-background text-foreground">
        {mapEl({ top: 90, bottom: 130, left: 420, right: 450 })}
        <div className="absolute left-4 top-4 flex gap-2">{brand}<Soon className="h-10 border-solid bg-card px-3.5 opacity-70 backdrop-blur-xl">Ride mode</Soon></div>
        <div className="absolute right-4 top-4">{tools}</div>
        <section className={cn("thin-scroll absolute bottom-4 left-4 top-[68px] w-[360px] overflow-y-auto rounded-3xl p-4", glass)} style={{ height: "fit-content", maxHeight: "calc(100% - 84px)" }}>
          <div className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Ridge to the lake</div>
          <RouteCard p={p} roomy />
        </section>
        <section className={cn("thin-scroll absolute right-4 top-[68px] w-[400px] overflow-y-auto rounded-3xl p-5", glass)} style={{ maxHeight: "calc(100% - 84px)" }}>
          {p.view === "layers" ? <LayersCard p={p} /> : (
            <div className="space-y-4">
              <ProfilePick p={p} />
              <Sentence p={p} big />
              <div className="border-t border-border pt-3.5"><WhatIf p={p} /></div>
            </div>
          )}
        </section>
        <AgentBar p={p} className="absolute bottom-4 left-1/2 w-[520px] -translate-x-1/2" />
      </div>
    );

  const tall = p.view === "profile";
  return <Phone p={p} tall={tall} mapEl={mapEl} brand={brand} tools={tools} tabs={TABS} />;
}

function Phone({ p, tall, mapEl, brand, tools, tabs }: { p: Planner; tall: boolean; mapEl: (pad: { top: number; bottom: number; left: number; right: number }, attribBottom?: number) => React.ReactNode; brand: React.ReactNode; tools: React.ReactNode; tabs: { key: View; label: string }[] }) {
  const TABS = tabs;
  const stack = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(tall ? 560 : 440);
  useEffect(() => {
    if (!stack.current) return;
    const ro = new ResizeObserver(([e]) => e && setH(Math.round(e.contentRect.height)));
    ro.observe(stack.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="dir-c relative h-full overflow-hidden bg-background text-foreground">
      {mapEl({ top: 64, bottom: h + 26, left: 30, right: 30 }, h + 14)}
      <div className="absolute inset-x-3 top-3 flex justify-between">{brand}{tools}</div>
      <div ref={stack} className="absolute inset-x-2.5 bottom-2.5 flex flex-col gap-2">
        <section className={cn("rounded-[26px] p-4 pt-3", glass)}>
          <div className="mb-2.5 flex items-center gap-1 text-[13px] font-bold">
            {TABS.map((t) => <button type="button" key={t.key} onClick={() => p.setView(t.key)} className={cn("rounded-full px-3 py-1", p.view === t.key ? "bg-foreground text-background" : "text-muted-foreground")}>{t.label}</button>)}
            <span className="ml-auto truncate pl-2 text-[12px] font-semibold text-muted-foreground">{p.active.name}</span>
          </div>
          <div className="thin-scroll overflow-y-auto" style={{ maxHeight: tall ? 440 : 330 }}>
            {p.view === "plan" && <RouteCard p={p} />}
            {p.view === "profile" && <div className="space-y-3"><ProfilePick p={p} /><Sentence p={p} /><div className="border-t border-border pt-3"><WhatIf p={p} /></div></div>}
            {p.view === "layers" && <LayersCard p={p} />}
          </div>
        </section>
        <AgentBar p={p} />
      </div>
    </div>
  );
}
