import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { node, prng, syntheticTrack, toGpx } from "../web/test/synthetic";
import { openMap } from "./helpers";

// Measurements for docs/rides.md, not a regression test: skipped unless KOMPASS_BENCH=<rides> is set.
//   KOMPASS_BENCH=500 bunx playwright test bench --project desktop   (KOMPASS_BENCH_DIR=<dir>: where the GPX files are written)
const COUNT = Number(process.env.KOMPASS_BENCH ?? 0);
test.skip(COUNT === 0, "set KOMPASS_BENCH=<number of rides> to run");
test.setTimeout(15 * 60_000);

/** a wobbly ~15 km loop around the fixture grid: about 3000 points at 5 m/s, one per second */
function loop(seed: number): [number, number][] {
  const rand = prng(seed);
  const [cx, cy] = node(2, 2);
  const radius = 0.0215 * (0.8 + 0.4 * rand());
  const vertices = 48;
  const out: [number, number][] = [];
  for (let i = 0; i <= vertices; i++) {
    const a = (2 * Math.PI * (i % vertices)) / vertices;
    const r = radius * (0.85 + 0.3 * rand());
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  out.push(out[0] as [number, number]);
  return out;
}

test("bench: import, store, layer and backup of many rides", async ({ page }) => {
  const dir = mkdtempSync(join(process.env.KOMPASS_BENCH_DIR ?? tmpdir(), "kompass-bench-"));
  try {
    mkdirSync(dir, { recursive: true });
    const day = 86_400_000;
    const start = Date.UTC(2024, 0, 1, 8);
    const files: string[] = [];
    let points = 0;
    for (let i = 0; i < COUNT; i++) {
      const track = syntheticTrack({
        path: loop(i + 1),
        start: start + i * day,
        interval: 1,
        speed: 5,
        noise: 2,
        seed: i + 1,
      });
      points += track.lat.length;
      const file = join(dir, `${new Date(start + i * day).toISOString().slice(0, 10)}_${1000 + i}.gpx`);
      writeFileSync(file, toGpx(track));
      files.push(file);
    }
    const gpxBytes = files.reduce((sum, f) => sum + statSync(f).size, 0);
    console.log(
      `bench: ${COUNT} rides, ${(points / COUNT).toFixed(0)} points each, ${(gpxBytes / 1e6).toFixed(0)} MB of GPX`,
    );

    // long main-thread tasks (> 50 ms), to see whether the UI thread is ever blocked
    await page.addInitScript(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    });
    const longTasks = () =>
      page.evaluate(() => {
        const w = window as unknown as { __longTasks: number[] };
        return w.__longTasks.splice(0);
      });
    await openMap(page, "mode=plain");
    await page.getByTestId("rides-button").click();
    await longTasks();
    const t0 = Date.now();
    await page.getByTestId("rides-file-input").setInputFiles(files);
    await expect(page.getByTestId("rides-report")).toBeVisible({ timeout: 14 * 60_000 });
    const importMs = Date.now() - t0;
    await expect(page.getByTestId("rides-count")).toHaveText(COUNT.toLocaleString("en"));
    const stats = await page.evaluate(async () => {
      const lib = (
        window as unknown as {
          __kompass: { rides: { getSnapshot(): { rides: { bytes: number }[] }; lastLayerMs: number } };
        }
      ).__kompass.rides;
      const estimate = await navigator.storage.estimate();
      return {
        stored: lib.getSnapshot().rides.reduce((s, r) => s + r.bytes, 0),
        layerMs: lib.lastLayerMs,
        usage: estimate.usage ?? 0,
      };
    });
    console.log(
      `bench: import ${(importMs / 1000).toFixed(1)} s (${(importMs / COUNT).toFixed(0)} ms per ride)`,
    );
    console.log(
      `bench: stored ${(stats.stored / 1e6).toFixed(1)} MB (${(stats.stored / COUNT / 1024).toFixed(1)} kB per ride), browser usage ${(stats.usage / 1e6).toFixed(1)} MB`,
    );
    console.log(`bench: layer fetch (worker build + transfer) ${stats.layerMs.toFixed(0)} ms`);
    console.log(`bench: main-thread long tasks during the import: [${(await longTasks()).join(", ")}] ms`);

    // a cold start: the list, then the layer
    const reloaded = Date.now();
    await page.reload();
    await expect(page.getByTestId("rides-count")).toHaveText(COUNT.toLocaleString("en"));
    const listMs = Date.now() - reloaded;
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { __kompass: { map: { getSource(id: string): unknown } } }
            ).__kompass.map.getSource("rides") !== undefined,
        ),
      )
      .toBe(true);
    const layer = await page.evaluate(
      () =>
        (window as unknown as { __kompass: { rides: { lastLayerMs: number } } }).__kompass.rides.lastLayerMs,
    );
    console.log(
      `bench: after a reload the list shows ${COUNT} rides after ${listMs} ms (incl. page and map start); layer fetch ${layer.toFixed(0)} ms`,
    );

    const exported = Date.now();
    await page.getByTestId("rides-button").click();
    const download = page.waitForEvent("download");
    await page.getByTestId("rides-export").click();
    const backup = await (await download).path();
    console.log(
      `bench: export ${((Date.now() - exported) / 1000).toFixed(1)} s, ${(statSync(backup).size / 1e6).toFixed(1)} MB`,
    );

    await page.getByTestId("rides-delete-all").click();
    await page.getByTestId("rides-confirm-delete").click();
    await expect(page.getByTestId("rides-count")).toHaveText("0");
    const restored = Date.now();
    await page.getByTestId("rides-restore-input").setInputFiles(backup);
    await expect(page.getByTestId("rides-report-text")).toContainText("Backup restored", {
      timeout: 10 * 60_000,
    });
    console.log(`bench: restore ${((Date.now() - restored) / 1000).toFixed(1)} s`);
    await expect(page.getByTestId("rides-count")).toHaveText(COUNT.toLocaleString("en"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
