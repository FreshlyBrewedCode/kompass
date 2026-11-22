// The hills curve (direction A; docs/design/steering-widgets.md): grade −20 … +20 % against what a
// metre counts as (log), the route's kilometres per grade band behind it, handles at the fixed grades
// (0 % pinned). The handles at 0, +3 and +6 % sit close together on a phone, so the selected handle
// also has a stepper row (44 px targets) that does everything a drag does.
import { cn } from "cn";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { Hills } from "@/engine/generated/types";
import { ChangeDot } from "../parts";
import { type PlanState, usePlan, usePlanner } from "../store";
import {
  bands,
  curveAt,
  curvePoints,
  gradeText,
  HANDLES,
  handleRange,
  handleSentence,
  handleValue,
  looseSentence,
  metreText,
  namedCurve,
  routeHillsM,
  signedKm,
  stepLoose,
  stepValue,
} from "./model";

const routeOf = (s: PlanState) => (s.main.error ? null : s.main.result);
const hillsOf = (s: PlanState) => s.structured?.hills;
/** The editable handles (0 % is pinned), in grade order. */
const EDITABLE = HANDLES.filter((g) => g !== 0);

/** The curve in miniature, for the collapsed line. */
export function Sparkline({ hills, w = 56, h = 20 }: { hills: Hills; w?: number; h?: number }) {
  const x = (g: number) => 1 + ((g + 20) / 40) * (w - 2);
  const y = (v: number) => h - 2 - (Math.log2(Math.max(v, 0.5)) / 3) * (h - 6) - 2;
  const pts = curvePoints(hills);
  const d = [[-20, pts[0]?.[1] ?? 1], ...pts, [20, pts.at(-1)?.[1] ?? 1]]
    .map(([g, v], i) => `${i ? "L" : "M"}${x(g as number).toFixed(1)} ${y(v as number).toFixed(1)}`)
    .join("");
  return (
    <svg
      width={w}
      height={h}
      className="shrink-0 text-foreground"
      aria-hidden="true"
      data-testid="hills-spark"
    >
      <line x1="1" x2={w - 1} y1={y(1)} y2={y(1)} stroke="var(--track)" />
      <line x1={x(0)} x2={x(0)} y1="1" y2={h - 1} stroke="var(--track)" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}

/** The collapsed glyph of the Terrain group. */
export function HillsGlyph() {
  const hills = usePlan(hillsOf);
  return hills ? <Sparkline hills={hills} /> : null;
}

// the chart's geometry (a viewBox; the svg scales to the panel's width)
const W = 358;
const H = 222;
const L = 34;
const R = 12;
const T = 22;
const B = 40;
const PW = W - L - R;
const PH = H - T - B;
/** log2 of what a metre counts as: 0.5 … 10 m */
const LO = -1;
const HI = Math.log2(10);
const gx = (g: number) => L + ((Math.max(-20, Math.min(20, g)) + 20) / 40) * PW;
const vy = (v: number) => T + (1 - (Math.log2(v) - LO) / (HI - LO)) * PH;
const yv = (y: number) => 2 ** (LO + (1 - (y - T) / PH) * (HI - LO));

function Chart({
  hills,
  selected,
  onSelect,
  onDrag,
}: {
  hills: Hills;
  selected: number;
  onSelect: (g: number) => void;
  onDrag: (g: number, v: number) => void;
}) {
  const grades = usePlan((s) => routeOf(s)?.breakdown.grades ?? null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ g: number; id: number } | null>(null);
  const bs = bands(grades);
  const max = Math.max(1, ...bs.map((b) => b.m));
  const step = grades?.step_pct ?? 1;
  const bw = (step / 40) * PW;
  const line = [-20, ...HANDLES, 20]
    .map((g, i) => `${i ? "L" : "M"}${gx(g).toFixed(1)} ${vy(curveAt(hills, g)).toFixed(1)}`)
    .join("");
  const toValue = (clientY: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return null;
    return yv(((clientY - r.top) / r.height) * H);
  };
  const v = handleValue(hills, selected);
  // the value tag above the selected handle (below it near the top), clear of its neighbours
  const tagX = Math.max(L, Math.min(W - R - 58, gx(selected) - 29));
  const tagY = vy(v) - 50 >= 0 ? vy(v) - 50 : vy(v) + 26;
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full select-none"
      role="img"
      aria-label="The hills curve: what a metre counts as against its grade"
      data-testid="hills-chart"
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const next = toValue(e.clientY);
        if (next !== null) onDrag(d.g, Math.round(next * 20) / 20);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <text x="0" y="11" fontSize="11" fill="var(--muted-foreground)">
        a metre counts as
      </text>
      <rect x={W - R - 92} y="3" width="10" height="10" rx="2" fill="var(--route)" fillOpacity="0.22" />
      <text x={W - R} y="12" textAnchor="end" fontSize="11" fill="var(--muted-foreground)">
        this route’s km
      </text>
      {bs.map((b) =>
        b.m > 0 ? (
          <rect
            key={b.g}
            x={gx(b.g) - bw / 2 + 0.75}
            y={T + PH - (b.m / max) * PH * 0.72}
            width={Math.max(1, bw - 1.5)}
            height={(b.m / max) * PH * 0.72}
            rx="1.5"
            fill="var(--route)"
            fillOpacity="0.22"
          />
        ) : null,
      )}
      {[0.5, 1, 2, 4, 8].map((m) => (
        <g key={m}>
          <line
            x1={L}
            x2={W - R}
            y1={vy(m)}
            y2={vy(m)}
            stroke="var(--foreground)"
            strokeOpacity={m === 1 ? 0.3 : 0.1}
          />
          <text x={L - 6} y={vy(m) + 4} textAnchor="end" fontSize="11" fill="var(--muted-foreground)">
            {m} m
          </text>
        </g>
      ))}
      {selected !== 0 && (
        <line
          x1={gx(selected)}
          x2={gx(selected)}
          y1={T}
          y2={T + PH}
          stroke="var(--foreground)"
          strokeDasharray="2 3"
        />
      )}
      <path d={line} fill="none" stroke="var(--foreground)" strokeWidth="2.25" strokeLinejoin="round" />
      {HANDLES.map((g) => {
        const hv = handleValue(hills, g);
        if (g === 0)
          return (
            <rect
              key={g}
              x={gx(0) - 4.5}
              y={vy(1) - 4.5}
              width="9"
              height="9"
              rx="2"
              fill="var(--foreground)"
            />
          );
        const on = g === selected;
        return (
          <g
            key={g}
            data-testid={`hills-handle-${g}`}
            style={{ touchAction: "none", cursor: "ns-resize" }}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              onSelect(g);
              drag.current = { g, id: e.pointerId };
              svg.current?.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
          >
            <circle
              cx={gx(g)}
              cy={vy(hv)}
              r="20"
              fill={on ? "var(--foreground)" : "transparent"}
              fillOpacity={on ? 0.08 : 0}
            />
            <circle
              cx={gx(g)}
              cy={vy(hv)}
              r={on ? 10 : 8.5}
              fill={on ? "var(--foreground)" : "var(--card)"}
              stroke={on ? "var(--card)" : "var(--foreground)"}
              strokeWidth={on ? 2 : 2.5}
            />
          </g>
        );
      })}
      {selected !== 0 && (
        <g transform={`translate(${tagX} ${tagY})`} pointerEvents="none">
          <rect width="58" height="24" rx="12" fill="var(--foreground)" />
          <text x="29" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--background)">
            {metreText(v)}
          </text>
        </g>
      )}
      {HANDLES.map((g) => (
        <text
          key={g}
          x={gx(g)}
          y={T + PH + 16}
          textAnchor="middle"
          fontSize="11"
          fontWeight={g === selected ? 800 : 500}
          fill={g === selected ? "var(--foreground)" : "var(--muted-foreground)"}
        >
          {g > 0 ? `+${g}` : g < 0 ? `−${-g}` : "0"}
        </text>
      ))}
      <text x={L} y={H - 4} fontSize="10.5" fill="var(--muted-foreground)">
        ← downhill
      </text>
      <text x={W - R} y={H - 4} textAnchor="end" fontSize="10.5" fill="var(--muted-foreground)">
        uphill, grade in % →
      </text>
    </svg>
  );
}

/** A round 44 px stepper button. */
function StepButton({
  label: text,
  onClick,
  disabled,
  testid,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testid: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
      className="grid size-11 shrink-0 place-items-center rounded-full bg-muted outline-none hover:bg-foreground/12 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** The named curves as a segmented control (the catalogue's; none lit for the rider's own). */
function CurvePresets() {
  const store = usePlanner();
  const curves = usePlan((s) => s.catalogue?.structured?.hills.curves);
  const hills = usePlan(hillsOf);
  const info = usePlan((s) => s.catalogue?.structured);
  if (!curves || !hills) return null;
  const on = namedCurve(hills, info)?.id;
  return (
    <fieldset
      className="m-0 grid min-w-0 grid-cols-4 gap-0.5 rounded-control border-0 bg-muted p-1"
      aria-label="Named curves"
    >
      {curves.map((c) => (
        <button
          type="button"
          key={c.id}
          title={c.blurb}
          aria-pressed={on === c.id}
          data-testid={`hills-curve-${c.id}`}
          onClick={() => store.setHills(c.hills)}
          className={cn(
            "h-11 rounded-[9px] px-1 font-semibold text-[13px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring",
            on === c.id
              ? "bg-card shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {c.label}
        </button>
      ))}
    </fieldset>
  );
}

/** The hills curve, open: presets, the chart, the stepper row, its sentence, loose ground, the total. */
export function HillsCurve({ children }: { children?: ReactNode }) {
  const store = usePlanner();
  const hills = usePlan(hillsOf);
  const info = usePlan((s) => s.catalogue?.structured);
  const grades = usePlan((s) => routeOf(s)?.breakdown.grades ?? null);
  const hillsM = usePlan((s) => routeHillsM(routeOf(s)));
  const distance = usePlan((s) => routeOf(s)?.summary.distance_m ?? null);
  const changed = usePlan((s) => s.changes.some((c) => c.id === "hills"));
  const [selected, setSelected] = useState(10);
  if (!hills) return null;
  const v = handleValue(hills, selected);
  const range = handleRange(selected, info);
  const i = EDITABLE.indexOf(selected as (typeof EDITABLE)[number]);
  const sentence = handleSentence(hills, selected, grades);
  const loose = hills.loose_pct;
  const looseRange = info?.hills.loose_pct ?? { min: 0, max: 50 };
  return (
    <div data-testid="hills-curve" className="space-y-2 pb-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <CurvePresets />
        </div>
        <ChangeDot on={changed} onClick={() => store.resetHills()} />
      </div>
      <Chart
        hills={hills}
        selected={selected}
        onSelect={setSelected}
        onDrag={(g, value) => store.setHandle(g, value)}
      />
      <div className="flex items-center gap-1">
        <StepButton
          label="The handle to the left"
          testid="hills-prev"
          disabled={i <= 0}
          onClick={() => setSelected(EDITABLE[i - 1] ?? selected)}
        >
          <ChevronLeft className="size-4" />
        </StepButton>
        <span className="min-w-[64px] text-center font-bold text-base tabular-nums" data-testid="hills-grade">
          {gradeText(selected)}
        </span>
        <StepButton
          label="The handle to the right"
          testid="hills-next"
          disabled={i >= EDITABLE.length - 1}
          onClick={() => setSelected(EDITABLE[i + 1] ?? selected)}
        >
          <ChevronRight className="size-4" />
        </StepButton>
        <span className="flex-1" />
        <StepButton
          label={`Cheaper at ${gradeText(selected)}`}
          testid="hills-minus"
          disabled={v <= range.min}
          onClick={() => store.setHandle(selected, stepValue(v, -1, range))}
        >
          <Minus className="size-4" />
        </StepButton>
        <span className="min-w-[64px] text-center font-bold text-base tabular-nums" data-testid="hills-value">
          {metreText(v)}
        </span>
        <StepButton
          label={`Dearer at ${gradeText(selected)}`}
          testid="hills-plus"
          disabled={v >= range.max}
          onClick={() => store.setHandle(selected, stepValue(v, 1, range))}
        >
          <Plus className="size-4" />
        </StepButton>
      </div>
      <p className="rounded-control bg-muted px-3 py-2 text-[13px] leading-snug" data-testid="hills-sentence">
        <b>{sentence.lead}</b>
        {sentence.route && <span className="text-muted-foreground"> {sentence.route}</span>}
      </p>
      <div className="flex items-center gap-2 border-border border-t pt-2.5">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm">Steeper on loose ground</div>
          <div className="text-muted-foreground text-xs" data-testid="hills-loose-sentence">
            {looseSentence(loose)}
          </div>
        </div>
        <StepButton
          label="Less steep on loose ground"
          testid="hills-loose-minus"
          disabled={loose <= looseRange.min}
          onClick={() => store.setHills(stepLoose(hills, -1, info))}
        >
          <Minus className="size-4" />
        </StepButton>
        <span className="min-w-12 text-center font-bold text-base tabular-nums" data-testid="hills-loose">
          {loose} %
        </span>
        <StepButton
          label="Steeper on loose ground"
          testid="hills-loose-plus"
          disabled={loose >= looseRange.max}
          onClick={() => store.setHills(stepLoose(hills, 1, info))}
        >
          <Plus className="size-4" />
        </StepButton>
      </div>
      {hillsM !== null && distance !== null && (
        <p className="flex items-baseline gap-2 text-[13px]" data-testid="hills-total">
          <b className="shrink-0 text-sm tabular-nums">{signedKm(hillsM)}</b>
          <span className="text-muted-foreground">
            {hillsM < 0
              ? `the climbs you seek take off its ${(distance / 1000).toFixed(1)} km`
              : `the hills of this route count as, on top of its ${(distance / 1000).toFixed(1)} km`}
          </span>
        </p>
      )}
      {children}
    </div>
  );
}
