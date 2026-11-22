// The segment inspector under the structured controls (#66): the way's row and tier on each board and
// the hills curve's metres here, in a rider's words ("Tracks: love, counts 1.0×", "these 400 m at up
// to 10 % count 600 m more"); a tap opens the tier picker or the handle's stepper in place, and the
// route and the explanation follow.
import { cn } from "cn";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { useState } from "react";
import type { ArcCostExplanation, BoardRow, EdgeExplanation, Tier } from "@/engine/generated/types";
import { metresText } from "../cost/model";
import { label } from "../parts";
import { usePlan, usePlanner } from "../store";
import { TierPicker } from "./board";
import {
  gradeText,
  HANDLES,
  handleRange,
  handleValue,
  metreText,
  num,
  rowLabel,
  stepValue,
  TIER_LABEL,
} from "./model";

/** The handle that reads a grade (the nearest editable one). */
export function nearestHandle(pct: number): number {
  return HANDLES.filter((g) => g !== 0).reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a), 10);
}

/** The hills line's words: "these 400 m at up to 10 % count 600 m more". */
export function hillsLine(
  length: number,
  h: NonNullable<NonNullable<ArcCostExplanation["structured"]>["hills"]>,
) {
  const grade = Math.round(Math.abs(h.wall_pct));
  const where =
    grade < 1
      ? "about flat"
      : `${h.wall_pct >= 0 ? "up" : "down"} to ${grade} %${h.loose ? ", loose ground read steeper" : ""}`;
  if (Math.abs(h.metres) < 0.5) return `these ${metresText(length)} (${where}) count as they are`;
  return `these ${metresText(length)} (${where}) count ${metresText(Math.abs(h.metres))} ${h.metres > 0 ? "more" : "less"}`;
}

function Row({
  row,
  tier,
  factor,
  open,
  onToggle,
}: {
  row: BoardRow;
  tier: Tier;
  factor: number;
  open: boolean;
  onToggle: () => void;
}) {
  const store = usePlanner();
  const catalogue = usePlan((s) => s.catalogue);
  const spread = usePlan((s) => s.structured?.spread ?? 1);
  const current = usePlan((s) => {
    const p = s.structured;
    if (!p) return undefined;
    return ((p.boards.surface as Record<string, Tier> | undefined)?.[row] ??
      (p.boards.way as Record<string, Tier> | undefined)?.[row]) as Tier | undefined;
  });
  const name = rowLabel(row, catalogue);
  return (
    <li data-testid={`inspector-row-${row}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left text-xs hover:bg-foreground/6"
      >
        <i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: `var(--row-${row})` }} />
        <span className="min-w-0 flex-1 truncate">
          <b>{name}</b>: {TIER_LABEL[current ?? tier].toLowerCase()}
          {tier !== "avoid" && `, counts ${num(factor ** spread)}×`}
        </span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-1 pt-0.5 pb-1.5" data-testid="inspector-tier">
          <TierPicker
            compact
            current={current}
            spread={spread}
            testid="inspector-tier"
            onPick={(t) => store.setRow(row, t)}
          />
        </div>
      )}
    </li>
  );
}

function HandleInPlace({ grade }: { grade: number }) {
  const store = usePlanner();
  const hills = usePlan((s) => s.structured?.hills);
  const info = usePlan((s) => s.catalogue?.structured);
  if (!hills) return null;
  const v = handleValue(hills, grade);
  const range = handleRange(grade, info);
  const btn =
    "grid size-11 shrink-0 place-items-center rounded-full bg-muted hover:bg-foreground/12 disabled:opacity-40";
  return (
    <div className="flex items-center gap-2 px-1 pt-0.5 pb-1.5 text-xs" data-testid="inspector-handle">
      <span className="min-w-0 flex-1 text-muted-foreground leading-snug">
        At {gradeText(grade)} a metre counts as
      </span>
      <button
        type="button"
        aria-label={`Cheaper at ${gradeText(grade)}`}
        className={btn}
        disabled={v <= range.min}
        onClick={() => store.setHandle(grade, stepValue(v, -1, range))}
      >
        <Minus className="size-4" />
      </button>
      <span className="min-w-12 text-center font-bold text-sm tabular-nums">{metreText(v)}</span>
      <button
        type="button"
        aria-label={`Dearer at ${gradeText(grade)}`}
        className={btn}
        disabled={v >= range.max}
        onClick={() => store.setHandle(grade, stepValue(v, 1, range))}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/** "On the boards and the curve": the way's rows and tiers, and its hills. */
export function StructuredLines({ x, arc }: { x: EdgeExplanation; arc: ArcCostExplanation }) {
  const st = arc.structured;
  const [open, setOpen] = useState<string | null>(null);
  if (!st) return null;
  const toggle = (k: string) => setOpen(open === k ? null : k);
  const h = st.hills;
  const handle = h ? nearestHandle(h.wall_pct) : 10;
  return (
    <div data-testid="inspector-structured" className="mt-2.5">
      <div className={cn(label, "mb-0.5")}>On the boards and the curve</div>
      <ul>
        {st.boards.map((b) => (
          <Row
            key={b.board}
            row={b.row}
            tier={b.tier}
            factor={b.factor}
            open={open === b.row}
            onToggle={() => toggle(b.row)}
          />
        ))}
        {h && (
          <li data-testid="inspector-hills">
            <button
              type="button"
              onClick={() => toggle("hills")}
              aria-expanded={open === "hills"}
              className="flex w-full items-start gap-2 rounded-control px-1 py-1 text-left text-xs hover:bg-foreground/6"
            >
              <span className="min-w-0 flex-1">
                <b>Hills</b>: {hillsLine(x.length_m, h)}
              </span>
              {Math.abs(h.metres) >= 0.5 && (
                <span className="shrink-0 font-bold tabular-nums">
                  {h.metres > 0 ? "+" : "−"}
                  {metresText(Math.abs(h.metres))}
                </span>
              )}
              <ChevronDown
                className={cn(
                  "mt-px size-3.5 shrink-0 text-muted-foreground",
                  open === "hills" && "rotate-180",
                )}
              />
            </button>
            {open === "hills" && <HandleInPlace grade={handle} />}
          </li>
        )}
      </ul>
    </div>
  );
}

/** A way a board's Avoid closes: which row, and the tier picker to move it out (no slider can). */
export function AvoidedRow({ x }: { x: EdgeExplanation }) {
  const catalogue = usePlan((s) => s.catalogue);
  const closure = [...x.along.closed_by, ...x.against.closed_by].find(
    (c) => c.by === "avoided_surface" || c.by === "avoided_way",
  );
  const row = (typeof closure?.value === "string" ? closure.value : null) as BoardRow | null;
  const store = usePlanner();
  const spread = usePlan((s) => s.structured?.spread ?? 1);
  if (!closure || !row) return null;
  return (
    <div data-testid="inspector-avoided">
      <p className="mt-1 font-semibold text-xs leading-snug" data-testid="inspector-noslider">
        “{rowLabel(row, catalogue)}” is on Avoid: only moving it out of Avoid opens it.
      </p>
      <div className="mt-2" data-testid="inspector-tier">
        <TierPicker
          compact
          current="avoid"
          spread={spread}
          testid="inspector-tier"
          onPick={(t) => store.setRow(row, t)}
        />
      </div>
    </div>
  );
}
