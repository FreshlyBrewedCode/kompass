// The engine benchmark page (`?bench`, docs/engine-web.md): how the "50 km route under 1 s on a
// phone" bar is measured on the phone itself. `?bench&run` starts it right away; `&pairs=`, `&rides=`,
// `&seed=` and `&geometry=lazy` change what it runs.
import { useEffect, useState } from "react";
import { EngineStatus } from "@/components/engine-status";
import { Button } from "@/components/ui/button";
import type { GeometryMode } from "@/engine/protocol";
import { engineStore } from "@/engine/store";
import { useEngine } from "@/engine/use-engine";
import { loadRegion, resolveDataUrl } from "@/map/region";
import { type BenchEngine, type BenchReport, reportText, runBench } from "./bench";

const params = new URLSearchParams(location.search);
const num = (name: string, fallback: number) => {
  const v = Number(params.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const OPTIONS = { seed: num("seed", 19), pairs: num("pairs", 20), rides: num("rides", 20) };
const GEOMETRY: GeometryMode = params.get("geometry") === "lazy" ? "lazy" : "eager";

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full border-collapse text-xs tabular-nums">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} className="border-b px-1 py-1 text-left font-medium text-muted-foreground">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.join("|")}>
            {r.map((c, i) => (
              <td key={`${head[i]}`} className="border-b px-1 py-1">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "–");

export default function BenchPage() {
  const engine = engineStore();
  const state = useEngine();
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState<BenchReport | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadRegion(resolveDataUrl(location.search, document.baseURI)).then((region) => {
      if (region.status !== "ready") {
        setProblem(region.status === "error" ? region.message : "No region data");
        return;
      }
      if (!region.manifest.graph) {
        setProblem("The region has no graph (run kompass compile)");
        return;
      }
      void engine.load(region.dataUrl, region.manifest.graph, GEOMETRY).catch(() => undefined);
    });
  }, [engine]);

  const run = async () => {
    if (state.status !== "ready") return;
    setReport(null);
    const presets = await engine.call("presets");
    const client = engine.client;
    const timed: BenchEngine = { timed: (method, p) => client.timed(method, p as never) };
    try {
      setReport(await runBench(timed, state.stats, presets, { ...OPTIONS, onStatus: setStatus }));
    } catch (error) {
      setStatus(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const ready = state.status === "ready";
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once, when the graph is ready
  useEffect(() => {
    if (ready && params.has("run")) void run();
  }, [ready]);

  const text = report ? reportText(report) : "";
  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-3 overflow-auto p-4 text-sm">
      <header className="flex items-center justify-between gap-2">
        <h1 className="font-semibold text-base">Engine bench</h1>
        <EngineStatus />
      </header>
      <p className="text-muted-foreground text-xs">
        Seeded random routes at ~10 / 50 / 100 km with the two main presets, in the engine worker, on the
        loaded region ({OPTIONS.pairs} pairs per distance, {OPTIONS.rides} rides matched, geometry {GEOMETRY}
        ). The pairs come from the graph on this device and are never shown or stored.
      </p>
      {problem && <p className="text-destructive">{problem}</p>}
      <div className="flex items-center gap-2">
        <Button
          data-testid="bench-run"
          disabled={!ready || (status !== "" && status !== "done" && !report)}
          onClick={run}
        >
          Run
        </Button>
        <span data-testid="bench-status" className="text-muted-foreground text-xs">
          {status}
        </span>
      </div>
      {report && (
        <>
          <Table
            head={["route", "preset", "n", "engine ms p50", "p95", "max", "trip p50", "km", "KB"]}
            rows={report.routes.map((r) => [
              r.bucket,
              r.preset,
              r.engine.n,
              f(r.engine.median),
              f(r.engine.p95),
              f(r.engine.max),
              f(r.roundTrip.median),
              f(r.km),
              Math.round(r.resultKb),
            ])}
          />
          <Table
            head={["compile", "ms p50", "p95", "max"]}
            rows={report.compile.map((c) => [c.preset, f(c.ms.median), f(c.ms.p95), f(c.ms.max)])}
          />
          <Table
            head={["wasm heap", "linear memory MB", "engine MB"]}
            rows={report.heap.map((h) => [h.label, f(h.wasmBytes / 2 ** 20), f(h.engineBytes / 2 ** 20)])}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard?.writeText(text).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              Copy as text
            </Button>
            {copied && <span className="text-muted-foreground text-xs">copied</span>}
          </div>
          <pre
            data-testid="bench-text"
            className="select-all overflow-x-auto whitespace-pre rounded-md border bg-muted p-2 text-[11px]"
          >
            {text}
          </pre>
        </>
      )}
    </main>
  );
}
