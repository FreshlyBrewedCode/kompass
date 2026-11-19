import { expect, type Page, test } from "@playwright/test";
import { edgePoint, openMap, riddenRendered, screenshot, waitIdle } from "./helpers";

const layer = (page: Page, property: string) =>
  page.evaluate((p) => window.__kompass.map.getPaintProperty("overlay-edges", p), property);
const visibility = (page: Page) =>
  page.evaluate(() => window.__kompass.map.getLayoutProperty("overlay-edges", "visibility"));

test("the mode switch: plain hides the overlay, attribute and explored show it", async ({
  page,
}, testInfo) => {
  await openMap(page, "mode=plain");
  await expect(page.getByTestId("mode-plain")).toHaveAttribute("data-state", "on");
  expect(await visibility(page)).toBe("none");
  await expect(page.getByTestId("legend")).toHaveCount(0);
  await screenshot(page, testInfo, "mode-plain");

  await page.getByTestId("mode-attribute").click();
  await expect(page.getByTestId("map")).toHaveAttribute("data-mode", "attribute");
  expect(await visibility(page)).toBe("visible");
  await expect(page.getByTestId("legend")).toBeVisible();
  await expect(page.getByTestId("attribute-picker")).toBeVisible();

  await page.getByTestId("mode-explored").click();
  await expect(page.getByTestId("explored-legend")).toBeVisible();
  await expect(page.getByTestId("legend")).toHaveCount(0);
  await expect(page.getByTestId("attribute-picker")).toHaveCount(0);
  expect(JSON.stringify(await layer(page, "line-color"))).toContain("ridden");

  // pressing the active mode again keeps it
  await page.getByTestId("mode-explored").click();
  await expect(page.getByTestId("mode-explored")).toHaveAttribute("data-state", "on");
});

test("the attribute picker recolours the overlay and swaps the legend", async ({ page }, testInfo) => {
  await openMap(page, "mode=attribute");
  // an enum: categorical colours, a legend entry per value and a neutral Unknown
  expect(JSON.stringify(await layer(page, "line-color"))).toContain("surface_class");
  await expect(page.getByTestId("legend")).toContainText("Surface");
  await expect(page.getByTestId("legend-entry")).toHaveCount(7);
  await expect(page.getByTestId("legend-entry").last()).toHaveText("Unknown");
  await screenshot(page, testInfo, "attribute-surface");

  // a share: a sequential ramp with its ends, and a "no value" entry
  await page.getByTestId("attribute-picker").click();
  await page.getByTestId("attribute-forest").click();
  await expect(page.getByTestId("legend")).toContainText("In forest");
  await expect(page.getByTestId("legend-ramp")).toBeVisible();
  await expect(page.getByTestId("legend")).toContainText("100%");
  await expect(page.getByTestId("legend-entry")).toHaveText("No value");
  expect(JSON.stringify(await layer(page, "line-color"))).toContain('"forest"');
  expect(JSON.stringify(await layer(page, "line-color"))).not.toContain("surface_class");
  await screenshot(page, testInfo, "attribute-forest");

  // a number with a unit
  await page.getByTestId("attribute-picker").click();
  await page.getByTestId("attribute-grade_max").click();
  await expect(page.getByTestId("legend")).toContainText("25%");
});

test("tapping an edge lists all its attributes, labelled from the manifest", async ({ page }, testInfo) => {
  await openMap(page, "mode=attribute");
  await expect(page.getByTestId("inspect-panel")).toHaveCount(0);
  const point = await edgePoint(page, 1);
  await page.mouse.click(point.x, point.y);

  const panel = page.getByTestId("inspect-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-edge-id", "1");
  // edge 1 of the fixture: surface 3 = compacted, road class 1 = trunk, forest 0.7, grade 5%
  await expect(page.getByTestId("inspect-surface_class")).toContainText("Surface");
  await expect(page.getByTestId("inspect-surface_class")).toContainText("compacted");
  await expect(page.getByTestId("inspect-highway")).toContainText("trunk");
  await expect(page.getByTestId("inspect-forest")).toContainText("70%");
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

  // plain mode: no inspecting
  await page.getByTestId("mode-plain").click();
  const again = await edgePoint(page, 1);
  await page.mouse.click(again.x, again.y);
  await expect(panel).toHaveCount(0);
});

test("explored mode colours ridden edges by feature state; the store drives it", async ({
  page,
}, testInfo) => {
  await openMap(page, "mode=explored&fakeRidden=20");
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

test("a theme change keeps the explored state (feature state is re-applied on the new style)", async ({
  page,
}) => {
  await openMap(page, "mode=explored&fakeRidden=12");
  await expect.poll(() => riddenRendered(page)).toBe(12);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => window.__kompass.map.getStyle().sprite)).toMatch(/dark$/);
  await waitIdle(page);
  await expect.poll(() => riddenRendered(page)).toBe(12);
});

test.describe("a region without a base map", () => {
  test("falls back to a plain background", async ({ page }) => {
    await page.route("**/data/manifest.json", async (route) => {
      const manifest = await (await route.fetch()).json();
      await route.fulfill({ json: { ...manifest, basemap: null } });
    });
    await openMap(page, "mode=attribute");
    expect(await page.evaluate(() => window.__kompass.map.getSource("basemap") ?? null)).toBeNull();
    await expect(page.getByTestId("legend")).toBeVisible();
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

  test("attribute, inspect and explored read on the dark base map", async ({ page }, testInfo) => {
    await openMap(page, "mode=attribute");
    await screenshot(page, testInfo, "attribute-surface");
    const point = await edgePoint(page, 1);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId("inspect-panel")).toBeVisible();
    await screenshot(page, testInfo, "inspect");
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByTestId("mode-explored").click();
    await page.evaluate(() =>
      window.__kompass.store.setRidden(Array.from({ length: 30 }, (_, i) => i * 2 + 2)),
    );
    await expect.poll(() => riddenRendered(page)).toBe(30);
    await screenshot(page, testInfo, "explored");
  });
});
