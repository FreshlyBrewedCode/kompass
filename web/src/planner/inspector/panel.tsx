// The segment inspector (docs/planner.md, "The segment inspector"): one way under the plan's profile,
// opened by a right-click or a long press while planning (or a tap on the Cost layer). On the route:
// why it is used; off it: why not, against the route through it; with no route: how it counts. Then
// the three groups of preferences (cheaper, dearer, could apply), each line opening its slider in place,
// and the arithmetic and the way's data, folded. Words in ./model.ts and ../cost/model.ts.
import { cn } from "cn";
import { ChevronDown, Plus, Route, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isSuperseded } from "@/engine/client";
import type {
  ArcCostExplanation,
  AttrValue,
  EdgeExplanation,
  PrefId,
  Profile,
} from "@/engine/generated/types";
import { costColorAt, costPosition, formatFactor } from "@/map/cost";
import { COST_CLOSED, type Theme } from "@/map/palette";
import {
  closureName,
  closureTag,
  edgeVerdict,
  isOpen,
  metresText,
  NEUTRAL,
  type Side,
  wayName,
  whyNot,
} from "../cost/model";
import { weightWord } from "../model";
import { Dial, label, pill } from "../parts";
import { usePlan, usePlanner } from "../store";
import { AvoidedRow, StructuredLines } from "../structured/inspect";
import { replaced } from "../structured/model";
import {
  ActionsHint,
  AllowButton,
  AvoidButton,
  allowable,
  PlanException,
  PreferButton,
  useException,
} from "./actions";
import { Coordinates } from "./coords";
import {
  arrange,
  focusArc,
  type Group,
  headline,
  type InspectTarget,
  type Layout,
  type Line,
  layoutOf,
  lines,
  onRoute,
  times,
  whyNotVerdict,
} from "./model";

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
/** neutral lines shown before "more" */
const NEUTRAL_SHOWN = 4;

/** A line swatch in the cost layer's colour for a factor (closed: dashed ink). */
function FactorSwatch({ factor, x, theme }: { factor: number | null; x: EdgeExplanation; theme: Theme }) {
  if (factor === null)
    return (
      <i
        className="mt-1.5 h-1.5 w-5 shrink-0 rounded-full"
        style={{
          backgroundImage: `repeating-linear-gradient(to right, ${COST_CLOSED[theme]} 0 4px, transparent 4px 7px)`,
        }}
      />
    );
  const t = costPosition(factor, x.bounds.min_factor, x.bounds.max_factor);
  return (
    <i className="mt-1.5 h-1.5 w-5 shrink-0 rounded-full" style={{ background: costColorAt(t, theme) }} />
  );
}

/** The profile to find what would match here: every preference on (memberships do not depend on it). */
function probeProfile(ids: readonly PrefId[]): Profile {
  return { weights: Object.fromEntries(ids.map((id) => [id, 100])), limits: {} };
}

/**
 * on the route; off it (with a route); closed both ways (nothing routes through it); avoided by this
 * plan (no "why not": the plan says why); no route yet
 */
type Mode = "used" | "whynot" | "closed" | "avoided" | "way";

export function Inspector({
  target,
  theme,
  desk,
  onClose,
}: {
  target: InspectTarget;
  theme: Theme;
  /** the profile card is on screen: a line also flashes its row there */
  desk: boolean;
  onClose: () => void;
}) {
  const store = usePlanner();
  const catalogue = usePlan((s) => s.catalogue);
  const weights = usePlan((s) => s.weights);
  const limits = usePlan((s) => s.limits);
  const base = usePlan((s) => s.base);
  const minFactor = usePlan((s) => s.minFactor);
  const overrides = usePlan((s) => s.overrides);
  // the structured controls (#66): their boards, curve and spread are part of the profile too
  const structured = usePlan((s) => s.structured);
  const exception = useException(target.id);
  const routed = usePlan((s) => s.waypoints.length >= 2 && !!s.main.result && !s.main.error);
  const arcs = usePlan((s) =>
    s.waypoints.length >= 2 && !s.main.error ? (s.main.result?.arcs ?? null) : null,
  );
  const used = onRoute(target.id, arcs);

  // the way's run between junctions: what an exception applies to (ringed on the map)
  useEffect(() => store.loadRun(target.id), [target.id, store]);
  useEffect(() => () => store.clearRun(), [store]);

  // the explanation under the plan's profile and exceptions: again on every change (a slider step)
  const [x, setX] = useState<EdgeExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the profile (weights, limits, base, detours) and the exceptions are the input
  useEffect(() => {
    let live = true;
    store.explainEdge(target.id).then(
      (r) => {
        if (!live || isSuperseded(r)) return;
        setX(r);
        setError(null);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [target.id, weights, limits, base, minFactor, overrides, structured, store]);
  const fresh = x?.edge === target.id ? x : null;
  // a way closed both ways is never routed through (a via snaps to an open way nearby): no comparison
  const closedWay = !!fresh && !isOpen(fresh.along) && !isOpen(fresh.against);
  const avoided = exception?.kind === "avoid";
  const mode: Mode = used ? "used" : closedWay ? "closed" : avoided ? "avoided" : routed ? "whynot" : "way";
  const known = fresh !== null;
  // what would match here: once per way (memberships do not depend on the weights)
  const [probe, setProbe] = useState<EdgeExplanation | null>(null);
  useEffect(() => {
    if (!catalogue) return;
    let live = true;
    const ids = catalogue.preferences.map((p) => p.id);
    store.explainEdge(target.id, probeProfile(ids), "explain-probe").then(
      (r) => live && !isSuperseded(r) && setProbe(r),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [target.id, catalogue, store]);

  // "why not this": the route through the way, against the plan's (the store's `whyNot`)
  const accepted = useRef<unknown>(null);
  const mainResult = usePlan((s) => s.main.result);
  useEffect(() => {
    const s = store.getSnapshot();
    if (accepted.current !== null) {
      // "use this way" added a stop: wait for the route through it before deciding again
      if (accepted.current === mainResult) return;
      accepted.current = null;
    }
    const [lon, lat] = target.point;
    if (!known && !used) return; // not known yet whether the way is open
    if (mode === "whynot") {
      if (s.whyNot?.at.lon !== lon || s.whyNot?.at.lat !== lat) store.startWhyNot(lon, lat);
    } else if (s.whyNot) store.endWhyNot();
  }, [mode, known, used, target.point, store, mainResult]);
  useEffect(() => () => store.endWhyNot(), [store]);

  // the lines, frozen in place while a slider is open
  const [open, setOpen] = useState<string | null>(null);
  const frozen = useRef<Layout | null>(null);
  const arc = fresh ? focusArc(fresh, arcs) : null;
  const probeArc =
    probe?.edge === target.id && arc ? (arc === fresh?.along ? probe.along : probe.against) : null;
  const all = useMemo(() => {
    if (!fresh || !arc) return null;
    const l = lines(fresh, arc, probeArc, weights, catalogue);
    if (!structured) return l;
    // the boards and the curve have their own lines (below); what they replace is no slider here
    const hidden = replaced(catalogue).prefs;
    const keep = (x: Line) => x.key !== "fixed:hills" && !(x.pref && hidden.has(x.pref));
    return { lowers: l.lowers.filter(keep), raises: l.raises.filter(keep), neutral: l.neutral.filter(keep) };
  }, [fresh, arc, probeArc, weights, catalogue, structured]);
  const shown = all ? arrange(all, open ? frozen.current : null) : null;
  const toggle = (l: Line) => {
    if (!l.pref || !all) return;
    if (open === l.key) {
      setOpen(null);
      frozen.current = null;
      return;
    }
    frozen.current = layoutOf(shown ?? all);
    setOpen(l.key);
    if (desk && l.pref in weights) store.flash(l.pref);
  };
  // a new way: nothing open
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new edge only
  useEffect(() => {
    setOpen(null);
    frozen.current = null;
  }, [target.id]);

  // Escape closes (not while typing)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Escape" || t?.closest("input, textarea, [contenteditable]")) return;
      onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const verdict = fresh ? edgeVerdict(fresh, catalogue, arc ?? undefined) : null;
  // an avoided way counts as the profile has it; the exception block says the rest
  const counted = arc && avoided && arc.base_cost !== undefined ? { ...arc, cost: arc.base_cost } : arc;
  const head = fresh && counted ? headline(fresh, counted) : null;
  const closed = !arc || !isOpen(arc);
  return (
    <section
      data-testid="inspector"
      data-edge-id={target.id}
      data-mode={mode}
      data-tone={verdict?.tone ?? ""}
      className="thin-scroll max-h-[46dvh] overflow-y-auto rounded-card border border-border bg-glass p-3.5 text-sm shadow-float backdrop-blur-xl md:max-h-[50dvh]"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={cn(label, "min-w-0 truncate")}>
          {fresh ? `${wayName(fresh.way)} · ${metresText(fresh.length_m)}` : `Way ${target.id}`}
        </span>
        <span
          data-testid="inspector-on-route"
          className="shrink-0 rounded-full border border-border px-1.5 font-semibold text-2xs text-muted-foreground"
        >
          {used ? "on the route" : routed ? "not on the route" : "no route yet"}
        </span>
        <button
          type="button"
          className="-mr-1 ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-foreground/8 hover:bg-foreground/12"
          aria-label="Close"
          data-testid="inspector-close"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <Coordinates at={target.at} className="-mt-1.5 mb-1.5" />
      {error && <p className="text-muted-foreground text-xs">Could not explain this way: {error}</p>}
      {!fresh && !error && <p className="text-muted-foreground text-xs">Explaining…</p>}
      {fresh && verdict && head && (
        <>
          {exception && <PlanException o={exception} x={fresh} onRoute={used} />}
          <div className={cn(label, "mb-1")}>
            {mode === "used"
              ? "Why the route uses this"
              : mode === "way" || mode === "avoided"
                ? "How this way counts"
                : "Why the route does not use this"}
          </div>
          {mode === "whynot" && (
            <WhyNotVerdictBlock
              x={fresh}
              exception={!!exception}
              minFactor={minFactor}
              onUse={() => {
                // the stop goes in; decide again once the route through it is there
                accepted.current = store.getSnapshot().main.result;
                store.acceptWhyNot();
              }}
            />
          )}
          <div className={cn("flex gap-2", mode === "whynot" && "mt-2.5 border-border border-t pt-2.5")}>
            <FactorSwatch factor={closed ? null : (head.perM ?? null)} x={fresh} theme={theme} />
            <div className="min-w-0">
              <p
                data-testid="inspector-headline"
                className={cn("leading-snug", mode === "whynot" ? "font-semibold" : "font-bold")}
              >
                {closed
                  ? verdict.title
                  : `${mode === "whynot" ? "This way itself counts" : "Counts"} as ${times(head.perM ?? 1)} its length`}
              </p>
              {!closed && <p className="mt-0.5 text-xs leading-snug">{head.rate}</p>}
              {verdict.notes.map((n) => (
                <p key={n} className="mt-0.5 text-muted-foreground text-xs leading-snug">
                  {n}
                </p>
              ))}
              {mode === "used" && (head.perM ?? 1) > 1 + NEUTRAL && (
                <p className="mt-0.5 text-muted-foreground text-xs leading-snug">
                  The route takes it all the same: the ways around it count more.
                </p>
              )}
              {closed && <Closed x={fresh} />}
            </div>
          </div>
          {!exception && (mode === "used" || mode === "way") && (
            <div data-testid="inspector-actions">
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <AvoidButton x={fresh} />
                {mode === "way" && <PreferButton x={fresh} />}
              </div>
              {mode === "used" && (
                <p className="mt-1.5 text-muted-foreground text-xs leading-snug">
                  For this plan only, between the junctions (the ring): the profile stays as it is.
                </p>
              )}
              {mode === "way" && <ActionsHint x={fresh} use={false} />}
            </div>
          )}
          {structured && arc && isOpen(arc) && <StructuredLines x={fresh} arc={arc} />}
          {shown && (
            <div className="mt-2.5 space-y-2" data-testid="inspector-groups">
              <LineGroup
                group="lowers"
                title="Makes it cheaper"
                lines={shown.lowers}
                open={open}
                onToggle={toggle}
              />
              <LineGroup
                group="raises"
                title="Makes it dearer"
                lines={shown.raises}
                open={open}
                onToggle={toggle}
              />
              <LineGroup
                group="neutral"
                title="Could apply here, neutral now"
                lines={shown.neutral}
                open={open}
                onToggle={toggle}
                limit={NEUTRAL_SHOWN}
              />
              {shown.lowers.length + shown.raises.length + shown.neutral.length === 0 && (
                <p className="text-muted-foreground text-xs">Nothing in the profile applies to this way.</p>
              )}
            </div>
          )}
          {mode === "whynot" && <Stretches />}
          <Folded title="The arithmetic">
            {fresh && !sameArc(fresh.along, fresh.against) ? (
              <div className="space-y-2.5">
                <Arithmetic arc={fresh.along} x={fresh} title="Direction ›" />
                <Arithmetic arc={fresh.against} x={fresh} title="Direction ‹" />
              </div>
            ) : (
              <Arithmetic arc={fresh.along} x={fresh} />
            )}
          </Folded>
          <Folded title="The way's data">
            <WayData x={fresh} />
          </Folded>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ the lines

function LineGroup({
  group,
  title,
  lines: list,
  open,
  onToggle,
  limit,
}: {
  group: Group;
  title: string;
  lines: Line[];
  open: string | null;
  onToggle: (l: Line) => void;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  if (list.length === 0) return null;
  // the open line always shows
  const cut = limit !== undefined && !all ? limit : list.length;
  const visible = list.filter((l, i) => i < cut || l.key === open);
  return (
    <div data-testid={`inspector-${group}`}>
      <div className={cn(label, "mb-0.5")}>{title}</div>
      <ul>
        {visible.map((l) => (
          <LineRow key={l.key} line={l} open={open === l.key} onToggle={() => onToggle(l)} />
        ))}
      </ul>
      {visible.length < list.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="px-1 text-muted-foreground text-xs underline"
          data-testid={`inspector-${group}-more`}
        >
          {list.length - visible.length} more
        </button>
      )}
    </div>
  );
}

function LineRow({ line: l, open, onToggle }: { line: Line; open: boolean; onToggle: () => void }) {
  const sub = [l.match, l.weight !== null ? `${signed(l.weight)}` : null].filter(Boolean).join(" · ");
  return (
    <li data-testid={`inspector-line-${l.key}`} data-group={l.group}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!l.pref}
        aria-expanded={l.pref ? open : undefined}
        className="flex w-full items-start gap-2 rounded-control px-1 py-1 text-left text-xs enabled:hover:bg-foreground/6"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate font-semibold">{l.label}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">{sub}</span>
          </span>
          {l.effect && <span className="block text-muted-foreground leading-snug">{l.effect}</span>}
        </span>
        {l.value && <span className="shrink-0 font-bold tabular-nums">{l.value}</span>}
        {l.pref && (
          <ChevronDown
            className={cn("mt-px size-3.5 shrink-0 text-muted-foreground", open && "rotate-180")}
          />
        )}
      </button>
      {open && l.pref && <InPlace id={l.pref} />}
    </li>
  );
}

/** One preference's slider, in place: the route and the explanation follow every step. */
function InPlace({ id }: { id: PrefId }) {
  const store = usePlanner();
  const pref = usePlan((s) => s.catalogue?.preferences.find((p) => p.id === id));
  const inPlan = usePlan((s) => id in s.weights);
  const v = usePlan((s) => s.weights[id] ?? 0);
  const b = usePlan((s) => s.baseWeights[id]);
  const name = pref?.label ?? id;
  const word = weightWord(pref, v);
  return (
    <div data-testid={`inspector-slider-${id}`} className="px-1 pb-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{pref?.hint}</span>
        <span className="ml-auto shrink-0 whitespace-nowrap font-medium text-muted-foreground">{word}</span>
        <span className="w-8 shrink-0 text-right font-bold tabular-nums" data-testid="inspector-slider-value">
          {signed(v)}
        </span>
      </div>
      <Dial name={name} word={word} value={v} base={b} onChange={(x) => store.setWeight(id, x)} />
      {!inPlan && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span>Not in this plan yet: moving the slider adds it.</span>
          {pref && pref.default !== 0 && (
            <button
              type="button"
              data-testid="inspector-add"
              onClick={() => store.setWeight(id, pref.default)}
              className={cn(pill, "h-7 border border-border px-2.5 text-foreground hover:bg-foreground/6")}
            >
              <Plus className="size-3.5" />
              Add at {signed(pref.default)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ why not this

/** A way closed both ways: what closes it, and the limit to lift where one does (no slider can). */
function Closed({ x }: { x: EdgeExplanation }) {
  const store = usePlanner();
  const catalogue = usePlan((s) => s.catalogue);
  const by = [...x.along.closed_by, ...x.against.closed_by].map((c) => c.by);
  const limit = catalogue?.limits.find((l) => by.includes(l.id));
  const avoided = by.includes("avoided_surface") || by.includes("avoided_way");
  if (avoided && !limit)
    return (
      <>
        <AvoidedRow x={x} />
        {allowable(x) && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="inspector-actions">
            <AllowButton x={x} />
          </div>
        )}
      </>
    );
  if (!limit)
    return (
      <p data-testid="inspector-noslider" className="mt-1 font-semibold text-xs leading-snug">
        No slider or limit can change this: the law or the way's one-way closes it.
      </p>
    );
  return (
    <>
      <p data-testid="inspector-noslider" className="mt-1 font-semibold text-xs leading-snug">
        No slider can change this: only lifting “{limit.label}” opens it.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="inspector-actions">
        {allowable(x) && <AllowButton x={x} limit={limit.id} />}
        <button
          type="button"
          data-testid="inspector-lift"
          onClick={() => store.liftLimit(limit.id)}
          className={cn(pill, "h-9 border border-border px-3.5 hover:bg-foreground/6")}
        >
          Lift “{limit.label}”
        </button>
      </div>
      {allowable(x) && (
        <p className="mt-1.5 text-muted-foreground text-xs leading-snug" data-testid="inspector-allow-hint">
          “Allow here” opens only this way, for this plan; “Lift” switches the limit off for the whole plan.
        </p>
      )}
    </>
  );
}

function WhyNotVerdictBlock({
  x,
  exception,
  minFactor,
  onUse,
}: {
  x: EdgeExplanation;
  /** the plan already has an exception here (its block says what and offers the way back) */
  exception: boolean;
  minFactor: number;
  onUse: () => void;
}) {
  const w = usePlan((s) => s.whyNot);
  const catalogue = usePlan((s) => s.catalogue);
  const structured = usePlan((s) => s.structured);
  if (!w || w.line.error)
    return (
      <p className="text-muted-foreground text-xs" data-testid="inspector-verdict">
        {w?.line.error ? `No route through here: ${w.line.error.message}` : "Routing through here…"}
      </p>
    );
  if (!w.comparison)
    return (
      <p className="text-muted-foreground text-xs" data-testid="inspector-verdict">
        Routing through here…
      </p>
    );
  const v = whyNotVerdict(w.comparison, minFactor, catalogue, structured);
  return (
    <div data-testid="inspector-whynot" data-state={v.state}>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-semibold text-xs">
        <span className="flex items-center gap-1.5">
          <KeyLine color="var(--route)" />
          Planned
        </span>
        <span className="flex items-center gap-1.5">
          <KeyLine color="var(--route-alt)" />
          Through here
        </span>
      </div>
      <p data-testid="inspector-verdict" className="font-bold leading-snug">
        {v.title}
      </p>
      {v.blame && (
        <p data-testid="inspector-blame" data-kind={v.blame.kind} className="mt-0.5 text-xs leading-snug">
          {v.blame.text}.
        </p>
      )}
      {v.noSlider && (
        <p data-testid="inspector-noslider" className="mt-0.5 font-semibold text-xs leading-snug">
          {v.noSlider}
        </p>
      )}
      {v.detail && <p className="mt-0.5 text-muted-foreground text-xs leading-snug">{v.detail}</p>}
      {/* the plan's actions on this way: a stop, or an exception (this plan only) */}
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="inspector-actions">
        <button
          type="button"
          data-testid="inspector-use"
          disabled={!w.line.result}
          onClick={onUse}
          className={cn(pill, "h-9 bg-foreground px-3.5 text-background disabled:opacity-50")}
        >
          <Route className="size-4" />
          Use this way
        </button>
        {!exception && <PreferButton x={x} />}
        {!exception && <AvoidButton x={x} short />}
      </div>
      {!exception && <ActionsHint x={x} use />}
    </div>
  );
}

const KeyLine = ({ color }: { color: string }) => (
  <i className="h-1 w-4 shrink-0 rounded-full" style={{ background: color }} />
);

function SideCell({ s, name }: { s: Side; name: string }) {
  if (s.empty)
    return (
      <div className="min-w-0 space-y-0.5">
        <div className="font-semibold">{name}</div>
        <div className="text-muted-foreground">nothing: it goes straight on</div>
      </div>
    );
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="font-semibold">{name}</div>
      <div className="tabular-nums">
        {s.length} at <b>{s.factor}</b>
      </div>
      <div className="text-muted-foreground tabular-nums">{s.cost}</div>
      {s.ways && <div className="text-muted-foreground">{s.ways}</div>}
      {s.reasons && <div className="text-muted-foreground">{s.reasons}</div>}
      {s.atMin >= 0.05 && (
        <div className="text-muted-foreground">{Math.round(s.atMin * 100)} % at the detour limit</div>
      )}
      {s.closed && <div className="font-semibold">{s.closed}</div>}
    </div>
  );
}

/** Where the plan's route and the one through here part, side by side (folded). */
function Stretches() {
  const w = usePlan((s) => s.whyNot);
  const catalogue = usePlan((s) => s.catalogue);
  const minFactor = usePlan((s) => s.minFactor);
  if (!w?.comparison) return null;
  const summary = whyNot(w.comparison, minFactor, catalogue);
  if (summary.stretches.length === 0) return null;
  // the verdict above says closures and "no slider"; the rest of the diagnosis goes here
  const hints = summary.hints.filter((h) => !h.startsWith("No slider") && !h.includes("is closed"));
  return (
    <Folded title={`Where the routes part (${summary.stretches.length})`} testid="inspector-stretches">
      {hints.map((h) => (
        <p key={h} className="mb-1.5 leading-snug">
          {h}
        </p>
      ))}
      {summary.stretches.map((s, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: stretches have no id, their order is stable
          key={i}
          data-testid="whynot-stretch"
          className={cn(i > 0 && "mt-2 border-border border-t pt-2")}
        >
          <div className="mb-1 font-semibold">
            {summary.stretches.length > 1 ? `${i + 1}: ` : ""}
            <span className="font-normal">through here is {s.delta}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <SideCell s={s.planned} name="Planned" />
            <SideCell s={s.through} name="Through here" />
          </div>
        </div>
      ))}
    </Folded>
  );
}

// ------------------------------------------------------------------ folded detail

function Folded({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <details className="mt-2.5 border-border border-t pt-2 text-xs" data-testid={testid}>
      <summary className="cursor-pointer font-semibold">{title}</summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

const fmtValue = (v: AttrValue | null) =>
  v === null ? "—" : typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v).replace(/_/g, " ");

const sameArc = (a: ArcCostExplanation, b: ArcCostExplanation) =>
  isOpen(a) === isOpen(b) &&
  Math.abs(a.factor - b.factor) < 1e-3 &&
  Math.abs((a.cost_per_m ?? 0) - (b.cost_per_m ?? 0)) < 1e-3;

/** quality × bonus (gate) → raw → clamped; additive terms; what the router pays. */
function Arithmetic({ arc, x, title }: { arc: ArcCostExplanation; x: EdgeExplanation; title?: string }) {
  const catalogue = usePlan((s) => s.catalogue);
  const row = "flex justify-between gap-3";
  return (
    <div className="space-y-0.5" data-testid="cost-arithmetic">
      {title && <div className="font-semibold">{title}</div>}
      {!isOpen(arc) ? (
        arc.closed_by.map((c) => (
          <div key={c.by} className={row}>
            <span>Closed: {closureName(c.by, catalogue)}</span>
            <span className="text-muted-foreground">{closureTag(c)}</span>
          </div>
        ))
      ) : arc.structured ? (
        <>
          <div className={row}>
            <span className="text-muted-foreground">
              Boards ({arc.structured.boards.map((b) => `${b.row.replace(/_/g, " ")} ${b.tier}`).join(", ")})
            </span>
            <span className="tabular-nums">{formatFactor(arc.structured.board_factor)}</span>
          </div>
          {arc.structured.groups.map((g) => (
            <div key={g.group} className={row}>
              <span className="text-muted-foreground">
                × {g.group}:{" "}
                {[g.bonus, g.penalty, g.gated_bonus]
                  .filter(Boolean)
                  .map((r) => r?.id)
                  .join(", ") || "—"}
              </span>
              <span className="tabular-nums">
                {formatFactor([g.bonus, g.penalty, g.gated_bonus].reduce((f, r) => f * (r?.factor ?? 1), 1))}
              </span>
            </div>
          ))}
          <div className={row}>
            <span className="text-muted-foreground">
              ÷ the profile's best ({formatFactor(arc.structured.best)})
            </span>
            <span className="tabular-nums">{formatFactor(arc.structured.relative)}</span>
          </div>
          <div className={cn(row, "font-semibold")}>
            <span>^ detours {arc.structured.detours}</span>
            <span className="tabular-nums">{formatFactor(arc.factor)}</span>
          </div>
          {arc.additive.map((a) => (
            <div key={a.kind} className={row}>
              <span className="text-muted-foreground">+ {a.kind}</span>
              <span className="tabular-nums">
                {a.metres < 0 ? "−" : "+"}
                {metresText(Math.abs(a.metres))}
              </span>
            </div>
          ))}
          {arc.cost !== undefined && (
            <div className={row}>
              <span className="text-muted-foreground">The router counts {metresText(x.length_m)} as</span>
              <span className="tabular-nums">{metresText(arc.cost)}</span>
            </div>
          )}
        </>
      ) : (
        <>
          <div className={row}>
            <span className="text-muted-foreground">Quality (surface, way, traffic…)</span>
            <span className="tabular-nums">{formatFactor(arc.quality)}</span>
          </div>
          <div className={row}>
            <span className="text-muted-foreground">
              × landscape bonuses{arc.bonus < 0.999 ? `, counting ${Math.round(arc.gate * 100)} %` : ""}
            </span>
            <span className="tabular-nums">{formatFactor(arc.bonus)}</span>
          </div>
          <div className={row}>
            <span className="text-muted-foreground">= before the limits</span>
            <span className="tabular-nums">{formatFactor(arc.raw_factor)}</span>
          </div>
          <div className={cn(row, "font-semibold")}>
            <span>
              {arc.clamp === "min"
                ? `held at the detour limit (${formatFactor(x.bounds.min_factor)})`
                : arc.clamp === "max"
                  ? `held at the ceiling (${formatFactor(x.bounds.max_factor)})`
                  : "factor"}
            </span>
            <span className="tabular-nums">{formatFactor(arc.factor)}</span>
          </div>
          {arc.additive.map((a) => (
            <div key={a.kind} className={row}>
              <span className="text-muted-foreground">+ {a.kind}</span>
              <span className="tabular-nums">+{metresText(a.metres)}</span>
            </div>
          ))}
          {arc.cost !== undefined && (
            <div className={row}>
              <span className="text-muted-foreground">The router counts {metresText(x.length_m)} as</span>
              <span className="tabular-nums">{metresText(arc.cost)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function WayData({ x }: { x: EdgeExplanation }) {
  return (
    <>
      <p className="text-muted-foreground">
        Surface for the cost: {x.cost_surface.replace(/_/g, " ")} ({x.surface_source.replace(/_/g, " ")}),
        traffic {Math.round(x.traffic * 100)} %
        {x.traffic_from === "alongside" && " (from the road alongside)"}
      </p>
      <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
        {x.attributes.map((a) => (
          <div key={a.attribute} className="contents">
            <dt className="text-muted-foreground">{a.attribute.replace(/_/g, " ")}</dt>
            <dd className="text-right font-semibold tabular-nums">{fmtValue(a.value)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
