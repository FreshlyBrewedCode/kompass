// A tier board (direction A, "Lanes"; docs/design/steering-widgets.md): one lane per tier from Love
// down to Avoid, the board's rows as chips with the route's kilometres on them. Tap a chip, then pick
// its tier at the bottom of the board: one tap moves it. No drag between lanes: inside a scrolling
// sheet it fights the scroll (the design round's verdict), and tap-and-pick does everything.
import { cn } from "cn";
import { Lock, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { BoardId, BoardRow, Tier } from "@/engine/generated/types";
import { ChangeDot } from "../parts";
import { type PlanState, usePlan, usePlanner } from "../store";
import {
  BOARD_ROWS,
  type Board,
  boardSummary,
  exchangeSentence,
  LANES,
  rowLabel,
  rowM,
  TIER_LABEL,
  TIERS,
  tierRate,
  tierShort,
} from "./model";

const boardOfState = (s: PlanState, id: BoardId): Board | undefined =>
  s.structured?.boards[id] as Board | undefined;
const routeOf = (s: PlanState) => (s.main.error ? null : s.main.result);

/** "3.2 km", "350 m", "not on this route"; `null` without a route. */
export function rowKm(m: number | null): string | null {
  if (m === null) return null;
  if (m < 5) return "not on this route";
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** The collapsed glyph: the lanes in miniature, avoid on the left, one dot per row in its colour. */
export function TierGlyph({ id }: { id: BoardId }) {
  const board = usePlan((s) => boardOfState(s, id));
  if (!board) return null;
  return (
    <span className="flex shrink-0 gap-0.5" aria-hidden="true" data-testid={`tier-glyph-${id}`}>
      {TIERS.map((t) => {
        const rows = BOARD_ROWS[id].filter((r) => board[r] === t);
        return (
          <span
            key={t}
            className={cn(
              "flex h-3.5 min-w-3.5 items-center justify-center gap-0.5 rounded-[4px] px-[3px]",
              t === "avoid" ? "kp-hatch bg-card ring-1 ring-input ring-inset" : "bg-muted",
            )}
          >
            {rows.map((r) => (
              <i key={r} className="size-1.5 rounded-full" style={{ background: `var(--row-${r})` }} />
            ))}
          </span>
        );
      })}
    </span>
  );
}

export const boardLine = (board: Board | undefined, id: BoardId) => (board ? boardSummary(board, id) : "");

/** The five tiers as buttons, worst to best; the current one in ink. One tap moves the row. */
export function TierPicker({
  current,
  onPick,
  spread,
  compact,
  testid = "tier-pick",
}: {
  current: Tier | undefined;
  onPick: (t: Tier) => void;
  spread: number;
  compact?: boolean;
  testid?: string;
}) {
  return (
    <fieldset className="m-0 grid min-w-0 grid-cols-5 gap-1 border-0 p-0" aria-label="Tier">
      {TIERS.map((t) => (
        <button
          type="button"
          key={t}
          aria-pressed={current === t}
          data-testid={`${testid}-${t}`}
          onClick={() => onPick(t)}
          className={cn(
            "flex flex-col items-center justify-center rounded-control font-bold text-xs leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring",
            compact ? "h-11" : "h-[50px]",
            current === t
              ? "bg-primary text-primary-foreground"
              : t === "avoid"
                ? "kp-hatch bg-card ring-1 ring-input ring-inset"
                : "bg-muted hover:bg-foreground/12",
          )}
        >
          {TIER_LABEL[t]}
          <small
            className={cn(
              "font-medium text-2xs",
              current === t ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {tierShort(t, spread)}
          </small>
        </button>
      ))}
    </fieldset>
  );
}

function Chip({
  row,
  tier,
  selected,
  onTap,
}: {
  row: BoardRow;
  tier: Tier;
  selected: boolean;
  onTap: () => void;
}) {
  const catalogue = usePlan((s) => s.catalogue);
  const m = usePlan((s) => rowM(routeOf(s), row));
  const changed = usePlan((s) => s.changes.some((c) => c.id === `row:${row}`));
  const name = rowLabel(row, catalogue);
  const km = rowKm(m);
  return (
    <button
      type="button"
      data-testid={`tier-chip-${row}`}
      data-tier={tier}
      aria-pressed={selected}
      aria-label={`${name}: ${TIER_LABEL[tier]}${km ? `, ${km}` : ""}. Pick a tier`}
      onClick={onTap}
      className={cn(
        "flex h-10 max-w-full items-center gap-1.5 rounded-full bg-card pr-3 pl-2.5 font-semibold text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "shadow-float ring-2 ring-foreground" : "shadow-[0_1px_2px_rgb(0_0_0/0.1)]",
        tier === "avoid" && !selected && "shadow-none ring-1 ring-input",
      )}
    >
      {tier === "avoid" && <Lock className="size-3.5 shrink-0" />}
      <i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: `var(--row-${row})` }} />
      <span className="truncate">{name}</span>
      {km && (
        <small
          className={cn(
            "shrink-0 font-medium text-2xs text-muted-foreground tabular-nums",
            m !== null && m < 5 && "font-normal",
          )}
        >
          {km}
        </small>
      )}
      {changed && (
        <i className="size-1.5 shrink-0 rounded-full bg-signal" title="Changed against the preset" />
      )}
    </button>
  );
}

/** The lanes and, with a chip selected, the tier picker under them; the exchange sentence last. */
export function TierBoard({ id, children }: { id: BoardId; children?: ReactNode }) {
  const store = usePlanner();
  const board = usePlan((s) => boardOfState(s, id));
  const spread = usePlan((s) => s.structured?.spread ?? 1);
  const catalogue = usePlan((s) => s.catalogue);
  const kms = usePlan((s) => (routeOf(s) ? s.main.result : null));
  const [selected, setSelected] = useState<BoardRow | null>(null);
  const selectedM = usePlan((s) => (selected ? rowM(routeOf(s), selected) : null));
  const baseTier = usePlan((s) =>
    selected ? (s.baseParts?.boards[id] as Board | undefined)?.[selected] : undefined,
  );
  if (!board) return null;
  const km = (r: BoardRow) => kms?.breakdown.rows?.find((p) => p.key === r)?.length_m ?? 0;
  const tier = selected ? board[selected] : undefined;
  const s = exchangeSentence(spread);
  return (
    <div data-testid={`tier-board-${id}`} className="space-y-1 pb-2">
      {LANES.map((t) => {
        const rows = BOARD_ROWS[id].filter((r) => board[r] === t).sort((a, b) => km(b) - km(a));
        return (
          <div
            key={t}
            data-testid={`tier-lane-${t}`}
            className={cn(
              "flex gap-2 rounded-control py-1.5 pr-1.5 pl-2.5",
              t === "avoid" ? "kp-hatch bg-card ring-1 ring-input ring-inset" : "bg-muted",
            )}
          >
            <div className="w-[74px] shrink-0 pt-1">
              <b className="block text-[13px] leading-[17px]">{TIER_LABEL[t]}</b>
              <span className="block text-[10.5px] text-muted-foreground leading-[14px]">
                {tierRate(t, spread)}
              </span>
            </div>
            <div className="flex min-h-10 min-w-0 flex-1 flex-wrap content-start gap-1">
              {rows.map((r) => (
                <Chip
                  key={r}
                  row={r}
                  tier={t}
                  selected={selected === r}
                  onTap={() => setSelected(selected === r ? null : r)}
                />
              ))}
            </div>
          </div>
        );
      })}
      {selected && (
        <div className="my-2 rounded-card bg-card p-2.5 shadow-float" data-testid="tier-picker">
          <div className="mx-0.5 mb-2 flex min-h-6 items-center gap-1.5 text-[13px]">
            <i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: `var(--row-${selected})` }} />
            <b className="truncate">{rowLabel(selected, catalogue)}</b>
            <span className="min-w-0 truncate text-muted-foreground text-xs">
              {selectedM !== null && selectedM >= 5 ? `${rowKm(selectedM)} of this route · ` : ""}pick a tier:
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2.5">
              <ChangeDot
                on={baseTier !== undefined && baseTier !== tier}
                onClick={() => store.resetRow(selected)}
              />
              <button
                type="button"
                aria-label="Done"
                data-testid="tier-picker-close"
                onClick={() => setSelected(null)}
                className="grid size-8 place-items-center rounded-full bg-foreground/8 hover:bg-foreground/12"
              >
                <X className="size-3.5" />
              </button>
            </span>
          </div>
          <TierPicker current={tier} spread={spread} onPick={(t) => store.setRow(selected, t)} />
        </div>
      )}
      <p className="rounded-control bg-muted px-3 py-2 text-[13px] leading-snug" data-testid="tier-exchange">
        {s.lead}
        <b>{s.strong}</b>
        {s.tail}
      </p>
      {children}
    </div>
  );
}
