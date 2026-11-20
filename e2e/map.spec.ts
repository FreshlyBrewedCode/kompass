import { expect, type Page, test } from "@playwright/test";
import { drawn, edgePoint, openMap, riddenRendered, screenshot, waitIdle } from "./helpers";

const visibility = (page: Page, layer: string) =>
  page.evaluate((id) => window.__kompass.map.getLayoutProperty(id, "visibility") ?? "visible", layer);
const filter = (page: Page, layer: string) =>
  page.evaluate((id) => JSON.stringify(window.__kompass.map.getFilter(id)), layer);
const pick = async (page: Page, name: string) => {
  await page.getByTestId("info-picker").click();
  await page.getByTestId(`info-${name}`).click();
  await expect(page.getByTestId("map")).toHaveAttribute("data-layer", name);
  // the select's dismiss layer blocks pointer events on the page until it has closed
  await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
};
const WAYS = ["way-road", "way-solid", "way-firm", "way-loose", "way-soft"];

test("the map opens as the readable map: the overlay draws roads, tracks and paths, nothing on top", async ({
  page,
}, testInfo) => {
  await openMap(page);
  await expect(page.getByTestId("map")).toHaveAttribute("data-layer", "none");
  await expect(page.getByTestId("info-picker")).toContainText("Map only");
  await expect(page.getByTestId("legend")).toHaveCount(0);
  expect(await visibility(page, "info-line")).toBe("none");
  expect(await visibility(page, "explored-line")).toBe("none");
  // every line style of the vocabulary has edges in the fixture, and each edge is drawn once
  for (const layer of WAYS) expect(await drawn(page, [layer])).toBeGreaterThan(0);
  const total = await drawn(page, WAYS);
  expect(total).toBeGreaterThan(50);
  expect(await drawn(page, ["way-casing", "way-halo"])).toBe(total);
  // the relief comes from the fixture's own DEM tiles
  expect(await visibility(page, "hillshade")).toBe("visible");
  expect(await drawn(page, ["contour-line"])).toBeGreaterThan(0);
  await screenshot(page, testInfo, "map");
});

test("the layers control: one information layer at a time, with its legend; the toggles", async ({
  page,
}, testInfo) => {
  await openMap(page);
  // an enum with defaults: the surface layer leaves smooth asphalt alone
  await pick(page, "surface_class");
  expect(await visibility(page, "info-line")).toBe("visible");
  expect(await filter(page, "info-line")).toContain("surface_class");
  const shown = await drawn(page, ["info-line"]);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(await drawn(page, ["way-casing", "way-halo"]));
  await expect(page.getByTestId("legend")).toContainText("Surface");
  await expect(page.getByTestId("legend-entry")).toHaveCount(6);
  await expect(page.getByTestId("legend-entry").last()).toHaveText("Unknown");
  await expect(page.getByTestId("legend-note")).toContainText("Not highlighted: paved smooth");
  await screenshot(page, testInfo, "layer-surface");

  // a share: only from its threshold on, as a ramp
  await pick(page, "forest_share");
  expect(await filter(page, "info-line")).toContain("forest_share");
  expect(await filter(page, "info-line")).not.toContain("surface_class");
  await expect(page.getByTestId("legend-ramp")).toBeVisible();
  await expect(page.getByTestId("legend")).toContainText("50%");
  await expect(page.getByTestId("legend-note")).toContainText("Only from 50% on");
  await screenshot(page, testInfo, "layer-forest");

  // a number with a unit
  await pick(page, "grade_max");
  await expect(page.getByTestId("legend")).toContainText("25%");

  // back to the map alone
  await pick(page, "none");
  await expect(page.getByTestId("legend")).toHaveCount(0);
  expect(await visibility(page, "info-line")).toBe("none");

  // the toggles switch parts of the map itself
  await page.getByTestId("toggle-terrain").click();
  expect(await visibility(page, "hillshade")).toBe("none");
  expect(await visibility(page, "contour-line")).toBe("none");
  await page.getByTestId("toggle-routes").click();
  expect(await visibility(page, "way-route")).toBe("none");
  await page.getByTestId("toggle-terrain").click();
  expect(await visibility(page, "hillshade")).toBe("visible");
});

test("tapping an edge lists all its attributes, labelled from the manifest", async ({ page }, testInfo) => {
  // no layer needed: the map's own ways are what is tapped
  await openMap(page);
  await expect(page.getByTestId("inspect-panel")).toHaveCount(0);
  const point = await edgePoint(page, 1);
  await page.mouse.click(point.x, point.y);

  const panel = page.getByTestId("inspect-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-edge-id", "1");
  // edge 1 of the fixture: a secondary road, compacted, 70% in forest, 5% steep
  await expect(page.getByTestId("inspect-surface_class")).toContainText("Surface");
  await expect(page.getByTestId("inspect-surface_class")).toContainText("compacted");
  await expect(page.getByTestId("inspect-highway")).toContainText("secondary");
  await expect(page.getByTestId("inspect-forest_share")).toContainText("70%");
  await expect(page.getByTestId("inspect-grade_max")).toContainText("5%");
  await screenshot(page, testInfo, "inspect");

  // a missing value is said so (edge 7 has no grade)
  await page.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  const seven = await edgePoint(page, 7);
  await page.mouse.click(seven.x, seven.y);
  await expect(panel).toHaveAttribute("data-edge-id", "7");
  await expect(page.getByTestId("inspect-grade_max")).toContainText("no value");

  // a tap away from every edge closes it
  await page.mouse.click(5, 5 + (page.viewportSize()?.height ?? 800) / 2);
  await expect(panel).toHaveCount(0);

  // with a layer on, the tap still works (edge 28 lies clear of the legend card)
  await pick(page, "surface_class");
  await waitIdle(page);
  const again = await edgePoint(page, 28);
  await page.mouse.click(again.x, again.y);
  await expect(panel).toHaveAttribute("data-edge-id", "28");
});

test("the explored layer highlights ridden edges by feature state; the store drives it", async ({
  page,
}, testInfo) => {
  await openMap(page, "layer=explored&fakeRidden=20");
  await expect(page.getByTestId("info-picker")).toContainText("Explored");
  expect(await visibility(page, "explored-line")).toBe("visible");
  await expect(page.getByTestId("ridden-count")).toHaveText("20 edges");
  // the map carries the store's state: rendered edges report `ridden` in their feature state
  await expect.poll(() => riddenRendered(page)).toBe(20);
  await screenshot(page, testInfo, "explored");

  // clearing the store clears the map
  await page.getByTestId("clear-ridden").click();
  await expect(page.getByTestId("ridden-count")).toHaveText("0 edges");
  await expect.poll(() => riddenRendered(page)).toBe(0);

  // the store API directly: plain ids, applied in chunks, replaced (not added) by the next call
  await page.evaluate(() => window.__kompass.store.setRidden([1, 2, 3]));
  await expect(page.getByTestId("ridden-count")).toHaveText("3 edges");
  await expect.poll(() => riddenRendered(page)).toBe(3);
  await page.getByTestId("fake-ridden").click();
  await expect.poll(() => riddenRendered(page)).toBeGreaterThan(3);
});

test("a theme change keeps the layer and the explored state (re-applied on the new style)", async ({
  page,
}) => {
  await openMap(page, "layer=explored&fakeRidden=12");
  await expect.poll(() => riddenRendered(page)).toBe(12);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => window.__kompass.map.getStyle().sprite)).toMatch(/dark$/);
  await waitIdle(page);
  expect(await visibility(page, "explored-line")).toBe("visible");
  await expect.poll(() => riddenRendered(page)).toBe(12);
});

test.describe("a region without a base map", () => {
  test("falls back to a plain background", async ({ page }) => {
    await page.route("**/data/manifest.json", async (route) => {
      const manifest = await (await route.fetch()).json();
      await route.fulfill({ json: { ...manifest, basemap: null } });
    });
    await openMap(page, "layer=surface_class");
    expect(await page.evaluate(() => window.__kompass.map.getSource("basemap") ?? null)).toBeNull();
    await expect(page.getByTestId("legend")).toBeVisible();
    expect(await drawn(page, WAYS)).toBeGreaterThan(50);
  });
});

test.describe("a region without terrain", () => {
  test("is drawn flat, and offers no relief toggle", async ({ page }) => {
    await page.route("**/data/manifest.json", async (route) => {
      const manifest = await (await route.fetch()).json();
      await route.fulfill({ json: { ...manifest, terrain: null } });
    });
    await openMap(page);
    expect(await page.evaluate(() => window.__kompass.map.getLayer("hillshade") ?? null)).toBeNull();
    await expect(page.getByTestId("toggle-terrain")).toHaveCount(0);
    await expect(page.getByTestId("toggle-routes")).toBeVisible();
  });
});

test.describe("without usable region data", () => {
  test("no data at the data URL: a clear empty state, no broken map", async ({ page }) => {
    await page.goto("./?data=./nothing-here/");
    await expect(page.getByTestId("region-empty")).toBeVisible();
    await expect(page.getByTestId("region-empty")).toContainText("No region data");
    await expect(page.getByTestId("map")).toHaveCount(0);
    // the engine status is independent of the region
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "ready", {
      timeout: 15_000,
    });
  });

  test("an invalid manifest: an error that says what is wrong", async ({ page }) => {
    await page.route("**/data/manifest.json", async (route) => {
      const manifest = await (await route.fetch()).json();
      await route.fulfill({ json: { ...manifest, bounds: [1, 2, 3] } });
    });
    await page.goto("./");
    await expect(page.getByTestId("region-error")).toBeVisible();
    await expect(page.getByTestId("region-error-message")).toContainText("bounds");
    await expect(page.getByTestId("map")).toHaveCount(0);
  });

  test("an unreadable manifest", async ({ page }) => {
    await page.route("**/data/manifest.json", (route) =>
      route.fulfill({ body: "{nope", contentType: "application/json" }),
    );
    await page.goto("./");
    await expect(page.getByTestId("region-error-message")).toContainText("not valid JSON");
  });
});

test.describe("in a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("the map, a layer, inspect and explored read on the dark style", async ({ page }, testInfo) => {
    await openMap(page);
    await screenshot(page, testInfo, "map");
    await pick(page, "surface_class");
    await screenshot(page, testInfo, "layer-surface");
    const point = await edgePoint(page, 1);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId("inspect-panel")).toBeVisible();
    await screenshot(page, testInfo, "inspect");
    await page.getByRole("button", { name: "Close" }).click();
    await pick(page, "explored");
    await page.evaluate(() =>
      window.__kompass.store.setRidden(Array.from({ length: 30 }, (_, i) => i * 2 + 2)),
    );
    await expect.poll(() => riddenRendered(page)).toBe(30);
    await screenshot(page, testInfo, "explored");
  });
});
