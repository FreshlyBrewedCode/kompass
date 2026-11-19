// Formatting for the ride list and storage lines. Pure.
import type { FileResult, ImportSummary, RideSummary } from "./types";

export function formatDistance(meters: number): string {
  return meters < 10_000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 1000)} km`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const DATE = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "numeric" });

/** "2 May 2026", or "No date" for a track without timestamps. */
export function formatDate(ride: Pick<RideSummary, "startTime">): string {
  return ride.startTime === null ? "No date" : DATE.format(new Date(ride.startTime));
}

export function summarizeImport(results: readonly FileResult[]): ImportSummary {
  const summary: ImportSummary = {
    imported: 0,
    replaced: 0,
    duplicates: 0,
    known: 0,
    failed: 0,
    withoutTime: 0,
  };
  for (const { outcome } of results) {
    switch (outcome.status) {
      case "imported":
        summary.imported++;
        if (outcome.replaced > 0) summary.replaced++;
        if (!outcome.ride.hasTime) summary.withoutTime++;
        break;
      case "duplicate":
        summary.duplicates++;
        break;
      case "known":
        summary.known++;
        break;
      case "failed":
        summary.failed++;
        break;
    }
  }
  return summary;
}

/** The one-line result: "3 imported, 1 duplicate, 1 already imported, 1 failed". */
export function describeSummary(s: ImportSummary): string {
  const parts: string[] = [];
  if (s.imported) parts.push(`${s.imported} imported`);
  if (s.duplicates) parts.push(`${s.duplicates} duplicate${s.duplicates === 1 ? "" : "s"} skipped`);
  if (s.known) parts.push(`${s.known} already imported`);
  if (s.failed) parts.push(`${s.failed} failed`);
  return parts.length > 0 ? parts.join(", ") : "Nothing to import";
}

/** What one file's outcome says, for the detail list. */
export function describeOutcome(result: FileResult): string {
  const o = result.outcome;
  switch (o.status) {
    case "imported": {
      const extra: string[] = [];
      if (o.replaced > 0) extra.push("replaced a sparser copy");
      if (!o.ride.hasTime) extra.push("no timestamps: not deduplicated, no “last ridden”");
      extra.push(...o.ride.notes);
      return extra.length > 0 ? `Imported (${extra.join("; ")})` : "Imported";
    }
    case "duplicate":
      return `Duplicate of ${o.keptSource}`;
    case "known":
      return "Already imported";
    case "failed":
      return `Failed: ${o.reason}`;
  }
}
