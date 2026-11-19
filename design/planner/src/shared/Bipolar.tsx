import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/** A slider that is neutral in the middle: left of it avoids, right of it seeks. Wraps the shadcn Slider. */
export function Bipolar({ value, onChange, color = "var(--primary)", vertical, className, label }: { value: number; onChange: (v: number) => void; color?: string; vertical?: boolean; className?: string; label: string }) {
  const size = `${Math.abs(value) / 2}%`;
  const fill = vertical
    ? { left: 0, right: 0, height: size, ...(value >= 0 ? { bottom: "50%" } : { top: "50%" }) }
    : { top: 0, bottom: 0, width: size, ...(value >= 0 ? { left: "50%" } : { right: "50%" }) };
  return (
    <div className={cn("relative flex items-center justify-center", vertical ? "h-full w-5" : "h-5 w-full", className)}>
      <div className={cn("pointer-events-none absolute rounded-full bg-[var(--track,var(--muted))]", vertical ? "inset-y-0 w-1" : "inset-x-0 h-1")}>
        <div className="absolute rounded-full" style={{ ...fill, background: color, opacity: value < 0 ? 0.45 : 1 }} />
      </div>
      <div className={cn("pointer-events-none absolute bg-current opacity-40", vertical ? "h-px w-3" : "h-3 w-px")} />
      <Slider
        aria-label={label}
        min={-100}
        max={100}
        step={10}
        orientation={vertical ? "vertical" : "horizontal"}
        value={[value]}
        onValueChange={(v) => onChange(Array.isArray(v) ? (v[0] as number) : (v as number))}
        className="[&_[data-slot=slider-range]]:hidden [&_[data-slot=slider-track]]:bg-transparent [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-2 [&_[data-slot=slider-thumb]]:border-[var(--thumb-border,var(--foreground))] [&_[data-slot=slider-thumb]]:bg-[var(--thumb,var(--background))] [&_[data-slot=slider-thumb]]:shadow-sm data-vertical:[&>div]:min-h-0"
      />
    </div>
  );
}
