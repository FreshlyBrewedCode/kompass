// Drives the browser benchmark in headless Chromium (the nix one: KOMPASS_E2E_CHROMIUM).
//   bun engine/spike/web/drive.ts --port 7960 --out <file.json> --mode spin|load|bench [--rate 4] [--where worker|main]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    out: { type: "string" },
    mode: { type: "string" },
    rate: { type: "string" },
    where: { type: "string" },
    source: { type: "string" },
    pairs: { type: "string" },
    limit: { type: "string" },
    algos: { type: "string" },
  },
});
const port = Number(values.port ?? 7960);
const rate = Number(values.rate ?? 1);
const where = values.where ?? "worker";
const mode = values.mode ?? "bench";

const browser = await chromium.launch({
  headless: true,
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
});
const page = await browser.newPage();
page.on("console", (m) => console.log(`[page] ${m.text()}`));
await page.goto(`http://127.0.0.1:${port}/bench.html`);
await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
const cdp = await page.context().newCDPSession(page);

type Cfg = Record<string, unknown>;
const call = (fn: "runWorker" | "runMain", cfg: Cfg) =>
  page.evaluate(
    ([f, c]) => (window as unknown as Record<string, (c: unknown) => Promise<unknown>>)[f as string]?.(c),
    [fn, cfg] as const,
  );
const runner = where === "main" ? "runMain" : "runWorker";

const results: Record<string, unknown> = {
  rate,
  where,
  mode,
  ua: await page.evaluate(() => navigator.userAgent),
};
if (mode === "spin") {
  // does DevTools CPU throttling reach the worker? same busy loop, unthrottled and throttled
  for (const r of [1, 4, 6]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: r });
    results[`worker_x${r}`] = await call("runWorker", { spin: 300_000_000 });
    results[`main_x${r}`] = await call("runMain", { spin: 300_000_000 });
  }
} else {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const algos = (values.algos ?? "astar,bidi,alt-bidi,astar-lazy").split(",");
  const cells: [number, number, string][] = [];
  if (mode === "bench") {
    for (const p of [0, 1])
      for (const b of [0, 1, 2]) {
        for (const a of algos) cells.push([p, b, a]);
        if (b === 1 && !values.algos) cells.push([p, b, "dijkstra"]);
      }
  }
  results.run = await call(runner, {
    source: values.source ?? "blob",
    pairs: Number(values.pairs ?? 100),
    limit: Number(values.limit ?? 0),
    cells,
  });
}
await browser.close();
if (values.out) writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify(results, null, 1));
