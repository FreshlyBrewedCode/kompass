// The inspect panel: every attribute of a tapped way, labelled from the manifest (the planner shows it
// while "Inspect a way" is on, docs/planner.md).
import { X } from "lucide-react";
import { formatAttribute } from "@/map/info";
import type { PickedEdge } from "@/map/inspect";
import type { Manifest } from "@/map/manifest";

export function InspectPanel({
  manifest,
  edge,
  onClose,
}: {
  manifest: Manifest;
  edge: PickedEdge;
  onClose: () => void;
}) {
  return (
    <section
      data-testid="inspect-panel"
      data-edge-id={edge.id}
      className="max-h-[42dvh] overflow-y-auto rounded-card border border-border bg-glass p-3.5 text-sm shadow-float backdrop-blur-xl md:max-h-[60dvh]"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="font-bold">Way {edge.id}</div>
        <button
          type="button"
          className="-mr-1 grid size-8 place-items-center rounded-full bg-foreground/8 hover:bg-foreground/12"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
        {manifest.overlay.attributes.map((a) => (
          <div key={a.key} className="contents" data-testid={`inspect-${a.key}`}>
            <dt className="text-muted-foreground">{a.label}</dt>
            <dd className="text-right font-semibold tabular-nums">
              {formatAttribute(a, edge.properties[a.key])}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
