import { EngineStatus } from "@/components/engine-status";
import { MapView } from "@/components/map-view";

export function App() {
  return (
    <main className="relative h-full w-full overflow-hidden">
      <MapView />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <EngineStatus />
      </div>
    </main>
  );
}
