// The planner's shared components (docs/design/planner.md, "Components"): every one of them is used at
// every breakpoint; shell.tsx only arranges them. Ported from the design sandbox
// (design/planner/src/round3/parts.tsx) and wired to the planner store. The chrome is neutral: ink,
// greys and the one accent (`signal`) for the primary action and "changed from the base"; anything
// else that is coloured is data (palette.ts).

import { cn } from "cn";
import {
  ArrowDownUp,
  ArrowUp,
  Bookmark,
  Car,
  Check,
  ChevronDown,
  Crosshair,
  Download,
  Footprints,
  Grid3x3,
  GripVertical,
  History,
  Lock,
  type LucideIcon,
  Minus,
  Mountain,
  Pencil,
  Plus,
  RotateCcw,
  Route as RouteIcon,
  Search,
  Signpost,
  Sparkles,
  Trash2,
  Trees,
  TriangleAlert,
  X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { Group, LimitId, PrefId, RouteResult } from "@/engine/generated/types";
import { useEngine } from "@/engine/use-engine";
import { exportGpx, gpxFilename, routeToGpx } from "./gpx";
import {
  compareRows,
  deltas,
  elevationProfile,
  fmtKm,
  fmtTime,
  limitNumber,
  limitState,
  presetName,
  SURFACE_GROUP,
  surfaceShares,
  tradeoff,
  WAY_GROUP,
  waypointLabel,
  waypointMetres,
  wayShares,
  weightWord,
} from "./model";
import { SURFACE, WAY } from "./palette";
import { type PlanState, usePlan, usePlanner } from "./store";

/** A card floating over the map. */
export const card = "rounded-card border border-border bg-glass shadow-float backdrop-blur-xl";
/** A section label. */
export const label = "text-2xs font-bold uppercase tracking-wider text-muted-foreground";
export const pill = "flex shrink-0 items-center gap-1.5 rounded-full text-xs font-semibold";
const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
const GROUP_ICON: Record<Group, LucideIcon> = {
  surface: Grid3x3,
  ways: RouteIcon,
  traffic: Car,
  landscape: Trees,
  terrain: Mountain,
  signs: Signpost,
  trail: Footprints,
  history: History,
};

export function IconButton({
  label: text,
  onClick,
  children,
  className,
  on,
  testid,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  on?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      onClick={onClick}
      data-testid={testid}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-foreground text-background" : "bg-foreground/8 hover:bg-foreground/12",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Something planned for later: visible room, not built. */
export function Soon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      title="Later: not built yet"
      aria-disabled="true"
      className={cn(
        "inline-flex cursor-not-allowed items-center gap-1.5 whitespace-nowrap rounded-full border border-current/30 border-dashed px-2.5 py-1 font-medium text-muted-foreground text-xs",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The Kompass mark: a compass needle in a ring; the needle is the accent. */
export function Mark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {[0, 90, 180, 270].map((a) => (
        <line
          key={a}
          x1="12"
          y1="1.75"
          x2="12"
          y2="4"
          stroke="currentColor"
          strokeWidth="1.5"
          transform={`rotate(${a} 12 12)`}
        />
      ))}
      <g transform="rotate(38 12 12)">
        <path d="M12 4.6 14.6 12H9.4Z" fill="var(--signal)" />
        <path d="M12 19.4 9.4 12h5.2Z" fill="currentColor" fillOpacity="0.35" />
      </g>
    </svg>
  );
}

// ------------------------------------------------------------------ sliders, limits

/**
 * The slider: neutral in the middle, left avoids, right seeks. Direction is told by position and by
 * the word beside the label, never by colour: the fill is ink. The ring is the base profile's value.
 */
export function Dial({
  value,
  base,
  onChange,
  onGrab,
  onRelease,
  name,
  word,
}: {
  value: number;
  base?: number | undefined;
  onChange: (v: number) => void;
  onGrab?: () => void;
  onRelease?: () => void;
  name: string;
  word: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  const PAD = 12;
  const at = (x: number) => {
    const r = (ref.current as HTMLDivElement).getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (x - r.left - PAD) / (r.width - 2 * PAD)));
    return f * 200 - 100;
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
      aria-label={name}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${signed(value)}, ${word}`}
      data-testid={`dial-${name}`}
      className="relative h-7 w-full cursor-pointer touch-pan-y select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={(e) => {
        const step = e.shiftKey ? 25 : 5;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(Math.max(-100, value - step));
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(Math.min(100, value + step));
        else if (e.key === "Home") onChange(-100);
        else if (e.key === "End") onChange(100);
        else return;
        e.preventDefault();
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
      onLostPointerCapture={drop}
    >
      <div
        className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-track"
        style={{ left: PAD, right: PAD }}
      >
        <i
          className="absolute inset-y-0 rounded-full bg-foreground"
          style={{ left: `${(Math.min(value, 0) + 100) / 2}%`, width: `${Math.abs(value) / 2}%` }}
        />
        <i className="absolute top-1/2 left-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40" />
        {base !== undefined && base !== value && (
          <i
            title="The base profile's value"
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-muted-foreground bg-card"
            style={{ left: `${(base + 100) / 2}%` }}
          />
        )}
        <i
          className="absolute top-1/2 size-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-card shadow-[0_1px_4px_rgb(0_0_0/0.25)]"
          style={{ left: `${(value + 100) / 2}%` }}
        />
      </div>
    </div>
  );
}

/** The marker of "changed against the base": the accent's main job. Tap it to put the row back. */
function ChangeDot({ on, onClick }: { on: boolean; onClick: () => void }) {
  if (!on) return null;
  return (
    <button
      type="button"
      title="Changed against the base. Tap to put it back."
      aria-label="Back to the base value"
      data-testid="change-dot"
      onClick={onClick}
      className="-m-2.5 grid size-7 shrink-0 place-items-center"
    >
      <i className="size-[7px] rounded-full bg-signal" />
    </button>
  );
}
const Tag = ({ children }: { children: ReactNode }) => (
  <span className="shrink-0 rounded-full border border-border px-1.5 font-semibold text-2xs text-muted-foreground">
    {children}
  </span>
);

const isChanged = (s: PlanState, id: string) => s.changes.some((c) => c.id === id);

/** One soft preference: avoid ↔ seek. */
export function PrefRow({
  id,
  held,
  onGrab,
  onRelease,
}: {
  id: PrefId;
  held?: boolean;
  onGrab?: (id: string) => void;
  onRelease?: () => void;
}) {
  const store = usePlanner();
  const v = usePlan((s) => s.weights[id] ?? 0);
  const b = usePlan((s) => s.baseWeights[id]);
  const pref = usePlan((s) => s.catalogue?.preferences.find((p) => p.id === id));
  const core = usePlan((s) => s.catalogue?.core.includes(id) ?? false);
  const changed = usePlan((s) => isChanged(s, id));
  const fresh = usePlan((s) => s.fresh === id);
  const name = pref?.label ?? id;
  const word = weightWord(pref, v);
  return (
    <div
      data-row
      data-held={held || undefined}
      data-testid={`pref-${id}`}
      className={cn("rounded-control px-1 pt-1", fresh && "kp-flash")}
    >
      <div className="flex h-5 items-center gap-1.5">
        <ChangeDot on={changed} onClick={() => store.resetPref(id)} />
        <span className="min-w-0 truncate font-semibold text-sm">{name}</span>
        {b === undefined && !core && <Tag>added</Tag>}
        <span className="ml-auto shrink-0 whitespace-nowrap font-medium text-muted-foreground text-xs">
          {word}
        </span>
        <span className="w-8 shrink-0 text-right font-bold text-xs tabular-nums" data-testid="pref-value">
          {signed(v)}
        </span>
        {!core && (
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={() => store.removePref(id)}
            className="-mr-1.5 grid size-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <Dial
        name={name}
        word={word}
        value={v}
        base={b ?? (core ? 0 : undefined)}
        onChange={(x) => store.setWeight(id, x)}
        onGrab={() => onGrab?.(id)}
        {...(onRelease ? { onRelease } : {})}
      />
    </div>
  );
}

export function Switch({
  on,
  onClick,
  name,
  testid,
}: {
  on: boolean;
  onClick: () => void;
  name: string;
  testid?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        on ? "bg-foreground" : "bg-track",
      )}
    >
      <i
        className={cn(
          "absolute top-0.5 size-5 rounded-full shadow transition-all motion-reduce:transition-none",
          on ? "left-[18px] bg-background" : "left-0.5 bg-card",
        )}
      />
    </button>
  );
}

/** One hard limit: a lock and a switch, with a stepper where it carries a number. Never a slider. */
export function LimitRow({ id }: { id: LimitId }) {
  const store = usePlanner();
  const def = usePlan((s) => s.catalogue?.limits.find((l) => l.id === id));
  const raw = usePlan((s) => s.limits[id]);
  const b = usePlan((s) => s.baseLimits[id]);
  const changed = usePlan((s) => isChanged(s, id));
  const fresh = usePlan((s) => s.fresh === id);
  const blamed = usePlan((s) => !!s.main.error && s.blame?.limit === id);
  const v = limitState(def, raw);
  const on = v !== null;
  const par = def?.number;
  const name = def?.label ?? id;
  const step = (d: number) =>
    par &&
    typeof v === "number" &&
    store.setLimit(id, Math.max(par.min, Math.min(par.max, v + d * par.step)));
  return (
    <div
      data-row
      data-testid={`limit-${id}`}
      className={cn("flex min-h-11 items-center gap-2 rounded-control px-1", fresh && "kp-flash")}
    >
      <ChangeDot on={changed} onClick={() => store.resetLimit(id)} />
      <Lock className={cn("size-3.5 shrink-0", !on && "text-muted-foreground/60")} />
      <span
        className={cn("min-w-0 flex-1 font-semibold text-sm", !on && "text-muted-foreground line-through")}
      >
        <span className="line-clamp-2">{name}</span>
        {blamed && (
          <span
            className="block font-medium text-muted-foreground text-xs no-underline"
            data-testid="limit-blocks"
          >
            blocks the route
          </span>
        )}
      </span>
      {par && typeof v === "number" && (
        <span className="flex h-8 shrink-0 items-center rounded-full bg-foreground/8 font-bold text-xs tabular-nums">
          <button
            type="button"
            aria-label={`Lower ${name}`}
            onClick={() => step(-1)}
            className="grid size-8 place-items-center"
          >
            <Minus className="size-3.5" />
          </button>
          <span className="min-w-9 text-center">{limitNumber(def, v)}</span>
          <button
            type="button"
            aria-label={`Raise ${name}`}
            onClick={() => step(1)}
            className="grid size-8 place-items-center"
          >
            <Plus className="size-3.5" />
          </button>
        </span>
      )}
      <Switch
        on={on}
        name={name}
        testid={`limit-switch-${id}`}
        onClick={() => store.setLimit(id, on ? null : (limitState(def, b) ?? par?.default ?? true))}
      />
    </div>
  );
}

export function AddButton() {
  const store = usePlanner();
  const count = usePlan((s) =>
    s.catalogue ? s.catalogue.preferences.length + s.catalogue.limits.length : 0,
  );
  return (
    <button
      type="button"
      data-testid="add-preference"
      onClick={() => store.setPicker(true)}
      className="flex h-11 w-full items-center gap-2 rounded-control border border-foreground/30 border-dashed px-3 font-semibold text-sm hover:border-foreground/60"
    >
      <Plus className="size-4" />
      Add a preference or limit
      <span className="ml-auto font-medium text-muted-foreground text-xs">{count} in this region</span>
    </button>
  );
}

/** The whole profile as a list: sliders, add, limits. */
export function ProfileList({
  held,
  onGrab,
  onRelease,
}: {
  held?: string | null;
  onGrab?: (id: string) => void;
  onRelease?: () => void;
}) {
  const prefIds = usePlan((s) => s.prefIds);
  const limitIds = usePlan((s) => s.limitIds);
  return (
    <div>
      <div
        data-fade
        className="flex justify-between px-3 font-semibold text-2xs text-muted-foreground uppercase tracking-wider"
      >
        <span>← avoid</span>
        <span>no opinion</span>
        <span>seek →</span>
      </div>
      <div className="space-y-0.5">
        {prefIds.map((id) => (
          <PrefRow
            key={id}
            id={id}
            held={held === id}
            {...(onGrab ? { onGrab } : {})}
            {...(onRelease ? { onRelease } : {})}
          />
        ))}
      </div>
      <div data-fade className="mt-2">
        <AddButton />
      </div>
      <div data-fade id="kp-limits" className="mt-4">
        <div className={cn(label, "flex items-center gap-1.5")}>
          <Lock className="size-3" />
          Limits · never broken
        </div>
        {limitIds.map((id) => (
          <LimitRow key={id} id={id} />
        ))}
        {limitIds.length === 0 && (
          <p className="py-2 text-muted-foreground text-xs">None. Add one from the picker.</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ base profile, diff, preset

function BaseChooser({ onPicked }: { onPicked: () => void }) {
  const store = usePlanner();
  const presets = usePlan((s) => s.presets);
  const baseId = usePlan((s) => s.baseId);
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="base-chooser">
      {presets.map((p) => (
        <button
          type="button"
          key={p.id}
          title={p.blurb}
          data-testid={`base-${p.id}`}
          onClick={() => {
            store.setBase(p.id);
            onPicked();
          }}
          className={cn(
            pill,
            "h-9 border px-3",
            p.id === baseId
              ? "border-foreground bg-foreground text-background"
              : "border-border hover:border-foreground/40",
          )}
        >
          {p.own && <Bookmark className="size-3" />}
          {presetName(p)}
        </button>
      ))}
      <Soon className="h-9">Learn from my rides</Soon>
    </div>
  );
}

/**
 * The head of the profile: "Gravel explorer · 2 changes", the changes in words, save as preset,
 * reset. The name opens the base chooser in place. An own preset can be renamed and deleted here.
 */
export function DiffBar() {
  const store = usePlanner();
  const base = usePlan((s) => s.base);
  const n = usePlan((s) => s.changes.length);
  const sentence = usePlan((s) => s.sentence);
  const [choosing, setChoosing] = useState(false);
  const [naming, setNaming] = useState<"save" | "rename" | null>(null);
  const [name, setName] = useState("");
  const baseName = presetName(base);
  const submit = () => {
    if (naming === "save") store.savePreset(name.trim() || `${baseName} +`);
    else if (naming === "rename" && base) store.renamePreset(base.id, name);
    setNaming(null);
    setName("");
  };
  return (
    <div className="rounded-control bg-foreground/[0.055] p-3" data-testid="diff-bar">
      <div className="flex min-h-6 items-center gap-1.5 text-sm">
        <button
          type="button"
          aria-expanded={choosing}
          aria-label={`Base profile: ${baseName}. Choose another`}
          data-testid="base-name"
          onClick={() => setChoosing(!choosing)}
          className="flex min-w-0 items-center gap-0.5 font-bold"
        >
          {base?.own && <Bookmark className="mr-1 size-3.5 shrink-0" />}
          <span className="truncate">{baseName}</span>
          <ChevronDown className={cn("size-4 shrink-0 transition-transform", choosing && "rotate-180")} />
        </button>
        {n > 0 && <i className="size-[7px] shrink-0 rounded-full bg-signal" />}
        <span
          className="shrink-0 whitespace-nowrap font-medium text-muted-foreground"
          data-testid="change-count"
        >
          {n === 0 ? "· as it comes" : `${n} change${n > 1 ? "s" : ""}`}
        </span>
      </div>
      {choosing && (
        <div className="mt-2 mb-1">
          <BaseChooser onPicked={() => setChoosing(false)} />
        </div>
      )}
      <p className="mt-0.5 text-muted-foreground text-xs leading-snug" data-testid="change-sentence">
        {n ? sentence : base?.blurb}
      </p>
      {!naming && (n > 0 || base?.own) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {n > 0 && (
            <>
              <button
                type="button"
                data-testid="save-preset"
                onClick={() => setNaming("save")}
                className={cn(pill, "h-9 border border-foreground/25 px-3 hover:border-foreground")}
              >
                <Bookmark className="size-3.5" />
                Save as preset
              </button>
              <button
                type="button"
                data-testid="reset-profile"
                onClick={() => store.reset()}
                className={cn(pill, "h-9 px-2.5 text-muted-foreground hover:text-foreground")}
              >
                <RotateCcw className="size-3.5" />
                Reset
              </button>
            </>
          )}
          {n === 0 && base?.own && (
            <>
              <button
                type="button"
                data-testid="rename-preset"
                onClick={() => {
                  setName(baseName);
                  setNaming("rename");
                }}
                className={cn(pill, "h-9 border border-foreground/25 px-3 hover:border-foreground")}
              >
                <Pencil className="size-3.5" />
                Rename
              </button>
              <button
                type="button"
                data-testid="delete-preset"
                onClick={() => store.deletePreset(base.id)}
                className={cn(pill, "h-9 px-2.5 text-muted-foreground hover:text-foreground")}
              >
                <Trash2 className="size-3.5" />
                Delete preset
              </button>
            </>
          )}
        </div>
      )}
      {naming && (
        <form
          className="mt-2.5 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because the user asked for it
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${baseName} +`}
            aria-label="Preset name"
            data-testid="preset-name"
            maxLength={40}
            className="h-9 min-w-0 flex-1 rounded-full border border-input bg-card px-3.5 font-semibold text-base outline-none focus:border-foreground sm:text-sm"
          />
          <button
            type="submit"
            data-testid="preset-save"
            className={cn(pill, "h-9 bg-foreground px-4 text-background")}
          >
            {naming === "save" ? "Save" : "Rename"}
          </button>
          <button
            type="button"
            onClick={() => setNaming(null)}
            className={cn(pill, "h-9 px-2 text-muted-foreground")}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ picker

type Item = {
  kind: "pref" | "limit";
  id: PrefId | LimitId;
  group: Group;
  label: string;
  hint: string;
  note?: string;
  has: boolean;
};

/** The catalogue: every preference and limit the engine knows. Search first, grouped below; a tap adds. */
export function Picker({ className }: { className?: string }) {
  const store = usePlanner();
  const catalogue = usePlan((s) => s.catalogue);
  const weights = usePlan((s) => s.weights);
  const limits = usePlan((s) => s.limits);
  const [q, setQ] = useState("");
  if (!catalogue) return null;
  const coverage = (share: number | undefined, note: string | undefined, personal: boolean) => {
    if (personal) return "Needs your imported rides.";
    if (share !== undefined && share < 0.6)
      return `Mapped on ${Math.max(1, Math.round(share * 100))}\u00a0% of this region.`;
    return note && share === undefined ? undefined : undefined;
  };
  const all: Item[] = [
    ...catalogue.preferences.map((p) => {
      const note = coverage(p.coverage?.share, p.coverage?.note, p.personal);
      return {
        kind: "pref" as const,
        id: p.id,
        group: p.group,
        label: p.label,
        hint: p.hint,
        ...(note ? { note } : {}),
        has: p.id in weights || catalogue.core.includes(p.id),
      };
    }),
    ...catalogue.limits.map((l) => ({
      kind: "limit" as const,
      id: l.id,
      group: l.group,
      label: l.label,
      hint: l.hint,
      has: limits[l.id] !== undefined && limits[l.id] !== false,
    })),
  ];
  const needle = q.trim().toLowerCase();
  const groupLabel = (g: Group) => catalogue.groups.find((x) => x.id === g)?.label ?? g;
  const hit = (i: Item) =>
    !needle || `${i.label} ${i.hint} ${groupLabel(i.group)}`.toLowerCase().includes(needle);
  const groups = catalogue.groups
    .map((g) => ({ ...g, items: all.filter((i) => i.group === g.id && hit(i)) }))
    .filter((g) => g.items.length);
  return (
    <div className={cn("flex min-h-0 flex-col", className)} data-testid="picker">
      <div className="flex items-center gap-2 pb-2.5">
        <span className="font-extrabold text-base tracking-tight">Add a preference</span>
        <IconButton label="Close" onClick={() => store.setPicker(false)} className="ml-auto">
          <X className="size-4" />
        </IconButton>
      </div>
      <label className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-input bg-card px-4 focus-within:border-foreground">
        <Search className="size-4 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search: forest, cobbles, traffic…"
          aria-label="Search preferences"
          data-testid="picker-search"
          className="min-w-0 flex-1 bg-transparent font-medium text-base outline-none sm:text-sm"
        />
        {q && (
          <button type="button" aria-label="Clear the search" onClick={() => setQ("")}>
            <X className="size-4 text-muted-foreground" />
          </button>
        )}
      </label>
      <div className="thin-scroll -mx-1 mt-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {groups.length === 0 && (
          <p className="px-2 py-8 text-center text-muted-foreground text-sm">
            Nothing in the catalogue matches “{q}”.
          </p>
        )}
        {groups.map((g) => {
          const Icon = GROUP_ICON[g.id];
          return (
            <div key={g.id}>
              <div className={cn(label, "flex items-center gap-1.5 px-2 pt-3.5 pb-0.5")}>
                <Icon className="size-3.5" />
                {g.label}
                <span className="font-medium normal-case tracking-normal">· {g.blurb}</span>
              </div>
              {g.items.map((i) => (
                <button
                  type="button"
                  key={i.id}
                  disabled={i.has}
                  data-testid={`pick-${i.id}`}
                  onClick={() =>
                    i.kind === "pref" ? store.addPref(i.id as PrefId) : store.addLimit(i.id as LimitId)
                  }
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-control px-2 py-1.5 text-left hover:bg-foreground/6",
                    i.has && "opacity-45",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-semibold text-sm">
                      {i.kind === "limit" && <Lock className="size-3.5 shrink-0" />}
                      <span className="truncate">{i.label}</span>
                      {i.kind === "limit" && <Tag>limit</Tag>}
                    </span>
                    <span className="block text-muted-foreground text-xs leading-snug">
                      {i.hint}
                      {i.note ? ` ${i.note}` : ""}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-full",
                      i.has ? "text-muted-foreground" : "bg-foreground/8",
                    )}
                  >
                    {i.has ? <Check className="size-4" /> : <Plus className="size-4" />}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ route: totals, timeline, stops

/** Distance, climb, time. Dimmed while the engine takes its time. */
export function Stats({ size = "lg", className }: { size?: "lg" | "sm"; className?: string }) {
  const r = usePlan((s) => (s.main.error ? null : s.main.result));
  const routing = usePlan((s) => s.routing);
  const items: [string, string][] = r
    ? [
        [fmtKm(r.summary.distance_m), "km"],
        [String(Math.round(r.summary.ascent_m)), "m ↑"],
        [fmtTime(r.summary.duration_s), "h"],
      ]
    : [
        ["–", "km"],
        ["–", "m ↑"],
        ["–:––", "h"],
      ];
  return (
    <div
      data-testid="stats"
      className={cn("flex items-baseline gap-x-3.5 transition-opacity", routing && "opacity-45", className)}
    >
      {items.map(([v, u]) => (
        <div key={u} className="whitespace-nowrap leading-none">
          <span
            className={cn("font-bold tabular-nums tracking-tight", size === "lg" ? "text-2xl" : "text-lg")}
            data-testid={`stat-${u === "km" ? "km" : u === "h" ? "time" : "climb"}`}
          >
            {v}
          </span>
          <span className="ml-0.5 text-muted-foreground text-xs">{u}</span>
        </div>
      ))}
    </div>
  );
}

export function BusyBar() {
  const routing = usePlan((s) => s.routing);
  if (!routing) return null;
  return (
    <div className="mt-2 flex items-center gap-2 text-muted-foreground text-xs" data-testid="routing">
      <span className="kp-busy h-[3px] flex-1 rounded-full bg-track" />
      Routing…
    </div>
  );
}

const DashKey = () => (
  <svg width="18" height="4" aria-hidden="true" className="shrink-0">
    <line x1="0" y1="2" x2="18" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray="4 2.5" />
  </svg>
);

/** What the changes cost and bought against the base profile's route (the dashed line). Numbers, in ink. */
export function DeltaLine({ max, className }: { max?: number; className?: string }) {
  const changed = usePlan((s) => s.changed && !s.compareId && !s.main.error);
  const main = usePlan((s) => s.main.result);
  const ghost = usePlan((s) => s.ghost.result);
  const moved = usePlan((s) => s.moved);
  if (!changed || !main) return null;
  if (moved && moved.length === 0)
    return (
      <p className={cn("text-muted-foreground text-xs", className)} data-testid="delta-line">
        Your changes do not move the route yet.
      </p>
    );
  if (!ghost) return null;
  const all = deltas(main, ghost);
  if (all.length === 0) return null;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs tabular-nums", className)}
      data-testid="delta-line"
    >
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <DashKey />
        vs base
      </span>
      {all.slice(0, max).map((d) => (
        <span key={d} className="whitespace-nowrap font-semibold">
          {d}
        </span>
      ))}
    </div>
  );
}

type LaneBy = "surface" | "way" | "ridden";
const colorOf = (by: LaneBy, s: RouteResult["segments"][number]) =>
  by === "surface"
    ? `var(--surface-${SURFACE_GROUP[s.surface]})`
    : by === "way"
      ? `var(--way-${WAY_GROUP[s.way]})`
      : s.ridden
        ? "var(--ridden)"
        : null;

/** The route unrolled along its distance, coloured by one attribute (data colours). One SVG, runs merged. */
export function LaneStrip({
  route,
  by,
  maxM,
  className,
}: {
  route: RouteResult;
  by: LaneBy;
  maxM?: number;
  className?: string;
}) {
  const total = maxM ?? route.summary.distance_m;
  const runs: { x: number; w: number; color: string }[] = [];
  for (const s of route.segments) {
    const color = colorOf(by, s);
    const last = runs[runs.length - 1];
    if (!color) continue;
    if (last && last.color === color && Math.abs(last.x + last.w - s.start_m) < 1) last.w += s.length_m;
    else runs.push({ x: s.start_m, w: s.length_m, color });
  }
  return (
    <svg
      viewBox={`0 0 ${Math.max(1, total)} 1`}
      preserveAspectRatio="none"
      className={cn("block w-full overflow-hidden rounded-[3px] bg-track", className)}
      aria-hidden="true"
    >
      {runs.map((r) => (
        <rect key={r.x} x={r.x} width={r.w} y={0} height={1} fill={r.color} />
      ))}
    </svg>
  );
}

/** The elevation profile; the compared route as a second line. */
function Elevation({
  route,
  compare,
  height,
  marks,
}: {
  route: RouteResult;
  compare: RouteResult | null;
  height: number;
  marks: { m: number; label: string }[];
}) {
  const a = elevationProfile(route, 360);
  const b = compare ? elevationProfile(compare, 360) : [];
  if (a.length < 2)
    return (
      <div style={{ height }} className="grid place-items-center text-muted-foreground text-xs">
        No elevation data
      </div>
    );
  const all = [...a, ...b];
  const maxM = Math.max(route.summary.distance_m, compare?.summary.distance_m ?? 0);
  const lo = Math.floor(Math.min(...all.map((p) => p[1])) / 50) * 50;
  const hi = Math.max(lo + 50, Math.ceil(Math.max(...all.map((p) => p[1])) / 50) * 50);
  const W = 1000;
  const x = (m: number) => (m / maxM) * W;
  const y = (e: number) => height - 2 - ((e - lo) / (hi - lo)) * (height - 8);
  const path = (ps: [number, number][]) =>
    ps.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const last = a[a.length - 1] as [number, number];
  return (
    <div className="relative w-full select-none" style={{ height }}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
        role="img"
        aria-label="Elevation profile"
      >
        <path
          d={`${path(a)}L${x(last[0])},${height}L0,${height}Z`}
          fill="var(--foreground)"
          fillOpacity={0.07}
        />
        {b.length > 1 && (
          <path
            d={path(b)}
            fill="none"
            stroke="var(--route-alt)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={path(a)}
          fill="none"
          stroke="var(--foreground)"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {marks.map((m) => (
          <line
            key={m.label}
            x1={x(m.m)}
            x2={x(m.m)}
            y1={0}
            y2={height}
            stroke="currentColor"
            strokeOpacity={0.35}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <span className="absolute top-0 left-0 text-[10px] leading-none tabular-nums opacity-55">{hi} m</span>
      <span className="absolute right-0 bottom-0.5 text-[10px] leading-none tabular-nums opacity-55">
        {lo} m
      </span>
      {marks.map((m) => (
        <span
          key={m.label}
          className="absolute top-0 -translate-x-1/2 rounded-sm bg-foreground px-1 font-semibold text-[9px] text-background leading-[13px]"
          style={{ left: `${(m.m / maxM) * 100}%` }}
        >
          {m.label}
        </span>
      ))}
    </div>
  );
}

const SURFACE_LABEL = Object.fromEntries(SURFACE.map((s) => [s.key, s.label]));
const WAY_LABEL = Object.fromEntries(WAY.map((s) => [s.key, s.label]));

/**
 * The timeline: elevation over lanes for surface, way type and (with a personal layer) ridden, plus
 * the stretches the changes moved. Drag across it to follow on the map.
 */
export function Lanes({ height = 48, className }: { height?: number; className?: string }) {
  const store = usePlanner();
  const r = usePlan((s) => (s.main.error ? null : s.main.result));
  const compare = usePlan((s) => (s.compareId ? s.compare.result : null));
  const moved = usePlan((s) => (s.compareId || !s.changed ? null : s.moved));
  const [at, setAt] = useState<number | null>(null);
  if (!r) return null;
  const total = r.summary.distance_m;
  const maxM = Math.max(total, compare?.summary.distance_m ?? 0);
  const wm = waypointMetres(r);
  const marks = wm.slice(1, -1).map((m, i) => ({ m, label: String(i + 1) }));
  const ridden = r.segments.some((s) => s.ridden !== undefined);
  const scrub = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    const m = Math.max(0, Math.min(total, ((e.clientX - b.left) / b.width) * maxM));
    setAt(m);
    store.setCursor(m);
  };
  const leave = () => {
    setAt(null);
    store.setCursor(null);
  };
  const seg =
    at === null
      ? null
      : (r.segments.find((s) => s.start_m + s.length_m >= at) ?? r.segments[r.segments.length - 1]);
  const ele = at === null ? null : (elevationProfile(r, 2000).find((p) => p[0] >= at)?.[1] ?? null);
  const lanes: [LaneBy, string][] = [
    ["surface", "Surface"],
    ["way", "Way"],
    ...(ridden ? ([["ridden", "Ridden"]] as [LaneBy, string][]) : []),
  ];
  return (
    <div className={className} data-testid="lanes">
      <div
        className="touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? scrub(e) : undefined)}
        onPointerUp={(e) => e.pointerType !== "mouse" && leave()}
        onPointerLeave={(e) => e.pointerType === "mouse" && leave()}
      >
        <div className={cn(label, "relative grid grid-cols-[52px_1fr] items-center gap-x-2 gap-y-1")}>
          <span>Climb</span>
          <div className="relative font-normal text-foreground normal-case tracking-normal">
            <Elevation route={r} compare={compare} height={height} marks={marks} />
            {at !== null && (
              <i
                className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--route)]"
                style={{ left: `${(at / maxM) * 100}%` }}
              />
            )}
          </div>
          {lanes.map(([by, name]) => (
            <div key={by} className="contents">
              <span>{name}</span>
              <LaneStrip route={r} by={by} maxM={maxM} className="h-2" />
            </div>
          ))}
          {moved && moved.length > 0 && (
            <div className="contents">
              <span className="flex items-center gap-1 text-foreground">
                <i className="size-[6px] rounded-full bg-signal" />
                Moved
              </span>
              <div className="relative h-1" data-testid="moved-lane">
                {moved.map((s) => (
                  <i
                    key={s.startM}
                    title="Differs from the base profile's route"
                    className="absolute inset-y-0 rounded-full bg-signal"
                    style={{
                      left: `${(s.startM / maxM) * 100}%`,
                      width: `${Math.max(0.6, (s.lengthM / maxM) * 100)}%`,
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="mt-1.5 h-4 truncate pl-[60px] text-muted-foreground text-xs tabular-nums">
        {at !== null && seg ? (
          <span>
            <b className="text-foreground">{fmtKm(at)} km</b>
            {ele !== null ? ` · ${Math.round(ele)} m` : ""} · {SURFACE_LABEL[SURFACE_GROUP[seg.surface]]} ·{" "}
            {WAY_LABEL[WAY_GROUP[seg.way]]}
            {seg.ridden === false ? " · new to you" : ""}
          </span>
        ) : (
          <span className="flex justify-between">
            <span>0</span>
            <span>{moved?.length ? "marked: differs from the base" : "drag to follow on the map"}</span>
            <span>{fmtKm(maxM)} km</span>
          </span>
        )}
      </div>
    </div>
  );
}

const Swatch = ({ color, hatch }: { color: string; hatch?: boolean }) => (
  <i
    className="size-2 shrink-0 rounded-[2px]"
    style={{
      background: color,
      backgroundImage: hatch
        ? "repeating-linear-gradient(135deg, transparent 0 2px, rgb(0 0 0 / 0.3) 2px 3.5px)"
        : undefined,
    }}
  />
);

/** Both breakdowns as legends with shares: the lanes above are the bars. */
export function Shares({ className }: { className?: string }) {
  const r = usePlan((s) => (s.main.error ? null : s.main.result));
  if (!r) return null;
  const total = r.summary.distance_m || 1;
  const pct = (m: number) => Math.round((m / total) * 100);
  const line = (defs: { key: string; label: string }[], vals: Record<string, number>, prefix: string) => (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      {defs
        .filter((d) => (vals[d.key] ?? 0) / total >= 0.015)
        .map((d) => (
          <span key={d.key} className="inline-flex items-center gap-1 whitespace-nowrap">
            <Swatch color={`var(--${prefix}-${d.key})`} hatch={d.key === "unknown"} />
            {d.label} <b className="text-foreground tabular-nums">{pct(vals[d.key] ?? 0)}%</b>
          </span>
        ))}
    </div>
  );
  const ridden = r.breakdown.ridden;
  return (
    <div className={cn("space-y-1 text-muted-foreground text-xs", className)} data-testid="shares">
      {line(SURFACE, surfaceShares(r), "surface")}
      {line(WAY, wayShares(r), "way")}
      {ridden && (
        <div className="inline-flex items-center gap-1">
          <Swatch color="var(--ridden)" />
          Ridden before{" "}
          <b className="text-foreground tabular-nums">{100 - Math.round(ridden.new_share * 100)}%</b>
          <span>· {fmtKm(ridden.new_m)} km new to you</span>
        </div>
      )}
    </div>
  );
}

/** Pointer-drag reordering for a list of equal-height rows. */
function useReorder(rowHeight: number, move: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<{ index: number; dy: number } | null>(null);
  const handle = (index: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      let cur = index;
      let base = 0;
      setDrag({ index, dy: 0 });
      const target = e.currentTarget as HTMLElement;
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - y0 - base;
        const step = Math.round(dy / rowHeight);
        if (step !== 0) {
          move(cur, cur + step);
          cur += step;
          base += step * rowHeight;
          setDrag({ index: cur, dy: ev.clientY - y0 - base });
        } else setDrag({ index: cur, dy });
      };
      const onUp = () => {
        setDrag(null);
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") move(index, index - 1);
      else if (e.key === "ArrowDown") move(index, index + 1);
      else return;
      e.preventDefault();
    },
    style: { touchAction: "none" as const, cursor: "grab" },
  });
  return { drag, handle };
}

/** The stops, reorderable (drag the grip, or arrow keys on it). Each leg has room for its own profile later. */
export function Waypoints() {
  const store = usePlanner();
  const waypoints = usePlan((s) => s.waypoints);
  const legs = usePlan((s) =>
    s.main.result && s.main.result.legs.length === s.waypoints.length - 1 ? s.main.result.legs : null,
  );
  const ROW = 44;
  const { drag, handle } = useReorder(ROW, (from, to) => {
    if (to < 0 || to >= waypoints.length) return;
    store.reorderWaypoint(from, to);
  });
  const n = waypoints.length;
  return (
    <div data-testid="waypoints">
      <ol>
        {waypoints.map((w, i) => {
          const end = i === 0 || i === n - 1;
          const name = waypointLabel(w, i, n);
          const leg = legs?.[i];
          return (
            <li
              key={w.id}
              data-testid="waypoint-row"
              className={cn(
                "flex items-center gap-2.5 border-border border-t text-sm",
                drag?.index === i && "relative z-10 rounded-control bg-muted",
              )}
              style={{ height: ROW, transform: drag?.index === i ? `translateY(${drag.dy}px)` : undefined }}
            >
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full font-bold text-2xs",
                  end ? "bg-foreground text-background" : "border-[1.5px] border-foreground",
                )}
              >
                {i === 0 ? "A" : end ? "B" : i}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
              {leg && (
                <span className="text-muted-foreground text-xs tabular-nums">{fmtKm(leg.distance_m)} km</span>
              )}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                data-testid="waypoint-remove"
                onClick={() => store.removeWaypoint(w.id)}
                className="grid size-9 place-items-center text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Move ${name} (arrow keys)`}
                data-testid="waypoint-grip"
                className="grid size-9 place-items-center text-muted-foreground"
                {...handle(i)}
              >
                <GripVertical className="size-4" />
              </button>
            </li>
          );
        })}
      </ol>
      <p className="border-border border-t pt-2 text-muted-foreground text-xs">
        Tap the map to add a stop; drag a stop on the map to move it.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          data-testid="reverse"
          disabled={n < 2}
          onClick={() => store.reverse()}
          className={cn(pill, "h-9 border border-foreground/25 px-3 disabled:opacity-40")}
        >
          <ArrowDownUp className="size-3.5" />
          Reverse
        </button>
        <button
          type="button"
          data-testid="clear"
          disabled={n === 0}
          onClick={() => store.clearWaypoints()}
          className={cn(pill, "h-9 px-3 text-muted-foreground hover:text-foreground disabled:opacity-40")}
        >
          <Trash2 className="size-3.5" />
          Clear
        </button>
        <Soon className="h-9">Profile per leg</Soon>
        <Soon className="h-9">Through this area</Soon>
        <Soon className="h-9">Avoid this area</Soon>
        <Soon className="h-9">Draw it</Soon>
        <Soon className="h-9">Make it a loop</Soon>
      </div>
    </div>
  );
}

/** The primary action of the planner, and the one filled use of the accent. */
export function GpxButton({ compact }: { compact?: boolean }) {
  const store = usePlanner();
  const r = usePlan((s) => (s.main.error ? null : s.main.result));
  const onClick = () => {
    const s = store.getSnapshot();
    if (!r) return;
    const n = s.waypoints.length;
    const names = s.waypoints.map((w, i) => ({ lon: w.lon, lat: w.lat, name: waypointLabel(w, i, n) }));
    const first = names[0]?.name ?? "Start";
    const last = names[n - 1]?.name ?? "Destination";
    void exportGpx(routeToGpx(r, `${first} – ${last}`, names), gpxFilename());
  };
  return (
    <button
      type="button"
      disabled={!r}
      aria-label="Export GPX"
      title="Export GPX"
      data-testid="gpx"
      onClick={onClick}
      className={cn(
        pill,
        "h-9 justify-center bg-signal text-signal-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-foreground/10 disabled:text-muted-foreground",
        compact ? "w-9" : "px-3.5",
      )}
    >
      <Download className="size-4" />
      {!compact && "GPX"}
    </button>
  );
}

/** Everything about the route below its totals: timeline, shares, stops. */
export function RouteDetails() {
  return (
    <div className="space-y-3.5">
      <Lanes />
      <Shares />
      <Waypoints />
    </div>
  );
}

// ------------------------------------------------------------------ compare

/** Pick a second profile to compare with. */
export function ComparePick({ onPick }: { onPick?: () => void }) {
  const store = usePlanner();
  const presets = usePlan((s) => s.presets);
  const baseId = usePlan((s) => s.baseId);
  const compareId = usePlan((s) => s.compareId);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="compare-pick">
      <span className="mr-1 font-semibold text-muted-foreground text-xs">Compare with</span>
      {presets
        .filter((p) => p.id !== baseId)
        .map((p) => (
          <button
            type="button"
            key={p.id}
            data-testid={`compare-${p.id}`}
            aria-pressed={compareId === p.id}
            onClick={() => {
              store.setCompare(compareId === p.id ? null : p.id);
              onPick?.();
            }}
            className={cn(
              pill,
              "h-9 border px-3",
              compareId === p.id
                ? "border-foreground bg-foreground text-background"
                : "border-border hover:border-foreground/40",
            )}
          >
            {p.own && <Bookmark className="size-3" />}
            {presetName(p)}
          </button>
        ))}
    </div>
  );
}

const LineKey = ({ color }: { color: string }) => (
  <i className="h-1 w-4 shrink-0 rounded-full" style={{ background: color }} />
);

/** Two routes and their trade-off in words. The two colours are the two lines on the map. */
export function CompareResult({ table = true }: { table?: boolean }) {
  const store = usePlanner();
  const other = usePlan((s) => s.presets.find((p) => p.id === s.compareId));
  const base = usePlan((s) => s.base);
  const changedN = usePlan((s) => s.changes.length);
  const a = usePlan((s) => s.main.result);
  const b = usePlan((s) => s.compare);
  const diff = usePlan((s) => s.compareDiff);
  if (!other) return null;
  const name = presetName(other);
  const words = a && b.result ? tradeoff(a, b.result, diff) : null;
  return (
    <div data-testid="compare-result">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-semibold text-xs">
        <span className="flex items-center gap-1.5">
          <LineKey color="var(--route)" />
          {presetName(base)}
          {changedN > 0 && " +"}
        </span>
        <span className="flex items-center gap-1.5">
          <LineKey color="var(--route-alt)" />
          {name}
        </span>
      </div>
      {words && b.result && a ? (
        <>
          <p className="mt-1.5 text-sm leading-snug" data-testid="tradeoff">
            <b>{name}</b> {words.first}{" "}
            {words.second.map((p) =>
              p.strong ? <b key={p.text}>{p.text}</b> : <span key={p.text}>{p.text}</span>,
            )}
          </p>
          {table && (
            <div className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
              {compareRows(a, b.result).map((x) => (
                <div key={x.label}>
                  <div className="text-muted-foreground">{x.label}</div>
                  <div className="whitespace-nowrap font-semibold tabular-nums">
                    {x.a} <span className="font-normal text-muted-foreground">→</span> {x.b}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="mt-1.5 text-muted-foreground text-sm">
          {b.error
            ? `${name} finds no route here: ${b.error.message}`
            : a
              ? `Routing with ${name}…`
              : "Set a start and a destination first."}
        </p>
      )}
      <div className="mt-3 flex gap-1.5">
        <button
          type="button"
          data-testid="ride-compare"
          onClick={() => store.rideCompare()}
          className={cn(pill, "h-9 bg-foreground px-3.5 text-background")}
        >
          <Check className="size-4" />
          Ride it this way
        </button>
        <button
          type="button"
          data-testid="compare-dismiss"
          onClick={() => store.setCompare(null)}
          className={cn(pill, "h-9 px-3 text-muted-foreground hover:text-foreground")}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ agent, states

/** The agent's place. Not wired: it will edit the same profile and say what it did in the diff's words. */
export function AgentBar({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      style={style}
      aria-disabled="true"
      data-testid="agent-bar"
      className={cn(card, "flex h-11 items-center gap-2 rounded-full pr-1.5 pl-4", className)}
      title="Later: the agent edits the same profile"
    >
      <Sparkles className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
        40 km loop north-west, quiet gravel…
      </span>
      <span className="shrink-0 rounded-full border border-foreground/30 border-dashed px-2 font-semibold text-2xs text-muted-foreground">
        later
      </span>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/10 text-muted-foreground">
        <ArrowUp className="size-4" />
      </span>
    </div>
  );
}

const MB = 1024 * 1024;
const bytes = (done: number, total: number) =>
  total < MB
    ? `${Math.round(done / 1024)} of ${Math.round(total / 1024)} KB`
    : `${(done / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`;

/** Which status replaces the route's totals, or `null` when there is a route to show. */
export function useStatus(): "download" | "engine-error" | "empty" | "one" | "error" | null {
  const engine = useEngine();
  const n = usePlan((s) => s.waypoints.length);
  const error = usePlan((s) => !!s.main.error);
  if (engine.status === "downloading" || (engine.status === "loading" && n >= 2)) return "download";
  if (engine.status === "error") return "engine-error";
  if (n === 0) return "empty";
  if (n === 1) return "one";
  if (error) return "error";
  return null;
}

/** What stands in for the route's totals when there is none: nothing planned, the region on its way, no way through. */
export function StatusBody({ onShowLimits, onRetry }: { onShowLimits: () => void; onRetry: () => void }) {
  const store = usePlanner();
  const status = useStatus();
  const engine = useEngine();
  const baseName = usePlan((s) => presetName(s.base));
  const error = usePlan((s) => s.main.error);
  const blame = usePlan((s) => s.blame);
  const blamedLabel = usePlan((s) => s.catalogue?.limits.find((l) => l.id === s.blame?.limit)?.label);
  const waypoints = usePlan((s) => s.waypoints);
  const icon = (I: LucideIcon) => (
    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground/8">
      <I className="size-5" />
    </span>
  );
  if (status === "download" && (engine.status === "downloading" || engine.status === "loading")) {
    const frac = engine.total > 0 ? engine.done / engine.total : 0;
    return (
      <div data-testid="status-download" role="status">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-bold text-base">
            {engine.status === "downloading" ? "Getting the region ready" : "Loading the region"}
          </span>
          <span className="font-semibold text-xs tabular-nums">{Math.round(frac * 100)} %</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-track">
          <i
            className="block h-full rounded-full bg-foreground transition-[width]"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        <p className="mt-2 text-muted-foreground text-xs">
          {engine.total > 0 && <span className="tabular-nums">{bytes(engine.done, engine.total)} · </span>}
          {engine.status === "downloading"
            ? "the routing data, once; then it works offline. The map is ready already."
            : "from this device into the engine."}
        </p>
      </div>
    );
  }
  if (status === "engine-error")
    return (
      <div data-testid="status-engine-error">
        <div className="flex items-start gap-3">
          {icon(TriangleAlert)}
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-base">The routing data did not load</span>
            <span className="block break-words text-muted-foreground text-xs">
              {engine.status === "error" ? engine.message : ""}. The map works; routes need the data.
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className={cn(pill, "mt-3 h-9 bg-foreground px-3.5 text-background")}
        >
          <RotateCcw className="size-3.5" />
          Try again
        </button>
      </div>
    );
  if (status === "empty" || status === "one")
    return (
      <div className="flex items-center gap-3" data-testid="status-empty">
        {icon(Crosshair)}
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-base">
            {status === "empty" ? "Tap the map to set a start" : "Tap the map for where to go"}
          </span>
          <span className="block text-muted-foreground text-xs">
            {status === "empty" ? "Then tap again for where to go. " : "The start is set. "}
            {baseName} decides the way.
          </span>
        </span>
        {status === "one" && (
          <IconButton label="Clear the start" onClick={() => store.clearWaypoints()}>
            <X className="size-4" />
          </IconButton>
        )}
      </div>
    );
  if (status === "error" && error) {
    if (error.code === "no_way_near") {
      const i = error.waypoint ?? 0;
      const w = waypoints[i];
      const name = waypointLabel(w, i, waypoints.length);
      return (
        <div data-testid="status-error" data-code={error.code}>
          <div className="flex items-start gap-3">
            {icon(TriangleAlert)}
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-base">{name} is not near a way</span>
              <span className="block text-muted-foreground text-xs leading-snug">
                Nothing rideable within 250 m of it. Drag it closer to a way, or remove it.
              </span>
            </span>
          </div>
          {w && (
            <button
              type="button"
              onClick={() => store.removeWaypoint(w.id)}
              className={cn(pill, "mt-3 h-9 bg-foreground px-3.5 text-background")}
            >
              <X className="size-3.5" />
              Remove {name}
            </button>
          )}
        </div>
      );
    }
    const limitNamed = blame?.limit && blamedLabel;
    return (
      <div data-testid="status-error" data-code={error.code}>
        <div className="flex items-start gap-3">
          {icon(TriangleAlert)}
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-base" data-testid="error-title">
              {limitNamed
                ? `No route with “${blamedLabel}”`
                : error.code === "no_route" || error.code === "excluded"
                  ? "No route with these limits"
                  : "No route"}
            </span>
            <span className="block text-muted-foreground text-xs leading-snug">
              {blame?.searching
                ? "Looking for the limit that blocks it…"
                : limitNamed
                  ? "Every way between these stops breaks it somewhere. The dashed line is the route without it."
                  : blame?.result
                    ? "No single limit is to blame. The dashed line is the route without any of them."
                    : error.message}
            </span>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {blame?.limit && limitNamed && (
            <button
              type="button"
              data-testid="lift-limit"
              onClick={() => blame.limit && store.liftLimit(blame.limit)}
              className={cn(pill, "h-9 bg-foreground px-3.5 text-background")}
            >
              <Lock className="size-3.5" />
              Lift “{blamedLabel}”
            </button>
          )}
          <button
            type="button"
            onClick={onShowLimits}
            className={cn(pill, "h-9 border border-foreground/25 px-3.5")}
          >
            Show the limits
          </button>
        </div>
      </div>
    );
  }
  return null;
}

/** The engine's state as a dot on the brand mark (tests read `data-status`). */
export function EngineBadge({ className, children }: { className?: string; children?: ReactNode }) {
  const s = useEngine();
  const text =
    s.status === "downloading"
      ? `Downloading region data ${bytes(s.done, s.total)}`
      : s.status === "loading"
        ? "Loading region data"
        : s.status === "error"
          ? `Engine failed: ${s.message}`
          : s.status === "ready"
            ? `Engine ${s.version ?? ""}: region graph ${s.stats.info.edges.toLocaleString("en")} edges`
            : s.version
              ? `Engine ${s.version}`
              : "Starting the engine…";
  return (
    <div
      data-testid="engine-status"
      data-status={s.status}
      data-busy={s.busy}
      title={text}
      className={className}
    >
      {children}
      <span className="sr-only">{text}</span>
      {(s.status === "ready" || s.status === "idle") && s.version && (
        <span className="sr-only" data-testid="engine-version">
          {s.version}
        </span>
      )}
      {s.status !== "ready" && s.status !== "idle" && (
        <i
          aria-hidden="true"
          className={cn(
            "absolute top-1 right-1 size-2 rounded-full",
            s.status === "error" ? "bg-signal" : "animate-pulse bg-foreground motion-reduce:animate-none",
          )}
        />
      )}
    </div>
  );
}

/** A just-added row scrolls into view, and its flash ends. */
export function useFlashScroll() {
  const store = usePlanner();
  const fresh = usePlan((s) => s.fresh);
  useEffect(() => {
    if (!fresh) return;
    document.querySelector(".kp-flash")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const t = setTimeout(() => store.settle(), 1500);
    return () => clearTimeout(t);
  }, [fresh, store]);
}
