import { Progress } from "@/components/ui/progress";
import type { EngineSnapshot } from "@/engine/store";
import { useEngine } from "@/engine/use-engine";

const MB = 1024 * 1024;

/** "12.3 of 66.3 MB" (KB below a megabyte) */
export function bytesOf(done: number, total: number): string {
  if (total < MB) return `${Math.round(done / 1024)} of ${Math.round(total / 1024)} KB`;
  return `${(done / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`;
}

function label(s: EngineSnapshot): string {
  switch (s.status) {
    case "downloading":
      return `Downloading region data ${bytesOf(s.done, s.total)}`;
    case "loading":
      return s.total > 0 ? `Loading region data ${bytesOf(s.done, s.total)}` : "Loading region data…";
    case "error":
      return `Engine failed: ${s.message}`;
    case "ready":
      return `Engine ${s.version ?? ""}: region graph ${s.stats.info.edges.toLocaleString("en")} edges`;
    default:
      return s.version ? `Engine ${s.version}` : "Starting the engine…";
  }
}

/**
 * The engine's state, top right: a small pill (version, a pulsing dot while busy loading, errors)
 * and, while the region graph downloads or loads, a card under it with the bytes and a bar.
 */
export function EngineStatus() {
  const s = useEngine();
  const dot =
    s.status === "ready"
      ? "bg-emerald-500"
      : s.status === "error"
        ? "bg-destructive"
        : s.status === "idle"
          ? "bg-muted-foreground"
          : "animate-pulse bg-primary";
  const progress = s.status === "downloading" || s.status === "loading" ? s : null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div
        data-testid="engine-status"
        data-status={s.status}
        data-busy={s.busy}
        title={label(s)}
        className="pointer-events-auto flex h-6 items-center gap-1.5 rounded-full border bg-card/90 px-2 text-muted-foreground text-xs backdrop-blur"
      >
        <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
        {(s.status === "ready" || s.status === "idle") && s.version && (
          <>
            <span className="sr-only">Engine </span>
            <span data-testid="engine-version">{s.version}</span>
          </>
        )}
        {progress && "region"}
        {s.status === "idle" && !s.version && "engine…"}
        {s.status === "error" && <span className="text-destructive">engine failed</span>}
      </div>
      {progress && (
        <div
          data-testid="engine-progress"
          role="status"
          className="pointer-events-auto mt-2 flex w-44 flex-col gap-1 rounded-md border bg-card/95 px-2 py-1.5 text-xs backdrop-blur"
        >
          <span>{progress.status === "downloading" ? "Downloading region data" : "Loading region data"}</span>
          <span className="text-muted-foreground tabular-nums">
            {progress.total > 0 ? bytesOf(progress.done, progress.total) : "…"}
          </span>
          <Progress
            className="h-1"
            value={progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0}
          />
        </div>
      )}
    </div>
  );
}
