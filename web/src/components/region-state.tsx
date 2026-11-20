import { Card } from "@/components/ui/card";

/** Shown instead of the map when there is no region data at the data URL. */
export function EmptyState({ dataUrl }: { dataUrl: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <Card data-testid="region-empty" className="max-w-md gap-3 p-5 text-sm">
        <h1 className="font-semibold text-base">No region data</h1>
        <p className="text-muted-foreground">
          Kompass loads its region (the base map and the routing overlay) at run time and found nothing at{" "}
          <code className="break-all text-foreground">{dataUrl}</code>.
        </p>
        <p className="text-muted-foreground">
          Build a region with the pipeline and serve it there, point the app at another place with{" "}
          <code className="text-foreground">?data=</code>, or start the dev server with{" "}
          <code className="text-foreground">KOMPASS_DATA_DIR</code> set to a build directory.
        </p>
      </Card>
    </div>
  );
}

/** The data is there but cannot be used (an unreadable or invalid manifest). */
export function ErrorState({ dataUrl, message }: { dataUrl: string; message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <Card data-testid="region-error" className="max-w-md gap-3 p-5 text-sm">
        <h1 className="font-semibold text-base text-destructive">The region data cannot be used</h1>
        <p data-testid="region-error-message">{message}</p>
        <p className="text-muted-foreground">
          Loaded from <code className="break-all text-foreground">{dataUrl}</code>. Rebuild the region, or
          check that the manifest and the PMTiles files sit together.
        </p>
      </Card>
    </div>
  );
}
