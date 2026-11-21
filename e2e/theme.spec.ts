import { expect, type Page, test } from "@playwright/test";
import { openMap, rawScreenshot, waitIdle } from "./helpers";

// The light / dark switch (docs/planner.md): system, light or dark, remembered on the device, driving
// the chrome and the map style together.

/** Whether the map's style is the dark one (polls: a style switch is in flight for a moment). */
const spriteDark = (page: Page) =>
  page.evaluate(() => /dark$/.test(window.__kompass.map.getStyle()?.sprite ?? "") || null);
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

async function pick(page: Page, value: "system" | "light" | "dark") {
  if (!(await page.getByTestId("appearance").isVisible())) await page.getByTestId("map-rides").click();
  await page.getByTestId(`theme-${value}`).click();
}

test.use({ colorScheme: "light" });

test("dark and light override the system setting, keep the map state and survive a reload", async ({
  page,
}, testInfo) => {
  await openMap(page, "layer=explored&fakeRidden=12");
  await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("theme-system")).toHaveAttribute("data-state", "on");
  await rawScreenshot(page, testInfo, "theme-light-control");
  await page.getByTestId("map-rides").click();
  await rawScreenshot(page, testInfo, "theme-light");
  const camera = await page.evaluate(() => {
    const m = window.__kompass.map as unknown as { jumpTo(o: object): void };
    m.jumpTo({ center: [0.004, -0.003], zoom: 13.1 });
    return { zoom: window.__kompass.map.getZoom() };
  });

  await pick(page, "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(() => spriteDark(page)).toBe(true);
  await waitIdle(page);
  expect(await page.evaluate(() => window.__kompass.map.getZoom())).toBeCloseTo(camera.zoom, 5);
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("data-state", "on");
  await rawScreenshot(page, testInfo, "theme-dark-control");
  await page.getByTestId("map-rides").click();
  await rawScreenshot(page, testInfo, "theme-dark");

  await page.reload();
  await waitIdle(page);
  expect(await isDark(page)).toBe(true);
  await expect.poll(() => spriteDark(page)).toBe(true);

  // dark system, light choice: the choice wins
  await page.emulateMedia({ colorScheme: "dark" });
  await pick(page, "light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect.poll(() => spriteDark(page)).toBe(null);
  await page.reload();
  await waitIdle(page);
  expect(await isDark(page)).toBe(false);
  await expect.poll(() => spriteDark(page)).toBe(null);

  // system again: follows the OS setting, live
  await pick(page, "system");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect.poll(() => spriteDark(page)).toBe(null);
});
