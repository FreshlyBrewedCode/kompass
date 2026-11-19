import type { CSSProperties, ReactNode } from "react";
import { NOVEL_COLOR, ROADS, type RouteData, SURFACES, fmtKm, pct, roadColor, surfaceColor } from "@/mock/data";
import { cn } from "@/lib/utils";

export type StripBy = "surface" | "road" | "novel";
const segColor = (by: StripBy, s: RouteData["segs"][number]) =>
  by === "surface" ? surfaceColor(s.surface) : by === "road" ? roadColor(s.road) : s.novel ? NOVEL_COLOR.novel : NOVEL_COLOR.ridden;

const HATCH = "repeating-linear-gradient(135deg, transparent 0 2px, rgb(0 0 0 / 0.28) 2px 3.5px)";

/** The route unrolled along its distance, coloured by one attribute. */
export function SegStrip({ route, by, maxKm, className, style }: { route: RouteData; by: StripBy; maxKm?: number; className?: string; style?: CSSProperties }) {
  const total = maxKm ?? route.km;
  return (
    <div className={cn("flex h-2 w-full overflow-hidden", className)} style={style}>
      {route.segs.map((s) => (
        <div key={s.i0} title={`${fmtKm(s.to - s.from)} km`} style={{ width: `${((s.to - s.from) / total) * 100}%`, background: segColor(by, s), backgroundImage: by === "surface" && s.surface === "unknown" ? HATCH : undefined }} />
      ))}
    </div>
  );
}

interface ElevProps {
  route: RouteData;
  compare?: RouteData | null;
  color: string;
  compareColor?: string;
  height?: number;
  fillOpacity?: number;
  marks?: { km: number; label: string }[];
  grid?: boolean;
  className?: string;
  children?: ReactNode;
}
/** Elevation profile. Stretches to its container; labels are HTML so they do not distort. */
export function Elevation({ route, compare, color, compareColor = "#888", height = 80, fillOpacity = 0.16, marks, grid = true, className }: ElevProps) {
  const all = [...route.profile, ...(compare?.profile ?? [])];
  const maxKm = Math.max(route.km, compare?.km ?? 0);
  const lo = Math.floor(Math.min(...all.map((p) => p[1])) / 50) * 50;
  const hi = Math.ceil(Math.max(...all.map((p) => p[1])) / 50) * 50;
  const W = 1000;
  const x = (km: number) => (km / maxKm) * W;
  const y = (e: number) => height - 2 - ((e - lo) / (hi - lo)) * (height - 8);
  const line = (r: RouteData) => r.profile.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const last = route.profile[route.profile.length - 1] as [number, number];
  return (
    <div className={cn("relative w-full select-none", className)} style={{ height }}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" role="img" aria-label="Elevation profile">
        {grid && [0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={height * f} y2={height * f} stroke="currentColor" strokeOpacity={0.1} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />)}
        <path d={`${line(route)}L${x(last[0])},${height}L0,${height}Z`} fill={color} fillOpacity={fillOpacity} />
        {compare && <path d={line(compare)} fill="none" stroke={compareColor} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
        <path d={line(route)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {marks?.map((m) => <line key={m.label} x1={x(m.km)} x2={x(m.km)} y1={0} y2={height} stroke="currentColor" strokeOpacity={0.35} vectorEffect="non-scaling-stroke" />)}
      </svg>
      <span className="absolute left-0 top-0 text-[10px] leading-none opacity-55 tabular-nums">{hi} m</span>
      <span className="absolute bottom-0.5 right-0 text-[10px] leading-none opacity-55 tabular-nums">{lo} m</span>
      {marks?.map((m) => (
        <span key={m.label} className="absolute top-0 -translate-x-1/2 rounded-sm px-1 text-[9px] font-semibold leading-[13px]" style={{ left: `${(m.km / maxKm) * 100}%`, background: "var(--mark-bg, var(--foreground))", color: "var(--mark-fg, var(--background))" }}>
          {m.label}
        </span>
      ))}
    </div>
  );
}

/** Stacked bar plus a legend with km and share. */
export function Breakdown({ route, by, compact, className, barClassName }: { route: RouteData; by: "surface" | "road"; compact?: boolean; className?: string; barClassName?: string }) {
  const defs = by === "surface" ? SURFACES : ROADS;
  const vals = (by === "surface" ? route.surface : route.road) as Record<string, number | undefined>;
  const parts = defs.map((d) => ({ ...d, km: vals[d.key] ?? 0 })).filter((p) => p.km > 0.15);
  return (
    <div className={className}>
      <div className={cn("flex h-2.5 w-full gap-px overflow-hidden rounded-full", barClassName)}>
        {parts.map((p) => (
          <div key={p.key} style={{ width: `${(p.km / route.km) * 100}%`, background: p.color, backgroundImage: p.key === "unknown" ? HATCH : undefined }} />
        ))}
      </div>
      <div className={cn("mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] leading-4", compact && "gap-x-2.5")}>
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1 whitespace-nowrap">
            <i className="inline-block size-2 rounded-[2px]" style={{ background: p.color, backgroundImage: p.key === "unknown" ? HATCH : undefined }} />
            <span className="opacity-70">{p.label}</span>
            <b className="font-semibold tabular-nums">{compact ? `${pct(p.km, route.km)}%` : `${fmtKm(p.km)} km`}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The Kompass mark: a compass needle in a ring. */
export function Mark({ size = 22, className, accent = "currentColor" }: { size?: number; className?: string; accent?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {[0, 90, 180, 270].map((a) => <line key={a} x1="12" y1="1.75" x2="12" y2="4" stroke="currentColor" strokeWidth="1.5" transform={`rotate(${a} 12 12)`} />)}
      <g transform="rotate(38 12 12)">
        <path d="M12 4.6 14.6 12H9.4Z" fill={accent} />
        <path d="M12 19.4 9.4 12h5.2Z" fill="currentColor" fillOpacity="0.35" />
      </g>
    </svg>
  );
}

/** Marks something as planned for later: visible room, not built. */
export function Soon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span title="Later: not part of this round" className={cn("inline-flex cursor-not-allowed items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-current/30 px-2.5 py-1 text-[11px] font-medium opacity-60", className)}>
      {children}
    </span>
  );
}

/** Drop zone for GPX/FIT tracks. Mock: lists the file names, imports nothing. */
export function ImportDrop({ imports, onImport, className }: { imports: string[]; onImport: (names: string[]) => void; className?: string }) {
  return (
    <label
      className={cn("flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-current/30 px-3 py-3 text-center text-xs transition-colors hover:border-current/60", className)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onImport([...e.dataTransfer.files].map((f) => f.name));
      }}
    >
      <input type="file" accept=".gpx,.fit" multiple className="hidden" onChange={(e) => onImport([...(e.target.files ?? [])].map((f) => f.name))} />
      <b className="font-semibold">Drop GPX or FIT rides here</b>
      <span className="opacity-60">{imports.length ? `${imports.length} added just now: ${imports.slice(0, 2).join(", ")}` : "214 rides matched · last import 3 days ago"}</span>
    </label>
  );
}
