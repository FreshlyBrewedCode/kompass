// The key to the map's line styles ("Map & rides", the Map tab): the tracks always, as a small
// legend, the rest folded. Every sample is drawn from the same tables as the map's layers
// (`KEY_ROWS`, `keyStrokes` in src/map/ways.ts) and the same options (`cartoFor`): colours, widths,
// casings and dashes at `KEY_ZOOM`, on land and on forest. Nothing here is a second copy of the style.
import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useMapLook } from "@/lib/map-look";
import { type Carto, cartoFor } from "@/map/carto";
import { WEIGHT_SCALE } from "@/map/look";
import type { Theme } from "@/map/palette";
import { KEY_ROWS, KEY_ZOOM, type KeyRow, keyStrokes } from "@/map/ways";
import { label } from "./parts";

const W = 52;
const H = 20;
/** A shallow S: joins and dashes show as they do on a real way. */
const PATH = `M 4 ${H / 2 + 3} C ${W * 0.3} ${H / 2 + 3}, ${W * 0.35} ${H / 2 - 4}, ${W / 2} ${H / 2 - 2} S ${W * 0.75} ${H / 2 + 2}, ${W - 4} ${H / 2 - 2}`;

function Sample({ row, c, weight }: { row: KeyRow; c: Carto; weight: number }) {
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 rounded-sm" aria-hidden="true">
      <rect width={W / 2} height={H} fill={c.farmland} />
      <rect x={W / 2} width={W / 2} height={H} fill={c.forest} />
      {keyStrokes(row, c, weight).map((s, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: the strokes of one sample, in drawing order
          key={i}
          d={PATH}
          fill="none"
          stroke={s.color}
          strokeWidth={s.width}
          strokeOpacity={s.opacity}
          strokeLinecap={s.cap}
          strokeLinejoin="round"
          strokeDasharray={s.dash?.join(" ")}
        />
      ))}
    </svg>
  );
}

function Rows({ rows, c, weight }: { rows: readonly KeyRow[]; c: Carto; weight: number }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
      {rows.map((row) => (
        <li
          key={`${row.group}-${row.label}`}
          data-testid="map-key-entry"
          className="flex min-w-0 items-center gap-2"
        >
          <Sample row={row} c={c} weight={weight} />
          <span className="min-w-0 leading-tight">
            <span className="block">{row.label}</span>
            {row.note && <span className="block text-2xs text-muted-foreground">{row.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const REST = ["Roads", "Paths", "Also"] as const;

/** The key: the tracks as a small legend, every other line style a tap away. */
export function MapKey({ theme, className }: { theme: Theme; className?: string }) {
  const [open, setOpen] = useState(false);
  const [look] = useMapLook();
  const c = cartoFor(theme, look);
  const weight = WEIGHT_SCALE[look.weight];
  const tracks = KEY_ROWS.filter((r) => r.group === "Tracks");
  return (
    <div className={cn("text-xs", className)}>
      <div data-testid="map-key-tracks">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="font-semibold text-sm">Tracks</span>
          <span className="text-muted-foreground">
            {look.tracks === "graded" ? "fill: the surface · dashed rim: unpaved" : "dashed rim: unpaved"}
          </span>
        </div>
        <Rows rows={tracks} c={c} weight={weight} />
      </div>
      <button
        type="button"
        data-testid="map-key-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="mt-2 flex w-full items-center gap-2 text-left text-muted-foreground"
      >
        <span className="min-w-0 flex-1">Roads, paths and the rest</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div data-testid="map-key" className="mt-2 space-y-2.5">
          {REST.map((group) => (
            <div key={group}>
              <div className={cn(label, "mb-1")}>{group}</div>
              <Rows rows={KEY_ROWS.filter((r) => r.group === group)} c={c} weight={weight} />
            </div>
          ))}
          <p className="text-muted-foreground leading-snug">
            As drawn at zoom {KEY_ZOOM}. Zoomed further out the rims are plain, tracks are fainter and paths
            are left out.
          </p>
        </div>
      )}
    </div>
  );
}
