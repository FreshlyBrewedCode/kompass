import type { EngineSnapshot } from "@/engine/store";
import { useEngine } from "@/engine/use-engine";

const MB = 1024 * 1024;

/** "12.3 of 63.0 MB" */
export function bytesOf(done: number, total: number): string {
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

/** A small pill: the engine worker's state (version, region data download and load, errors). */
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
  const share = s.status === "downloading" || s.status === "loading" ? s.done / Math.max(1, s.total) : null;
  return (
    <div
      data-testid="engine-status"
      data-status={s.status}
      data-busy={s.busy}
      title={label(s)}
      className="pointer-events-auto flex h-6 items-center gap-1.5 rounded-full border bg-card/90 px-2 text-muted-foreground text-xs backdrop-blur"
    >
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
      {(s.status === "downloading" || s.status === "loading") && (
        <span data-testid="engine-progress" className="tabular-nums">
          {s.status === "downloading"
            ? `region data ${bytesOf(s.done, s.total)}`
            : `loading ${s.total > 0 ? `${Math.round((share ?? 0) * 100)} %` : "…"}`}
        </span>
      )}
      {(s.status === "ready" || s.status === "idle") && s.version && (
        <>
          <span className="sr-only">Engine </span>
          <span data-testid="engine-version">{s.version}</span>
        </>
      )}
      {s.status === "idle" && !s.version && "engine…"}
      {s.status === "error" && <span className="text-destructive">engine failed</span>}
    </div>
  );
}
