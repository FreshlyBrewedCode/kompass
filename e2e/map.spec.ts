import { expect, type Page, test } from "@playwright/test";
import { drawn, edgePoint, openMap, riddenRendered, screenshot, waitIdle } from "./helpers";

const visibility = (page: Page, layer: string) =>
  page.evaluate((id) => window.__kompass.map.getLayoutProperty(id, "visibility") ?? "visible", layer);
const filter = (page: Page, layer: string) =>
  page.evaluate((id) => JSON.stringify(window.__kompass.map.getFilter(id)), layer);
/** Opens "Map & rides" (if closed) and switches the map to `name`: none, explored or an attribute key. */
const pick = async (page: Page, name: string) => {
  if (!(await page.getByTestId("layers-panel").isVisible())) await page.getByTestId("map-rides").click();
  if (name === "none" || name === "explored") await page.getByTestId(`mode-${name}`).click();
  else {
    await page.getByTestId("mode-attribute").click();
    if (!(await page.getByTestId(`info-${name}`).isVisible())) await page.getByTestId("info-more").click();
    await page.getByTestId(`info-${name}`).click();
  }
  await expect(page.getByTestId("map")).toHaveAttribute("data-layer", name);
};
const closeLayers = async (page: Page) => {
  await page.getByTestId("sheet-close").click();
  await expect(page.getByTestId("layers-panel")).toHaveCount(0);
};
const WAYS = ["way-band", "way-solid"];
const PICK = ["way-casing", "way-halo", "way-ferry"];

test("the map opens as the readable map: the overlay draws roads, tracks and paths, nothing on top", async ({
  page,
}, testInfo) => {
  await openMap(page);
  await expect(page.getByTestId("map")).toHaveAttribute("data-layer", "none");
  await expect(page.getByTestId("legend")).toHaveCount(0);
  expect(await visibility(page, "info-line")).toBe("none");
  expect(await visibility(page, "explored-line")).toBe("none");
  // every line style of the vocabulary has edges in the fixture, and each edge is drawn once
  for (const layer of WAYS) expect(await drawn(page, [layer])).toBeGreaterThan(0);
  const total = await drawn(page, WAYS);
  expect(total).toBeGreaterThan(50);
  expect(await drawn(page, PICK)).toBe(total);
  // the fixture's bridges get their rails
  expect(await drawn(page, ["way-bridge"])).toBeGreaterThan(0);
  // the relief comes from the fixture's own DEM tiles
  expect(await visibility(page, "hillshade")).toBe("visible");
  expect(await drawn(page, ["contour-line"])).toBeGreaterThan(0);
  await screenshot(page, testInfo, "map");
});

test("the key: the tracks as a small legend, every other line style a tap away", async ({
  page,
}, testInfo) => {
  await openMap(page);
  await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("mode-none")).toHaveAttribute("aria-pressed", "true");
  const tracks = page.getByTestId("map-key-tracks");
  await expect(tracks).toBeVisible();
  await expect(tracks.getByTestId("map-key-entry")).toHaveCount(5);
  await expect(tracks).toContainText("Compacted");
  await expect(page.getByTestId("map-key")).toHaveCount(0);
  await page.getByTestId("map-key-toggle").click();
  const key = page.getByTestId("map-key");
  await expect(key).toBeVisible();
  await expect(page.getByTestId("map-key-entry")).toHaveCount(19);
  await expect(key).toContainText("Unpaved road");
  // every sample is a drawn line, readable at the phone's width (nothing overflows the sheet)
  expect(await key.locator("svg path").count()).toBeGreaterThan(14);
  const box = (await key.boundingBox()) as { x: number; width: number };
  expect(box.x + box.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await tracks.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, "map-key");
  // another mode folds it away
  await page.getByTestId("mode-explored").click();
  await expect(key).toHaveCount(0);
  await expect(tracks).toHaveCount(0);
});

test("the map style options restyle the map in place and are remembered", async ({ page }, testInfo) => {
  await openMap(page);
  await page.getByTestId("map-rides").click();
  const options = page.getByTestId("map-style");
  await options.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("look-tracks-graded")).toHaveAttribute("data-state", "on");
  await expect(page.getByTestId("map-style-reset")).toHaveCount(0);
  await page.getByTestId("look-tracks-simple").click();
  await page.getByTestId("look-weight-bold").click();
  await page.getByTestId("look-ground-meadow").click();
  await page.getByTestId("look-contours").click();
  // a new style: poll until it is in (the layers are briefly missing while it loads)
  const shows = (layer: string) => () =>
    page.evaluate((id) => {
      const map = window.__kompass.map;
      return map.getLayer(id) ? (map.getLayoutProperty(id, "visibility") ?? "visible") : "loading";
    }, layer);
  await expect.poll(shows("contour-line")).toBe("none");
  await waitIdle(page);
  expect(await visibility(page, "hillshade")).toBe("visible");
  expect(await drawn(page, ["way-band"])).toBeGreaterThan(0);
  await screenshot(page, testInfo, "map-style-options");
  // remembered on the device: a reload keeps the choice
  await page.reload();
  await waitIdle(page);
  expect(await visibility(page, "contour-line")).toBe("none");
  await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("look-tracks-simple")).toHaveAttribute("data-state", "on");
  await page.getByTestId("map-style-reset").click();
  await expect(page.getByTestId("look-tracks-graded")).toHaveAttribute("data-state", "on");
  await expect.poll(shows("contour-line")).toBe("visible");
});

test("the layers control: one information layer at a time, with its legend; the toggles", async ({
  page,
}, testInfo) => {
  await openMap(page);
  // an enum with defaults: the surface layer leaves smooth asphalt alone
  await pick(page, "surface_class");
  expect(await visibility(page, "info-line")).toBe("visible");
  expect(await filter(page, "info-line")).toContain('"in",["get","surface_class"]');
  const shown = await drawn(page, ["info-line"]);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(await drawn(page, PICK));
  await expect(page.getByTestId("info-surface_class")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("legend-entry")).toHaveCount(6);
  await expect(page.getByTestId("legend-entry").last()).toHaveText("Unknown");
  await expect(page.getByTestId("legend-note")).toContainText("Not highlighted: paved smooth");
  await screenshot(page, testInfo, "layer-surface");

  // a share: only from its threshold on, as a ramp
  await pick(page, "forest_share");
  expect(await filter(page, "info-line")).toContain("forest_share");
  // the attribute's own clause is gone (the ways' zoom gates mention the surface too)
  expect(await filter(page, "info-line")).not.toContain('"in",["get","surface_class"]');
  await expect(page.getByTestId("legend-ramp")).toBeVisible();
  await expect(page.getByTestId("legend")).toContainText("50%");
  await expect(page.getByTestId("legend-note")).toContainText("Only from 50% on");
  await screenshot(page, testInfo, "layer-forest");

  // a number with a unit
  await pick(page, "grade_max");
  await expect(page.getByTestId("legend")).toContainText("25%");

  // the legend stays on the map while the panel is closed
  await closeLayers(page);
  await expect(page.getByTestId("legend-pill")).toContainText("Max grade");
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

test("inspecting a way lists all its attributes, labelled from the manifest", async ({ page }, testInfo) => {
  // inspecting is asked for (a tap otherwise adds a stop): an information layer, then "Inspect a way"
  await openMap(page);
  await pick(page, "surface_class");
  await page.getByTestId("inspect-toggle").click();
  await closeLayers(page);
  await waitIdle(page);
  await expect(page.getByTestId("inspect-panel")).toHaveCount(0);
  // tap a way where no chrome covers the map
  const { width, height } = page.viewportSize() as { width: number; height: number };
  const tapEdge = async (id: number) => {
    const at = await edgePoint(page, id);
    await page.evaluate(
      (by) =>
        (window.__kompass.map as unknown as { panBy(o: [number, number], a: object): void }).panBy(by, {
          animate: false,
        }),
      [at.x - (width < 720 ? width / 2 : 720), at.y - height * 0.3] as [number, number],
    );
    await waitIdle(page);
    const p = await edgePoint(page, id);
    await page.mouse.click(p.x, p.y);
  };
  // edge 1 of the fixture: a secondary road, compacted, 70% in forest, 5% steep
  await tapEdge(1);
  const panel = page.getByTestId("inspect-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-edge-id", "1");
  await expect(page.getByTestId("inspect-surface_class")).toContainText("Surface");
  await expect(page.getByTestId("inspect-surface_class")).toContainText("compacted");
  await expect(page.getByTestId("inspect-highway")).toContainText("secondary");
  await expect(page.getByTestId("inspect-forest_share")).toContainText("70%");
  await expect(page.getByTestId("inspect-grade_max")).toContainText("5%");
  await screenshot(page, testInfo, "inspect");

  // a missing value is said so (edge 7 has no grade)
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await tapEdge(7);
  await expect(panel).toHaveAttribute("data-edge-id", "7");
  await expect(page.getByTestId("inspect-grade_max")).toContainText("no value");
  // no stop was added by any of these taps
  await expect(page.getByTestId("waypoint-marker")).toHaveCount(0);
});

test("the explored layer highlights ridden edges by feature state; the store drives it", async ({
  page,
}, testInfo) => {
  await openMap(page, "layer=explored&fakeRidden=20");
  await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("mode-explored")).toHaveAttribute("aria-pressed", "true");
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
    await page.getByTestId("map-rides").click();
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
    // the engine starts without a region: idle, with its version
    await expect(page.getByTestId("engine-version")).toHaveText(/^\d+\.\d+\.\d+$/, { timeout: 15_000 });
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "idle");
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
    await pick(page, "explored");
    await page.evaluate(() =>
      window.__kompass.store.setRidden(Array.from({ length: 30 }, (_, i) => i * 2 + 1)),
    );
    await expect.poll(() => riddenRendered(page)).toBe(30);
    await screenshot(page, testInfo, "explored");
  });
});
