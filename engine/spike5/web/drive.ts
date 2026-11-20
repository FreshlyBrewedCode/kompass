// Drives the spike #5 browser bench in headless Chromium (the nix one: KOMPASS_E2E_CHROMIUM).
//   bun engine/spike5/web/drive.ts --port 7960 --tracks 0,1,2 [--where worker|main] [--rate 4]
//     [--no-geometry] [--repeat 3] [--mode spin] [--out <file.json>]
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
    tracks: { type: "string" },
    repeat: { type: "string" },
    "no-geometry": { type: "boolean" },
  },
});
const port = Number(values.port ?? 7960);
const rate = Number(values.rate ?? 1);
const where = values.where ?? "worker";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
});
const page = await browser.newPage();
page.on("console", (m) => console.log(`[page] ${m.text()}`));
await page.goto(`http://127.0.0.1:${port}/bench.html`);
await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
const cdp = await page.context().newCDPSession(page);
const call = (fn: string, cfg: unknown) =>
  page.evaluate(
    ([f, c]) => (window as unknown as Record<string, (c: unknown) => Promise<unknown>>)[f as string]?.(c),
    [fn, cfg] as const,
  );
const results: Record<string, unknown> = { rate, where, ua: await page.evaluate(() => navigator.userAgent) };
if (values.mode === "spin") {
  for (const r of [1, 4, 6]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: r });
    results[`worker_x${r}`] = await call("runWorker", { spin: 300_000_000 });
    results[`main_x${r}`] = await call("runMain", { spin: 300_000_000 });
  }
} else {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  results.run = await call(where === "main" ? "runMain" : "runWorker", {
    geometry: !values["no-geometry"],
    tracks: (values.tracks ?? "").split(",").filter(Boolean),
    repeat: Number(values.repeat ?? 1),
  });
}
await browser.close();
if (values.out) writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
const { run } = results as { run?: Record<string, unknown> };
console.log(JSON.stringify(run ? { ...run, tracks: undefined } : results, null, 1));
