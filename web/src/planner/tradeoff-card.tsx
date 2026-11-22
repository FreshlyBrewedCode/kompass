// A hard limit's trade-off (docs/planner.md, "Limits as trade-offs"): opened from its marker on the
// route, in the segment inspector's place. "140 m unpaved here would save 3.8 km." Allow here adds
// the bit to this plan's exceptions; Keep the limit stops offering it for this session. The bit's
// shortcut is drawn on the map while the card is open (route-layer.ts).
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { useEffect } from "react";
import { label, pill } from "./parts";
import { usePlan, usePlanner } from "./store";
import { tradeoffKey, tradeoffLimits, tradeoffSentence } from "./tradeoffs";

const button = cn(pill, "h-9 border border-border px-3.5 hover:bg-foreground/6");

/** The open trade-off, if it is still offered. */
export function useOpenTradeoff() {
  return usePlan((s) => s.tradeoffs.find((t) => tradeoffKey(t) === s.tradeoffOpen) ?? null);
}

export function TradeoffCard() {
  const store = usePlanner();
  const t = useOpenTradeoff();
  const catalogue = usePlan((s) => s.catalogue);
  // Escape closes (not while typing)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" || el?.closest("input, textarea, [contenteditable]")) return;
      store.openTradeoff(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [store]);
  if (!t) return null;
  const key = tradeoffKey(t);
  return (
    <section
      data-testid="tradeoff-card"
      className="rounded-card border border-border bg-glass p-3.5 text-sm shadow-float backdrop-blur-xl"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={cn(label, "min-w-0 truncate")}>A shortcut past your limit</span>
        <button
          type="button"
          className="-mr-1 ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-foreground/8 hover:bg-foreground/12"
          aria-label="Close"
          data-testid="tradeoff-close"
          onClick={() => store.openTradeoff(null)}
        >
          <X className="size-4" />
        </button>
      </div>
      <p className="font-semibold text-base leading-snug" data-testid="tradeoff-sentence">
        {tradeoffSentence(t)}
      </p>
      <p className="mt-1 text-muted-foreground text-xs leading-snug">
        Your profile says {tradeoffLimits(t, catalogue)}. Allowing it here changes this plan only; the dashed
        line shows the shortcut.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="tradeoff-allow"
          className={cn(button, "border-transparent bg-signal text-signal-foreground hover:bg-signal/90")}
          onClick={() => store.allowTradeoff(key)}
        >
          <Check className="size-4" />
          Allow here
        </button>
        <button
          type="button"
          data-testid="tradeoff-keep"
          className={button}
          onClick={() => store.keepTradeoff(key)}
        >
          Keep the limit
        </button>
      </div>
    </section>
  );
}
