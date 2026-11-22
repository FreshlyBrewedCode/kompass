// The structured controls' smaller parts (#66): Detours as the spread of the tiers, the switch in
// "Map & rides", and the note at the head of the profile that this is a prototype beside the sliders.
import { cn } from "cn";
import { FlaskConical } from "lucide-react";
import { BaseRing, ChangeDot, KnobSlider, label, Switch } from "../parts";
import { usePlan, usePlanner } from "../store";
import { num, SPREAD, spreadWord, TIER_FACTOR } from "./model";

/** What the spread means, in a rider's words. */
export function spreadHint(x: number): string {
  const love = num(TIER_FACTOR.fine ** x);
  const dislike = num((TIER_FACTOR.dislike / TIER_FACTOR.fine) ** x);
  return `A way you love is worth a ${love}× longer ride than a fine one; a way you dislike counts ${dislike}× a fine one.`;
}

/**
 * Detours under the structured controls: how far the ranking pulls (`detours`, the spread of the
 * tiers, 0.5 … 2), not a floor under the factors. The ring is the base preset's value.
 */
export function SpreadRow() {
  const store = usePlanner();
  const v = usePlan((s) => s.structured?.spread ?? SPREAD.default);
  const b = usePlan((s) => s.baseParts?.spread ?? SPREAD.default);
  const changed = Math.abs(v - b) > 1e-6;
  const steps = Math.round((SPREAD.max - SPREAD.min) / SPREAD.step);
  const pos = Math.round((v - SPREAD.min) / SPREAD.step);
  const word = spreadWord(v);
  const hint = spreadHint(v);
  return (
    <div data-fade data-testid="detours" className="mt-4 rounded-control border border-border px-3 py-2">
      <div className="flex h-5 items-center gap-1.5">
        <ChangeDot on={changed} onClick={() => store.resetSpread()} />
        <span className={cn(label, "min-w-0 truncate")}>Detours</span>
        <span
          className="ml-auto shrink-0 whitespace-nowrap font-medium text-muted-foreground text-xs"
          data-testid="detours-word"
        >
          {word}
        </span>
      </div>
      <KnobSlider
        name="Detours"
        testid="detours-slider"
        value={pos}
        min={0}
        max={steps}
        step={1}
        bigStep={5}
        valueText={`${word}. ${hint}`}
        onChange={(p) => store.setSpread(SPREAD.min + p * SPREAD.step)}
        fill={[0, pos / steps]}
      >
        {changed && <BaseRing at={(b - SPREAD.min) / (SPREAD.max - SPREAD.min)} />}
      </KnobSlider>
      <div className="flex justify-between font-semibold text-2xs text-muted-foreground uppercase tracking-wider">
        <span>Stay close</span>
        <span>Go far for good ways</span>
      </div>
      <p className="mt-1 text-muted-foreground text-xs" data-testid="detours-hint">
        {hint}
      </p>
    </div>
  );
}

/** "Structured controls (prototype)": the app-level switch, in "Map & rides" next to Appearance. */
export function ControlsSwitch() {
  const store = usePlanner();
  const on = usePlan((s) => s.controls === "structured");
  const converting = usePlan((s) => s.converting);
  return (
    <div data-testid="controls-setting">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 font-semibold text-sm">Structured controls (prototype)</span>
        <Switch
          on={on || converting}
          name="Structured controls (prototype)"
          testid="controls-switch"
          onClick={() => void store.setControls(on ? "sliders" : "structured")}
        />
      </div>
      <p className="mt-0.5 text-muted-foreground text-xs leading-snug">
        {converting
          ? "Converting your profile…"
          : "Tier boards and a hills curve in place of the surface, way-type and terrain sliders. Your slider profile stays as it is: once you edit here, the two are separate."}
      </p>
    </div>
  );
}

/** At the head of the profile while the structured controls are on. */
export function PrototypeNote() {
  const store = usePlanner();
  const edited = usePlan((s) => s.structuredEdited);
  return (
    <div
      data-fade
      data-testid="controls-note"
      className="mb-1.5 flex items-center gap-2 rounded-control border border-border border-dashed px-2.5 py-1.5 text-xs"
    >
      <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground leading-snug">
        {edited
          ? "Structured controls (prototype): edited, so separate from your slider profile."
          : "Structured controls (prototype), converted from your slider profile."}
      </span>
      <button
        type="button"
        data-testid="controls-back"
        onClick={() => void store.setControls("sliders")}
        className="-my-1 h-9 shrink-0 rounded-full px-2.5 font-semibold hover:bg-foreground/8"
      >
        Sliders
      </button>
    </div>
  );
}
