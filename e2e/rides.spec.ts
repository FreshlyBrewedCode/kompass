import { expect, type Page, test } from "@playwright/test";
import { gridLoop, node, syntheticTrack, toFit, toGpx } from "../web/test/synthetic";
import { openMap, screenshot, waitIdle } from "./helpers";

// Made-up rides on the fixture region's grid (an invented place around 0°N 0°E).
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 4, 2, 8, 0, 0);
const gpx = (name: string, path: [number, number][], start: number, interval = 5, seed = 1) => ({
  name,
  mimeType: "application/gpx+xml",
  buffer: Buffer.from(
    toGpx(syntheticTrack({ path, start, interval, noise: 2, seed, name: "Evening loop", sport: "mtb_easy" })),
  ),
});
const across = [node(0, 3), node(2, 3), node(5, 3)];

const komoot = {
  a: gpx("2026-05-02_1001.gpx", gridLoop(0, 0), T0),
  b: gpx("2026-05-03_1002.gpx", gridLoop(2, 2, 3), T0 + DAY, 5, 2),
  c: gpx("2026-05-04_1003.gpx", across, T0 + 2 * DAY, 5, 3),
};
/** the same ride as `a`, recorded by a bike computer at 1 Hz and starting 20 s later */
const garmin = {
  name: "activity_9001.fit",
  mimeType: "application/octet-stream",
  buffer: Buffer.from(
    toFit(syntheticTrack({ path: gridLoop(0, 0), start: T0 + 20_000, interval: 1, noise: 2, seed: 9 }), {
      sport: 2,
    }),
  ),
};

const rows = (page: Page) => page.getByTestId("ride-row");

async function openPanel(page: Page) {
  // the ride library lives in the planner's "Map & rides"
  await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("rides-panel")).toBeVisible();
}

async function importFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId("rides-file-input").setInputFiles(files);
  await expect(page.getByTestId("rides-report")).toBeVisible({ timeout: 15_000 });
}

/** the ride ids the "My rides" source currently holds */
const mapRideIds = (page: Page) =>
  page.evaluate(() => {
    const features = window.__kompass.map.querySourceFeatures("rides") as unknown as {
      properties: { id: string };
    }[];
    return [...new Set(features.map((f) => f.properties.id))];
  });

test("import GPX and FIT files: the list, the lines on the map, and a tap fits the map to a ride", async ({
  page,
}, testInfo) => {
  await openMap(page);
  await expect(page.getByTestId("rides-count")).toHaveText("0");
  await openPanel(page);
  await expect(page.getByTestId("rides-empty")).toBeVisible();
  await expect(page.getByTestId("rides-file-input")).toHaveAttribute("accept", /\.gpx,\.fit/);
  await expect(page.getByTestId("rides-file-input")).toHaveAttribute("multiple", "");

  await importFiles(page, [komoot.a, komoot.b, komoot.c, garmin]);
  // a and the FIT are the same ride: the denser copy (the FIT) replaces the sparser one
  await expect(page.getByTestId("rides-report-text")).toHaveText("4 imported");
  await expect(page.getByTestId("rides-count")).toHaveText("3");
  await expect(rows(page)).toHaveCount(3);
  const first = rows(page)
    .filter({ hasText: "activity_9001.fit" })
    .or(rows(page).filter({ hasText: "2 May 2026" }));
  await expect(first.first()).toContainText("+1 copy");
  // newest first: 4 May (a crossing), 3 May, 2 May
  await expect(rows(page).nth(0)).toContainText("4 May 2026");
  await expect(rows(page).nth(2)).toContainText("2 May 2026");

  // the lines are on the map: one GeoJSON source, one feature per ride
  await expect.poll(() => mapRideIds(page).then((ids) => ids.length)).toBe(3);
  await waitIdle(page);
  await screenshot(page, testInfo, "rides-imported");

  // tapping a ride zooms to it: its bounds are in view, and its line is highlighted
  const row = rows(page).nth(1); // 3 May: the 3 × 3 loop
  await row.getByRole("button").first().click();
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(
        (corners) => corners.every((c) => window.__kompass.map.getBounds().contains(c)),
        [node(2, 2), node(5, 5)],
      ),
    )
    .toBe(true);
  await expect.poll(() => page.evaluate(() => window.__kompass.map.getZoom())).toBeGreaterThan(13);
  await waitIdle(page);
  await screenshot(page, testInfo, "rides-focused");

  // the toggle hides and shows the layer
  const visibility = () =>
    page.evaluate(() => window.__kompass.map.getLayoutProperty("rides-line", "visibility"));
  expect(await visibility()).toBe("visible");
  await page.getByTestId("rides-toggle").click();
  expect(await visibility()).toBe("none");
  await page.getByTestId("rides-toggle").click();
  expect(await visibility()).toBe("visible");
});

test("duplicates: re-importing is a no-op, a sparser copy of a stored ride is skipped and remembered", async ({
  page,
}) => {
  await openMap(page);
  await openPanel(page);
  await importFiles(page, [garmin, komoot.b]);
  await expect(rows(page)).toHaveCount(2);

  // the very same files again (and under another name): known by content
  await importFiles(page, [garmin, { ...komoot.b, name: "copy-of-b.gpx" }]);
  await expect(page.getByTestId("rides-report-text")).toHaveText("2 already imported");
  await expect(rows(page)).toHaveCount(2);

  // the Komoot recording of the Garmin ride: same time span, fewer points
  await importFiles(page, [komoot.a]);
  await expect(page.getByTestId("rides-report-text")).toHaveText("1 duplicate skipped");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId("ride-also")).toHaveCount(1);
  await expect(page.getByTestId("ride-also")).toHaveAttribute("title", "2026-05-02_1001.gpx");
});

test("files that are not rides fail with a reason; tracks without timestamps are flagged", async ({
  page,
}) => {
  await openMap(page);
  await openPanel(page);
  const untimed = {
    name: "no-times.gpx",
    mimeType: "",
    buffer: Buffer.from(toGpx(syntheticTrack({ path: gridLoop(1, 0), start: null }))),
  };
  const junk = { name: "index.json", mimeType: "application/json", buffer: Buffer.from('{"tours": []}') };
  await importFiles(page, [untimed, junk, komoot.a]);
  await expect(page.getByTestId("rides-report-text")).toHaveText("2 imported, 1 failed");
  await expect(page.getByTestId("rides-report-details")).toContainText("index.json");
  await expect(page.getByTestId("rides-report-details")).toContainText("not a GPX or FIT file");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId("ride-no-time")).toHaveCount(1);
  await expect(rows(page).last()).toContainText("No date");
});

test("delete one ride, then delete all after a confirmation", async ({ page }) => {
  await openMap(page);
  await openPanel(page);
  await importFiles(page, [komoot.a, komoot.b, komoot.c]);
  await expect(rows(page)).toHaveCount(3);
  await rows(page).nth(1).getByTestId("ride-delete").click();
  await expect(rows(page)).toHaveCount(2);
  await expect.poll(() => mapRideIds(page).then((ids) => ids.length)).toBe(2);

  await page.getByTestId("rides-delete-all").click();
  await expect(page.getByTestId("rides-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  // wait for the close animation to end: reopening the dialog while it still runs can leave the
  // overlay on top of the content (a Radix layer race), and the next click then waits until the
  // test timeout. A person cannot click that fast; the test can, and a loaded machine makes it likely.
  await expect(page.getByTestId("rides-confirm")).toBeHidden();
  await expect(rows(page)).toHaveCount(2);
  await page.getByTestId("rides-delete-all").click();
  await page.getByTestId("rides-confirm-delete").click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId("rides-count")).toHaveText("0");
  await expect.poll(() => mapRideIds(page).then((ids) => ids.length)).toBe(0);
  // a deleted ride's file can be imported again
  await importFiles(page, [komoot.a]);
  await expect(page.getByTestId("rides-report-text")).toHaveText("1 imported");
});

test("the library persists across a reload, and says how it is stored", async ({ page }, testInfo) => {
  await openMap(page);
  await openPanel(page);
  await importFiles(page, [komoot.a, komoot.b]);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId("rides-storage")).toContainText(/kB|MB/);
  // persistent or not is the browser's call: the panel says which
  await expect(page.getByTestId("rides-persistence")).toHaveAttribute("data-persisted", /true|false/);

  await page.reload();
  await waitIdle(page);
  await expect(page.getByTestId("rides-count")).toHaveText("2");
  await expect.poll(() => mapRideIds(page).then((ids) => ids.length)).toBe(2);
  await openPanel(page);
  await expect(rows(page)).toHaveCount(2);
  await screenshot(page, testInfo, "rides-panel");
});

test("export a backup, restore it into a fresh profile, and re-restoring changes nothing", async ({
  page,
  browser,
}) => {
  await openMap(page);
  await openPanel(page);
  await importFiles(page, [komoot.a, komoot.b, komoot.c, garmin]);
  await expect(rows(page)).toHaveCount(3);

  const download = page.waitForEvent("download");
  await page.getByTestId("rides-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^kompass-rides-\d{4}-\d{2}-\d{2}\.kompassrides$/);
  const path = await file.path();

  // another device = another browser profile (a new context has its own IndexedDB)
  const context = await browser.newContext(test.info().project.use);
  try {
    const other = await context.newPage();
    await openMap(other);
    await expect(other.getByTestId("rides-count")).toHaveText("0");
    await openPanel(other);
    await other.getByTestId("rides-restore-input").setInputFiles(path);
    await expect(other.getByTestId("rides-report-text")).toHaveText("Backup restored: 3 added");
    await expect(rows(other)).toHaveCount(3);
    await expect(other.getByTestId("ride-also")).toHaveCount(1);
    await expect.poll(() => mapRideIds(other).then((ids) => ids.length)).toBe(3);

    await other.getByTestId("rides-restore-input").setInputFiles(path);
    await expect(other.getByTestId("rides-report-text")).toHaveText(
      "Backup restored: 0 added, 3 already here",
    );
    await expect(rows(other)).toHaveCount(3);

    // a file that is not a backup is refused and changes nothing
    await other.getByTestId("rides-restore-input").setInputFiles({
      name: "x.kompassrides",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("not a backup file"),
    });
    await expect(other.getByTestId("rides-report")).toHaveAttribute("data-kind", "error");
    await expect(other.getByTestId("rides-report-text")).toContainText("not a Kompass ride backup");
    await expect(rows(other)).toHaveCount(3);
  } finally {
    await context.close();
  }
});

test("privacy: during import, export and restore every request goes to the app's own origin and none has a body", async ({
  page,
}) => {
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on("request", (request) => {
    requests.push({ url: request.url(), method: request.method(), body: request.postData() });
  });
  await openMap(page);
  await openPanel(page);
  await importFiles(page, [komoot.a, komoot.b, komoot.c, garmin]);
  const download = page.waitForEvent("download");
  await page.getByTestId("rides-export").click();
  const path = await (await download).path();
  await page.getByTestId("rides-delete-all").click();
  await page.getByTestId("rides-confirm-delete").click();
  await expect(rows(page)).toHaveCount(0);
  await page.getByTestId("rides-restore-input").setInputFiles(path);
  await expect(page.getByTestId("rides-report-text")).toContainText("Backup restored");
  await expect(rows(page)).toHaveCount(3);

  const origin = new URL(page.url()).origin;
  expect(requests.length).toBeGreaterThan(5);
  for (const request of requests) {
    if (/^(data|blob):/.test(request.url)) continue; // local, never leaves the browser
    expect(new URL(request.url).origin, request.url).toBe(origin);
    expect(["GET", "HEAD"], request.url).toContain(request.method);
    expect(request.body, request.url).toBeNull();
  }
});

test.describe("in a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("the panel and the lines read on the dark base map", async ({ page }, testInfo) => {
    await openMap(page);
    await openPanel(page);
    await importFiles(page, [komoot.a, komoot.b, komoot.c]);
    await expect(rows(page)).toHaveCount(3);
    await expect.poll(() => mapRideIds(page).then((ids) => ids.length)).toBe(3);
    await rows(page).nth(1).getByRole("button").first().click();
    await waitIdle(page);
    await screenshot(page, testInfo, "rides-panel");
  });
});
