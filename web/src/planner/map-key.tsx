// The key to the map's line styles ("Map & rides", the Map tab). Every sample is drawn from the same
// tables as the map's layers (`KEY_ROWS`, `keyStrokes` in src/map/ways.ts): colours, widths, casings
// and dashes at `KEY_ZOOM`, on land and on forest. Nothing here is a second copy of the style.
import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { CARTO } from "@/map/carto";
import type { Theme } from "@/map/palette";
import { KEY_ROWS, KEY_ZOOM, type KeyRow, keyStrokes } from "@/map/ways";
import { label } from "./parts";

const W = 52;
const H = 18;
/** A shallow S: joins and dashes show as they do on a real way. */
const PATH = `M 4 ${H / 2 + 3} C ${W * 0.3} ${H / 2 + 3}, ${W * 0.35} ${H / 2 - 4}, ${W / 2} ${H / 2 - 2} S ${W * 0.75} ${H / 2 + 2}, ${W - 4} ${H / 2 - 2}`;

function Sample({ row, theme }: { row: KeyRow; theme: Theme }) {
  const c = CARTO[theme];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 rounded-sm" aria-hidden="true">
      <rect width={W / 2} height={H} fill={c.land} />
      <rect x={W / 2} width={W / 2} height={H} fill={c.forest} />
      {keyStrokes(row, c).map((s, i) => (
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

const GROUPS = ["Roads", "Tracks", "Paths", "Also"] as const;

/** The key, folded by default: a tap shows every line style of the map. */
export function MapKey({ theme, className }: { theme: Theme; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("text-xs", className)}>
      <button
        type="button"
        data-testid="map-key-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-sm">Key</span>
          <span className="block text-muted-foreground text-xs">
            Width is the kind of way, the fill how rough it is.
          </span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div data-testid="map-key" className="mt-2.5 space-y-2.5">
          {GROUPS.map((group) => (
            <div key={group}>
              <div className={cn(label, "mb-1")}>{group}</div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
                {KEY_ROWS.filter((r) => r.group === group).map((row) => (
                  <li
                    key={`${row.group}-${row.label}`}
                    data-testid="map-key-entry"
                    className="flex min-w-0 items-center gap-2"
                  >
                    <Sample row={row} theme={theme} />
                    <span className="min-w-0 leading-tight">
                      <span className="block">{row.label}</span>
                      {row.note && <span className="block text-2xs text-muted-foreground">{row.note}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-muted-foreground leading-snug">
            As drawn at zoom {KEY_ZOOM}. Zoomed further out, tracks are fainter and paths are left out.
          </p>
        </div>
      )}
    </div>
  );
}
