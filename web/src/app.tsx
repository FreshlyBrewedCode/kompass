import { cn } from "cn";
import { lazy, Suspense, useEffect, useState } from "react";
import { EmptyState, ErrorState } from "@/components/region-state";
import { loadRegion, type RegionState, resolveDataUrl } from "@/map/region";
import { card, EngineBadge, Mark } from "@/planner/parts";

// the planner shell (src/planner/) with MapLibre: the first paint does not wait for it
const PlannerScreen = lazy(() => import("@/planner/shell").then((m) => ({ default: m.PlannerScreen })));

function useRegion(): RegionState {
  const [state, setState] = useState<RegionState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void loadRegion(resolveDataUrl(location.search, document.baseURI)).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function App() {
  const region = useRegion();
  return (
    <main className="relative h-dvh w-full overflow-hidden">
      {region.status === "ready" ? (
        <Suspense fallback={null}>
          <PlannerScreen manifest={region.manifest} dataUrl={region.dataUrl} />
        </Suspense>
      ) : (
        <>
          {region.status === "empty" ? (
            <EmptyState dataUrl={region.dataUrl} />
          ) : region.status === "error" ? (
            <ErrorState dataUrl={region.dataUrl} message={region.message} />
          ) : null}
          <div className="absolute top-[max(var(--gutter),env(safe-area-inset-top))] left-(--gutter)">
            <EngineBadge
              className={cn(card, "relative flex size-10 items-center justify-center rounded-full")}
            >
              <Mark size={20} />
            </EngineBadge>
          </div>
        </>
      )}
    </main>
  );
}
