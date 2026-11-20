import { expect, type Page, test } from "@playwright/test";
import { gridLoop, node, syntheticTrack, toGpx, toZip } from "../web/test/synthetic";
import { engineReady, openMap, riddenCounts, riddenRendered, screenshot, waitIdle } from "./helpers";

// The explored map from imported rides: matched in the browser, in the background (docs/rides.md).
// Made-up rides on the fixture region's grid (an invented place around 0°N 0°E).
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 4, 2, 8, 0, 0);
const track = (path: [number, number][], start: number, seed = 1) =>
  toGpx(
    syntheticTrack({ path, start, interval: 5, noise: 2, seed, name: "Evening loop", sport: "mtb_easy" }),
  );
const gpx = (name: string, path: [number, number][], start: number, seed = 1) => ({
  name,
  mimeType: "application/gpx+xml",
  buffer: Buffer.from(track(path, start, seed)),
});
/** the 2 × 2 block loop (8 edges), ridden on two days: its edges count twice */
const loop = gpx("loop-1.gpx", gridLoop(0, 0), T0);
const loopAgain = gpx("loop-2.gpx", gridLoop(0, 0), T0 + 3 * DAY, 4);
const bigLoop = gpx("loop-3.gpx", gridLoop(2, 2, 3), T0 + DAY, 2);
/** about 110 km away from the fixture region */
const faraway = gpx(
  "far.gpx",
  [
    [1, 1],
    [1.002, 1],
    [1.004, 1.001],
    [1.006, 1.001],
  ],
  T0 + 5 * DAY,
  5,
);

const rows = (page: Page) => page.getByTestId("ride-row");
const summary = (page: Page) => page.getByTestId("rides-summary");

async function openPanel(page: Page) {
  // the ride library lives in the planner's "Map & rides"
  await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("rides-panel")).toBeVisible();
}

async function importFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId("rides-file-input").setInputFiles(files);
  await expect(page.getByTestId("rides-report")).toBeVisible({ timeout: 15_000 });
}

/** Counts the `matchRide` requests the page sends to the engine worker (set up before the page loads). */
async function countMatchCalls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __matchCalls: number };
    w.__matchCalls = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      if ((message as { method?: string } | null)?.method === "matchRide") w.__matchCalls++;
      return (post as (...args: unknown[]) => void).call(this, message, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
}
const matchCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __matchCalls: number }).__matchCalls);

test("import rides: they are matched in the background and colour the explored map", async ({
  page,
}, testInfo) => {
  await openMap(page, "layer=explored");
  await engineReady(page);
  await openPanel(page);
  await importFiles(page, [loop, loopAgain, bigLoop]);
  await expect(rows(page)).toHaveCount(3);

  // the summary appears once the rides are matched
  await expect(summary(page)).toHaveAttribute("data-matched", "3", { timeout: 20_000 });
  await expect(page.getByTestId("rides-summary-rides")).toHaveText("3 of 3 rides matched");
  // 8 edges of the small loop + 12 of the big one (a 3 × 3 block loop)
  await expect(summary(page)).toHaveAttribute("data-edges", "20");
  await expect(page.getByTestId("rides-summary-explored")).toContainText(/^\d+(\.\d)? km of ways explored/);
  await expect(page.getByTestId("rides-summary-explored")).toContainText("of the network");
  await expect(page.getByTestId("rides-matching")).toHaveCount(0); // done: no progress line left
  // each ride says how much of it matched
  await expect(page.getByTestId("ride-match")).toHaveCount(3);
  await expect(page.getByTestId("ride-match").first()).toHaveText(/^\d+(\.\d)? % matched$/);
  await expect(page.getByTestId("ride-outside")).toHaveCount(0);

  // the explored layer colours the ridden edges, stronger where they were ridden more often
  await expect(page.getByTestId("ridden-count")).toHaveText("20 edges");
  await expect.poll(() => riddenRendered(page)).toBe(20);
  const counts = [...(await riddenCounts(page)).values()];
  expect(counts.filter((c) => c === 2)).toHaveLength(8); // the loop, twice
  expect(counts.filter((c) => c === 1)).toHaveLength(12);
  await waitIdle(page);
  await screenshot(page, testInfo, "explored-from-rides");
});

test("a reload keeps the explored map and matches nothing again; deleting rides updates it", async ({
  page,
}, testInfo) => {
  await countMatchCalls(page);
  await openMap(page, "layer=explored");
  await engineReady(page);
  await openPanel(page);
  await importFiles(page, [loop, bigLoop]);
  await expect(summary(page)).toHaveAttribute("data-matched", "2", { timeout: 20_000 });
  expect(await matchCalls(page)).toBe(2);

  await page.reload();
  await waitIdle(page);
  await engineReady(page);
  // the saved matches fill the explored map at start-up, before any matching could have happened
  await expect(page.getByTestId("ridden-count")).toHaveText("20 edges");
  await expect.poll(() => riddenRendered(page)).toBe(20);
  await openPanel(page);
  await expect(summary(page)).toHaveAttribute("data-matched", "2");
  await expect(page.getByTestId("ride-match")).toHaveCount(2);
  await page.waitForTimeout(500); // a matcher that wrongly started would have asked the engine by now
  expect(await matchCalls(page)).toBe(0);
  await screenshot(page, testInfo, "explored-reload");

  // deleting a ride refolds: its edges are no longer explored
  await rows(page).filter({ hasText: "3 May 2026" }).getByTestId("ride-delete").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId("ridden-count")).toHaveText("8 edges");
  await expect.poll(() => riddenRendered(page)).toBe(8);
  await expect(summary(page)).toHaveAttribute("data-matched", "1");

  // and with the last one gone nothing is explored and the summary is gone
  await rows(page).first().getByTestId("ride-delete").click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId("ridden-count")).toHaveText("0 edges");
  await expect.poll(() => riddenRendered(page)).toBe(0);
  await expect(summary(page)).toHaveCount(0);
});

test("a ride outside the region is marked, not an error", async ({ page }) => {
  await openMap(page, "layer=explored");
  await engineReady(page);
  await openPanel(page);
  await importFiles(page, [loop, faraway]);
  await expect(summary(page)).toHaveAttribute("data-matched", "2", { timeout: 20_000 });
  await expect(summary(page)).toHaveAttribute("data-outside", "1");
  await expect(page.getByTestId("rides-summary-rides")).toHaveText(
    "2 of 2 rides matched · 1 outside the region",
  );
  await expect(page.getByTestId("ride-outside")).toHaveCount(1);
  await expect(rows(page).filter({ hasText: "7 May 2026" }).getByTestId("ride-outside")).toBeVisible();
  await expect(page.getByTestId("rides-matching")).toHaveCount(0); // no "could not be matched"
  await expect(page.getByTestId("ridden-count")).toHaveText("8 edges");
});

test("a zip of GPX files imports in one step, and the picker offers zips and backups", async ({ page }) => {
  await openMap(page, "layer=explored");
  await engineReady(page);
  await openPanel(page);
  const accept = await page.getByTestId("rides-file-input").getAttribute("accept");
  for (const part of [".gpx", ".fit", ".zip", ".kompassrides", "application/zip"])
    expect(accept).toContain(part);

  const zip = toZip({
    "komoot/": new Uint8Array(0),
    "komoot/2026-05-02_1.gpx": track(gridLoop(0, 0), T0),
    "komoot/2026-05-03_2.gpx": track(gridLoop(2, 2, 3), T0 + DAY, 2),
    "komoot/2026-05-04_3.gpx": track([node(0, 3), node(2, 3), node(5, 3)], T0 + 2 * DAY, 3),
    "komoot/notes.txt": "not a ride",
    "__MACOSX/komoot/._2026-05-02_1.gpx": "junk",
  });
  await importFiles(page, [{ name: "komoot.zip", mimeType: "application/zip", buffer: Buffer.from(zip) }]);
  await expect(page.getByTestId("rides-report-text")).toHaveText("3 imported");
  await expect(rows(page)).toHaveCount(3);
  await expect(summary(page)).toHaveAttribute("data-matched", "3", { timeout: 20_000 });
  await expect.poll(() => riddenRendered(page)).toBeGreaterThan(20);

  // a zip that is not one is a failure with a reason, not a crash
  await importFiles(page, [
    {
      name: "broken.zip",
      mimeType: "application/zip",
      buffer: Buffer.from([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]),
    },
  ]);
  await expect(page.getByTestId("rides-report-text")).toHaveText("1 failed");
  await expect(page.getByTestId("rides-report-details")).toContainText("no GPX or FIT files in the zip");
  await expect(rows(page)).toHaveCount(3);
});

test("a backup picked in the same file picker is restored", async ({ page, browser }) => {
  await openMap(page);
  await openPanel(page);
  await importFiles(page, [loop, bigLoop]);
  const download = page.waitForEvent("download");
  await page.getByTestId("rides-export").click();
  const path = await (await download).path();

  const context = await browser.newContext(test.info().project.use);
  try {
    const other = await context.newPage();
    await openMap(other, "layer=explored");
    await engineReady(other);
    await openPanel(other);
    await other.getByTestId("rides-file-input").setInputFiles(path);
    await expect(other.getByTestId("rides-report-text")).toHaveText("Backup restored: 2 added");
    // the restored rides are matched like imported ones
    await expect(summary(other)).toHaveAttribute("data-matched", "2", { timeout: 20_000 });
  } finally {
    await context.close();
  }
});
