import { useEffect, useState } from "react";
import { startEngine } from "@/engine/client";
import type { LngLat } from "@/engine/protocol";

// Two demo points: Zurich main station → Bern station (a hello-world through the engine chain).
const FROM: LngLat = { lng: 8.5402, lat: 47.3782 };
const TO: LngLat = { lng: 7.4391, lat: 46.949 };

type State =
  | { status: "loading" }
  | { status: "ready"; version: string; km: number }
  | { status: "error"; error: string };

/** A small pill: the engine worker answered (it proves the wasm chain), with its version. */
export function EngineStatus() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const engine = startEngine();
    Promise.all([engine.call("version"), engine.call("distance", { from: FROM, to: TO })])
      .then(([version, metres]) => setState({ status: "ready", version, km: metres / 1000 }))
      .catch((error: unknown) => setState({ status: "error", error: String(error) }));
    return () => engine.terminate();
  }, []);

  const dot =
    state.status === "ready"
      ? "bg-emerald-500"
      : state.status === "error"
        ? "bg-destructive"
        : "bg-muted-foreground";
  return (
    <div
      data-testid="engine-status"
      data-status={state.status}
      title={
        state.status === "ready"
          ? `Engine ${state.version} answered: Zurich → Bern ${state.km.toFixed(1)} km`
          : state.status === "error"
            ? `Engine failed: ${state.error}`
            : "Starting the engine…"
      }
      className="pointer-events-auto flex h-6 items-center gap-1.5 rounded-full border bg-card/90 px-2 text-xs text-muted-foreground backdrop-blur"
    >
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
      {state.status === "ready" && (
        <>
          <span className="sr-only">Engine </span>
          <span data-testid="engine-version">{state.version}</span>
          <span className="sr-only">
            , Zurich → Bern <span data-testid="engine-distance">{state.km.toFixed(1)}</span> km
          </span>
        </>
      )}
      {state.status === "loading" && "engine…"}
      {state.status === "error" && <span className="text-destructive">engine failed</span>}
    </div>
  );
}
