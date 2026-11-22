import { expect, type Page, type Request, test } from "@playwright/test";
import { node } from "../web/test/synthetic";
import { engineReady, rawScreenshot } from "./helpers";

// The engine in the browser on the synthetic fixture region (docs/engine-web.md): the graph
// downloads with progress, is cached on the device, routes offline (the planner's flows: planner.spec.ts), and matches a
// ride. Its nodes: a 6 × 6 street grid around 0°N 0°E (e2e/fixtures/build-region.ts).

const isGraphFile = (url: string) => /\/data\/graph\/.*\.kmpg(\.gz)?$/.test(url);

function requestLog(page: Page) {
  const log: Request[] = [];
  page.on("request", (r) => log.push(r));
  return log;
}

/** Waits until the service worker controls the page (it then caches the app shell on the next load). */
async function serviceWorkerReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

const route = (page: Page, preset: string, points: [number, number][]) =>
  page.evaluate(
    async ({ preset, points }) => {
      const engine = window.__kompass.engine;
      const presets = (await engine.call("presets")) as { id: string; profile: unknown }[];
      const profile = presets.find((p) => p.id === preset)?.profile;
      return (await engine.call("route", {
        waypoints: points.map(([lon, lat]) => ({ lon, lat })),
        profile,
        options: { snap_radius_m: 250, geometry: true, avoid_reuse: true },
      })) as { ok: boolean; result?: { summary: { distance_m: number }; arcs: number[] } };
    },
    { preset, points },
  );

test("the graph downloads with progress, is cached on the device, and routes offline", async ({
  page,
  context,
}, testInfo) => {
  const log = requestLog(page);
  // slow the graph files down, each one more than the last, so the download state and its progress
  // text stay visible on this tiny region (with one common delay they all landed at once and the
  // progress text could be gone before the assertion ran)
  let delayed = 0;
  await page.route(/\/data\/graph\//, async (r) => {
    delayed += 1;
    await new Promise((resolve) => setTimeout(resolve, 800 + delayed * 300));
    await r.continue();
  });
  await page.goto("./?dev");
  const status = page.getByTestId("engine-status");
  await expect(status).toHaveAttribute("data-status", "downloading");
  await expect(page.getByTestId("engine-status")).toContainText(/Downloading region data \d+ of \d+ KB/);
  await rawScreenshot(page, testInfo, "engine-downloading");
  await engineReady(page);
  const first = log.filter((r) => isGraphFile(r.url()));
  // every graph file once, as its gzip sibling
  expect(first.length).toBe(9);
  expect(first.every((r) => r.url().endsWith(".gz"))).toBe(true);
  const stats = await page.evaluate(() => window.__kompass.engine.getSnapshot().stats);
  expect(stats).toMatchObject({ cached: true, downloadedFiles: 9 });
  await page.unroute(/\/data\/graph\//);

  // a reload loads from the device: no graph file goes over the network again
  await serviceWorkerReady(page);
  log.length = 0;
  await page.reload();
  await engineReady(page);
  expect(log.filter((r) => isGraphFile(r.url()))).toEqual([]);
  expect(await page.evaluate(() => window.__kompass.engine.getSnapshot().stats?.downloadedFiles)).toBe(0);

  // offline: the app shell comes from the service worker, the graph from the device
  await context.setOffline(true);
  await page.reload();
  await engineReady(page);
  const offline = await route(page, "gravel_explorer", [node(1, 1), node(3, 0)]);
  expect(offline.ok).toBe(true);
  expect(offline.result?.summary.distance_m).toBeGreaterThan(1500);
  await context.setOffline(false);

  // everything came from the app's own origin
  const origin = new URL(page.url()).origin;
  for (const r of log) {
    if (/^(data|blob):/.test(r.url())) continue;
    expect(new URL(r.url()).origin, r.url()).toBe(origin);
  }
});

test("the bench page runs on the loaded region and reports as text", async ({ page }, testInfo) => {
  await page.goto("./?bench&run&pairs=2&rides=2");
  await engineReady(page);
  await expect(page.getByTestId("bench-status")).toHaveText("done", { timeout: 20_000 });
  await rawScreenshot(page, testInfo, "bench");
  const text = await page.getByTestId("bench-text").textContent();
  expect(text).toContain("profile compile");
  expect(text).toContain("| after load |");
  expect(text).toMatch(/region: 68 edges/);
});
