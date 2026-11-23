// The pressed point's coordinates in the map's context menu (docs/planner.md, "The segment inspector"):
// a quiet row in the inspector, and a small card of its own where the press hit no way. The copy button
// writes exactly the text shown; without a clipboard (or when it refuses) the text is selected instead.
import { cn } from "cn";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { label } from "../parts";
import { coordsText } from "./model";

type Copied = "idle" | "copied" | "failed";
/** how long the feedback stays */
const FEEDBACK_MS = 1600;

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Selects an element's text, so the rider can copy it by hand. */
function selectText(el: HTMLElement | null) {
  const sel = el ? window.getSelection() : null;
  if (!el || !sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** `lat, lon` of a point (`[lon, lat]`), with a copy button and its feedback (announced). */
export function Coordinates({ at, className }: { at: [number, number]; className?: string }) {
  const text = coordsText(at);
  const [state, setState] = useState<Copied>("idle");
  const ref = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new point starts without feedback
  useEffect(() => setState("idle"), [text]);
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    const ok = await writeClipboard(text);
    if (!ok) selectText(ref.current);
    setState(ok ? "copied" : "failed");
  };
  return (
    <div
      data-testid="press-coords"
      className={cn("flex items-center gap-1 text-2xs text-muted-foreground", className)}
    >
      <span ref={ref} data-testid="press-coords-text" className="select-all font-medium tabular-nums">
        {text}
      </span>
      <button
        type="button"
        data-testid="press-coords-copy"
        aria-label="Copy coordinates"
        title="Copy coordinates"
        onClick={copy}
        className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-foreground/8 hover:text-foreground"
      >
        {state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <span role="status" data-testid="press-coords-status" className="font-semibold">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed: selected" : ""}
      </span>
    </div>
  );
}

/** The context menu where the press hit no way: the point's coordinates only. */
export function PointCard({ at, onClose }: { at: [number, number]; onClose: () => void }) {
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
  return (
    <section
      data-testid="point-card"
      className="rounded-card border border-border bg-glass p-3.5 text-sm shadow-float backdrop-blur-xl"
    >
      <div className="flex items-center gap-2">
        <span className={cn(label, "min-w-0 truncate")}>This point</span>
        <span className="shrink-0 text-2xs text-muted-foreground">no way here</span>
        <button
          type="button"
          className="-mr-1 ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-foreground/8 hover:bg-foreground/12"
          aria-label="Close"
          data-testid="point-card-close"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <Coordinates at={at} />
    </section>
  );
}
