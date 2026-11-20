import { expect, type Page, type Request, test } from "@playwright/test";
import { node } from "../web/test/synthetic";
import { engineReady, openMap, rawScreenshot, screenshot, waitIdle } from "./helpers";

// The engine in the browser on the synthetic fixture region (docs/engine-web.md): the graph
// downloads with progress, is cached on the device, routes in the lab UI and offline, and matches a
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
        options: { snap_radius_m: 250, geometry: true },
      })) as { ok: boolean; result?: { summary: { distance_m: number }; arcs: number[] } };
    },
    { preset, points },
  );

test("the graph downloads with progress, is cached on the device, and routes offline", async ({
  page,
  context,
}, testInfo) => {
  const log = requestLog(page);
  // slow the graph files down a little, so the download state is visible on this tiny region
  await page.route(/\/data\/graph\//, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await r.continue();
  });
  await page.goto("./?dev");
  const status = page.getByTestId("engine-status");
  await expect(status).toHaveAttribute("data-status", "downloading");
  await expect(page.getByTestId("engine-progress")).toContainText(/Downloading region data\d+ of \d+ KB/);
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

/** The lab's two lines as drawn: main and compare, their coordinates. */
const labLines = (page: Page) =>
  page.evaluate(() => {
    const map = window.__kompass.map as unknown as {
      getSource(id: string):
        | {
            serialize(): {
              data: { features: { properties: { route: string }; geometry: { coordinates: number[][] } }[] };
            };
          }
        | undefined;
    };
    const data = map.getSource("lab-routes")?.serialize().data;
    return Object.fromEntries(
      (data?.features ?? []).map((f) => [f.properties.route, f.geometry.coordinates]),
    );
  });

async function tapAt(page: Page, [lon, lat]: [number, number]) {
  const p = await page.evaluate((at) => window.__kompass.map.project(at), [lon, lat] as [number, number]);
  const box = (await page.getByTestId("map").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + p.x, box.y + p.y);
}

test("the route lab: A, B and a waypoint, a preset, a second preset to compare", async ({
  page,
}, testInfo) => {
  await openMap(page, "lab");
  await engineReady(page);
  const lab = page.getByTestId("planner-lab");
  await expect(lab).toBeVisible();
  await expect(lab).toContainText("temporary");
  await expect(page.getByTestId("lab-hint")).toHaveText("Tap the map to set A.");
  // the lab draws on the upper part of the map, clear of its panel at the bottom
  await page.evaluate(() => {
    const map = window.__kompass.map as unknown as { jumpTo(o: object): void };
    map.jumpTo({ center: [-0.002, -0.004], zoom: 13.5 });
  });
  await waitIdle(page);

  await tapAt(page, node(1, 1));
  await expect(page.getByTestId("lab-count")).toHaveText("1 waypoint");
  await expect(page.getByTestId("lab-hint")).toHaveText("Tap the map to set B.");
  await tapAt(page, node(3, 0));
  await expect(page.getByTestId("lab-count")).toHaveText("2 waypoints");
  await expect(page.getByTestId("lab-totals")).toBeVisible();
  const direct = Number(await page.getByTestId("lab-totals-km").textContent());
  expect(direct).toBeGreaterThanOrEqual(1.4);

  // a waypoint in the middle of the way: a longer route through it
  await tapAt(page, node(3, 2));
  await expect(page.getByTestId("lab-count")).toHaveText("3 waypoints");
  await expect
    .poll(async () => Number(await page.getByTestId("lab-totals-km").textContent()))
    .toBeGreaterThan(direct);
  await expect(page.getByTestId("lab-waypoint")).toHaveCount(3);
  // tap it again: removed
  await page.getByTestId("lab-waypoint").nth(2).click();
  await expect(page.getByTestId("lab-count")).toHaveText("2 waypoints");
  await expect.poll(async () => Number(await page.getByTestId("lab-totals-km").textContent())).toBe(direct);

  // the two main presets take different ways: both lines on the map
  await page.getByTestId("lab-preset").selectOption("gravel_explorer");
  await page.getByTestId("lab-compare").selectOption("paved_quiet");
  await expect(page.getByTestId("lab-compare-totals")).toBeVisible();
  await expect.poll(async () => Object.keys(await labLines(page)).sort()).toEqual(["compare", "main"]);
  const lines = await labLines(page);
  expect(JSON.stringify(lines.main)).not.toBe(JSON.stringify(lines.compare));
  const drawnLines = await page.evaluate(
    () => window.__kompass.map.queryRenderedFeatures({ layers: ["lab-routes-line"] }).length,
  );
  expect(drawnLines).toBeGreaterThanOrEqual(2);
  await screenshot(page, testInfo, "lab");
});

test("the bench page runs on the loaded region and reports as text", async ({ page }, testInfo) => {
  await page.goto("./?bench&run&pairs=2&rides=2");
  await engineReady(page);
  await expect(page.getByTestId("bench-status")).toHaveText("done", { timeout: 20_000 });
  await rawScreenshot(page, testInfo, "bench");
  const text = await page.getByTestId("bench-text").textContent();
  expect(text).toContain("profile compile");
  expect(text).toContain("| after load |");
  expect(text).toMatch(/region: 60 edges/);
});
