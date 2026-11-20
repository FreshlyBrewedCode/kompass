// The rides panel's matching parts: the progress line while rides are matched onto the map, and the
// summary of the explored map. Presentation only; the numbers come from src/rides/ (state.ts, summary.ts).
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { RidesSnapshot, RidesState } from "@/rides/state";
import { formatKm, formatShare, summarize } from "@/rides/summary";

/** Progress of the background matching, a note while it waits for the map data, or nothing. */
export function MatchingStatus({ snapshot, state }: { snapshot: RidesSnapshot; state: RidesState }) {
  const { matching, rides, matches, engineReady } = snapshot;
  if (rides.length === 0 || snapshot.phase !== "ready") return null;
  const pending = rides.filter((r) => !matches.has(r.id)).length;

  if (matching.phase === "running") {
    return (
      <div data-testid="rides-matching" data-phase="running" className="space-y-1.5 text-xs">
        <div className="flex items-center justify-between gap-2 text-muted-foreground">
          <span>Matching rides to the map…</span>
          <span className="flex items-center gap-1.5">
            <span data-testid="rides-matching-count" className="tabular-nums">
              {matching.done} / {matching.total}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="-my-1 size-6"
              aria-label="Pause matching"
              data-testid="rides-matching-pause"
              onClick={() => state.pauseMatching()}
            >
              <Pause className="size-3.5" />
            </Button>
          </span>
        </div>
        <Progress value={matching.total > 0 ? (matching.done / matching.total) * 100 : undefined} />
      </div>
    );
  }
  if (matching.phase === "paused") {
    return (
      <div
        data-testid="rides-matching"
        data-phase="paused"
        className="flex items-center justify-between gap-2 text-muted-foreground text-xs"
      >
        <span>
          Matching paused, {pending} {pending === 1 ? "ride" : "rides"} left.
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          data-testid="rides-matching-resume"
          onClick={() => state.resumeMatching()}
        >
          <Play />
          Resume
        </Button>
      </div>
    );
  }
  if (pending > 0 && !engineReady) {
    return (
      <p data-testid="rides-matching" data-phase="waiting" className="text-muted-foreground text-xs">
        Rides are matched to the map as soon as the region data is loaded.
      </p>
    );
  }
  if (matching.failed > 0) {
    return (
      <p data-testid="rides-matching" data-phase="failed" className="text-destructive text-xs">
        {matching.failed} {matching.failed === 1 ? "ride" : "rides"} could not be matched.
      </p>
    );
  }
  return null;
}

/** What the rides explored: matched rides, and the km of ways and their share of the network. */
export function ExploredSummary({ snapshot }: { snapshot: RidesSnapshot }) {
  const { rides, matches, explored, engineReady, phase } = snapshot;
  if (phase !== "ready" || rides.length === 0 || !engineReady) return null;
  const s = summarize(rides, matches, explored);
  if (s.matched === 0) return null;
  return (
    <div
      data-testid="rides-summary"
      data-matched={s.matched}
      data-outside={s.outside}
      data-edges={s.edges}
      className="space-y-0.5 rounded-md bg-muted/60 px-2.5 py-2 text-xs"
    >
      {s.km !== null && (
        <div data-testid="rides-summary-explored" className="font-medium text-sm">
          {formatKm(s.km)} of ways explored
          {s.share !== null && (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {formatShare(s.share)} of the network
            </span>
          )}
        </div>
      )}
      <div data-testid="rides-summary-rides" className="text-muted-foreground">
        {s.matched} of {s.rides} {s.rides === 1 ? "ride" : "rides"} matched
        {s.outside > 0 && ` · ${s.outside} outside the region`}
      </div>
    </div>
  );
}
