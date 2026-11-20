// The ride library's UI: deliberately minimal and replaceable (the planner design round re-skins it).
// Everything here is presentation; the logic lives in src/rides/ (state.ts is what it reads and calls).
import { Bike, ChevronDown, Download, Eye, EyeOff, FolderUp, HardDrive, Trash2, Upload } from "lucide-react";
import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { ExploredSummary, MatchingStatus } from "@/components/rides-matching";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Toggle } from "@/components/ui/toggle";
import { backupFilename, downloadBlob } from "@/rides/download";
import { describeOutcome, formatBytes, formatDate, formatDistance, formatDuration } from "@/rides/format";
import type { RideMatchInfo } from "@/rides/matcher";
import type { RidesSnapshot, RidesState } from "@/rides/state";
import { formatShare } from "@/rides/summary";
import type { RideSummary } from "@/rides/types";

/**
 * `.gpx`/`.fit`, a `.zip` of them and the `.kompassrides` backup, plus the MIME types iOS and Android
 * attach (or none: unknown types must stay selectable, hence the octet-stream).
 */
const ACCEPT =
  ".gpx,.fit,.zip,.kompassrides,.GPX,.FIT,.ZIP,application/gpx+xml,application/vnd.ant.fit,application/zip,application/x-zip-compressed,application/octet-stream,application/xml,text/xml";

const PAGE = 60;

/** An invisible list item that asks for the next page when it scrolls into view. */
function GrowSentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) latest.current();
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <li ref={ref} data-testid="rides-more" aria-hidden className="h-8" />;
}

/** The entry in the map chrome: opens the panel, and toggles the "My rides" layer. */
export function RidesButton({
  count,
  open,
  visible,
  onToggleOpen,
  onToggleVisible,
}: {
  count: number;
  open: boolean;
  visible: boolean;
  onToggleOpen: () => void;
  onToggleVisible: (visible: boolean) => void;
}) {
  return (
    <div className="pointer-events-auto flex items-center gap-1">
      <Button
        variant="outline"
        data-testid="rides-button"
        aria-expanded={open}
        onClick={onToggleOpen}
        className="gap-1.5 bg-card/90 backdrop-blur"
      >
        <Bike />
        Rides
        <span data-testid="rides-count" className="tabular-nums text-muted-foreground">
          {count.toLocaleString("en")}
        </span>
      </Button>
      <Toggle
        variant="outline"
        pressed={visible}
        onPressedChange={onToggleVisible}
        aria-label="Show my rides on the map"
        data-testid="rides-toggle"
        className="bg-card/90 backdrop-blur data-[state=on]:bg-card/90"
      >
        {visible ? <Eye /> : <EyeOff />}
      </Toggle>
    </div>
  );
}

export type RidesPanelProps = {
  snapshot: RidesSnapshot;
  state: RidesState;
  selectedId: string | null;
  onSelect: (ride: RideSummary) => void;
  onClose: () => void;
};

export function RidesPanel({ snapshot, state, selectedId, onSelect, onClose }: RidesPanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const { rides, busy, report, storage, phase } = snapshot;
  // long libraries render in pages as the list is scrolled: 1000 rows at once would block the UI thread
  const [shown, setShown] = useState(PAGE);

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // the same file can be picked again
    void state.importFiles(files);
  };
  const onRestore = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void state.importBackup(file);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void state.importFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <Card
      data-testid="rides-panel"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className="pointer-events-auto absolute inset-x-2 bottom-9 z-10 h-[54%] gap-0 overflow-hidden bg-card/97 p-0 backdrop-blur md:top-3 md:right-3 md:left-auto md:h-auto md:w-96"
    >
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="font-semibold">
          Rides{" "}
          <span className="font-normal text-muted-foreground tabular-nums">
            {rides.length.toLocaleString("en")}
          </span>
        </h2>
        <Button
          size="icon"
          variant="ghost"
          className="-mr-1 size-8"
          aria-label="Close rides"
          onClick={onClose}
        >
          <ChevronDown />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={onPick}
          data-testid="rides-file-input"
          className="sr-only"
          tabIndex={-1}
        />
        <button
          type="button"
          data-testid="rides-drop"
          data-dragging={dragging}
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm md:flex-col md:gap-1 md:py-3 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:border-primary data-[dragging=true]:bg-accent disabled:opacity-60"
        >
          <Upload className="size-5 text-muted-foreground" />
          <span className="font-medium">Add GPX or FIT files, or a zip</span>
          <span className="hidden text-muted-foreground text-xs md:inline">
            choose them or drop them here
          </span>
        </button>

        {busy && (
          <div data-testid="rides-busy" className="space-y-1.5 text-xs">
            <div className="flex justify-between text-muted-foreground">
              <span>{busy.label}…</span>
              <span className="tabular-nums">{busy.total > 0 ? `${busy.done} / ${busy.total}` : ""}</span>
            </div>
            <Progress value={busy.total > 0 ? (busy.done / busy.total) * 100 : undefined} />
          </div>
        )}

        <MatchingStatus snapshot={snapshot} state={state} />
        <ExploredSummary snapshot={snapshot} />

        {report && <ReportView report={report} onDismiss={() => state.dismissReport()} />}

        {phase === "error" && (
          <p data-testid="rides-error" className="text-destructive text-sm">
            The ride library is not available: {snapshot.error}
          </p>
        )}

        {phase === "ready" && rides.length === 0 && !busy && (
          <p data-testid="rides-empty" className="text-muted-foreground text-sm">
            No rides yet. Rides stay on this device: nothing is uploaded.
          </p>
        )}

        <ul data-testid="rides-list" className="-mx-1 space-y-0.5">
          {rides.slice(0, shown).map((ride) => (
            <RideRow
              key={ride.id}
              ride={ride}
              match={snapshot.matches.get(ride.id)}
              selected={ride.id === selectedId}
              onSelect={() => onSelect(ride)}
              onDelete={() => void state.deleteRide(ride.id)}
            />
          ))}
          {shown < rides.length && <GrowSentinel onVisible={() => setShown((n) => n + PAGE)} />}
        </ul>
      </div>

      <footer className="space-y-2 border-t px-3 py-2 text-xs">
        <div data-testid="rides-storage" className="flex items-center gap-1.5 text-muted-foreground">
          <HardDrive className="size-3.5 shrink-0" />
          <span>
            {formatBytes(rides.reduce((sum, r) => sum + r.bytes, 0))} of rides
            {storage.usage !== null && storage.quota !== null
              ? ` · browser uses ${formatBytes(storage.usage)} of ${formatBytes(storage.quota)}`
              : ""}
          </span>
        </div>
        <div
          className="flex items-center gap-2"
          data-testid="rides-persistence"
          data-persisted={String(storage.persisted)}
        >
          {storage.persisted === true ? (
            <span className="text-muted-foreground">Persistent: the browser keeps it.</span>
          ) : storage.persisted === false ? (
            <>
              <span className="text-muted-foreground">Not persistent: the browser may clear it.</span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 px-2 text-xs"
                onClick={() => void state.requestPersistence()}
              >
                Keep it
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">Persistent storage is not available.</span>
          )}
        </div>
        <input
          ref={backupInput}
          type="file"
          onChange={onRestore}
          data-testid="rides-restore-input"
          className="sr-only"
          tabIndex={-1}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="rides-export"
            disabled={busy !== null || rides.length === 0}
            onClick={async () => {
              const blob = await state.exportBackup();
              if (blob) downloadBlob(blob, backupFilename());
            }}
          >
            <Download />
            Export
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="rides-restore"
            disabled={busy !== null}
            onClick={() => backupInput.current?.click()}
          >
            <FolderUp />
            Restore
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="rides-delete-all"
            className="ml-auto text-destructive hover:text-destructive"
            disabled={busy !== null || rides.length === 0}
            onClick={() => setConfirmAll(true)}
          >
            <Trash2 />
            Delete all
          </Button>
        </div>
      </footer>

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent data-testid="rides-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all {rides.length} rides?</AlertDialogTitle>
            <AlertDialogDescription>
              They are removed from this device. Export a backup first if you want to keep them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="rides-confirm-delete" onClick={() => void state.deleteAll()}>
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ReportView({
  report,
  onDismiss,
}: {
  report: NonNullable<RidesSnapshot["report"]>;
  onDismiss: () => void;
}) {
  const [all, setAll] = useState(false);
  const details = report.kind === "files" ? report.results : [];
  // failures and notes first: those are the ones worth reading
  const interesting = details.filter(
    (r) =>
      r.outcome.status === "failed" || (r.outcome.status === "imported" && r.outcome.ride.notes.length > 0),
  );
  const shown = (all ? details : interesting).slice(0, 200);
  return (
    <div
      data-testid="rides-report"
      data-kind={report.kind}
      className={`rounded-md border px-2.5 py-2 text-xs ${report.kind === "error" ? "border-destructive/40 text-destructive" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span data-testid="rides-report-text">{report.text}</span>
        <button
          type="button"
          className="text-muted-foreground underline-offset-2 hover:underline"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
      {details.length > 0 && (
        <>
          {shown.length > 0 && (
            <ul data-testid="rides-report-details" className="mt-1.5 space-y-0.5 text-muted-foreground">
              {shown.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: file names can repeat
                <li key={i} className="break-words">
                  <span className="font-medium text-foreground">{r.file}</span>: {describeOutcome(r)}
                </li>
              ))}
            </ul>
          )}
          {details.length > interesting.length && (
            <button
              type="button"
              className="mt-1.5 text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setAll(!all)}
            >
              {all ? "Show problems only" : `Show all ${details.length} files`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function RideRow({
  ride,
  match,
  selected,
  onSelect,
  onDelete,
}: {
  ride: RideSummary;
  match: RideMatchInfo | undefined;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const duration =
    ride.startTime !== null && ride.endTime !== null ? formatDuration(ride.endTime - ride.startTime) : null;
  return (
    <li
      data-testid="ride-row"
      data-ride-id={ride.id}
      data-selected={selected}
      // long lists: skip layout and paint for rows that are off screen
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 3.25rem" }}
      className="flex items-center gap-1 rounded-md data-[selected=true]:bg-accent"
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 rounded-md px-1 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm">{formatDate(ride)}</span>
          <span className="tabular-nums text-sm">{formatDistance(ride.distanceM)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
          {duration && <span>{duration}</span>}
          <span className="tabular-nums">{ride.pointCount.toLocaleString("en")} points</span>
          {!ride.hasTime && (
            <span data-testid="ride-no-time" className="rounded bg-muted px-1">
              no timestamps
            </span>
          )}
          {match && !match.outside && match.share !== null && (
            <span data-testid="ride-match" className="tabular-nums">
              {formatShare(match.share)} matched
            </span>
          )}
          {match?.outside && (
            <span data-testid="ride-outside" className="rounded bg-muted px-1">
              outside the region
            </span>
          )}
          {ride.alsoSeenAs.length > 0 && (
            <span
              data-testid="ride-also"
              title={ride.alsoSeenAs.join(", ")}
              className="rounded bg-muted px-1"
            >
              +{ride.alsoSeenAs.length} copy
            </span>
          )}
        </div>
        <div className="truncate text-muted-foreground text-xs">{ride.name ?? ride.source}</div>
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="size-8 shrink-0 text-muted-foreground"
        aria-label={`Delete ride of ${formatDate(ride)}`}
        data-testid="ride-delete"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </li>
  );
}
