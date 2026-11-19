import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { startEngine } from "@/engine/client";
import type { LngLat } from "@/engine/protocol";

// Two demo points: Zurich main station → Bern station (a hello-world through the engine chain).
const FROM: LngLat = { lng: 8.5402, lat: 47.3782 };
const TO: LngLat = { lng: 7.4391, lat: 46.949 };

type State =
  | { status: "loading" }
  | { status: "ready"; version: string; km: number }
  | { status: "error"; error: string };

/** Asks the engine worker for its version and one distance, and shows both. */
export function EngineStatus() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const engine = startEngine();
    Promise.all([engine.call("version"), engine.call("distance", { from: FROM, to: TO })])
      .then(([version, metres]) => setState({ status: "ready", version, km: metres / 1000 }))
      .catch((error: unknown) => setState({ status: "error", error: String(error) }));
    return () => engine.terminate();
  }, []);

  return (
    <Card
      data-testid="engine-status"
      data-status={state.status}
      className="pointer-events-auto gap-0 bg-card/90 px-3 py-2 text-sm backdrop-blur"
    >
      <div className="font-semibold">Kompass</div>
      {state.status === "loading" && <div className="text-muted-foreground">Starting the engine…</div>}
      {state.status === "error" && <div className="text-destructive">Engine failed: {state.error}</div>}
      {state.status === "ready" && (
        <div className="text-muted-foreground">
          Engine <span data-testid="engine-version">{state.version}</span> · Zurich → Bern{" "}
          <span data-testid="engine-distance">{state.km.toFixed(1)}</span> km
        </div>
      )}
    </Card>
  );
}
