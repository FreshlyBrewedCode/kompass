import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Screenshots land outside the repo; KOMPASS_E2E_SCREENSHOT_DIR moves them.
const SHOTS = process.env.KOMPASS_E2E_SCREENSHOT_DIR ?? "test-results/screenshots";

test("the app loads from a sub-path, draws the map and gets an answer from the wasm engine", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("./");
  await expect(page).toHaveTitle("Kompass");

  // the engine: Rust → wasm → Web Worker → typed client → React
  const status = page.getByTestId("engine-status");
  await expect(status).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(page.getByTestId("engine-version")).toHaveText(/^\d+\.\d+\.\d+$/);
  // Zurich main station → Bern station as the crow flies
  const km = Number(await page.getByTestId("engine-distance").textContent());
  expect(km).toBeGreaterThan(94);
  expect(km).toBeLessThan(97);

  // the map: a full-screen canvas whose style has loaded
  const map = page.getByTestId("map");
  await expect(map).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box?.width).toBe(viewport.width);
  expect(box?.height).toBe(viewport.height);

  // installable later: the manifest resolves relative to the sub-path
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await page.request.get(new URL(manifestHref!, page.url()).href)).json();
  expect(manifest).toMatchObject({ name: "Kompass", start_url: "./", display: "standalone" });

  // no horizontal scrolling on any viewport
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);

  // give the tiles a moment to paint before the screenshot
  await page.waitForFunction(
    () => document.querySelector("[data-testid=map]")?.getAttribute("data-loaded") === "true",
  );
  await page.waitForTimeout(1500);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `hello-${testInfo.project.name}.png`) });
});

test.describe("in a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("the app and the map follow it", async ({ page }, testInfo) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("map")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
    await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "ready");
    await page.waitForTimeout(1500);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `hello-dark-${testInfo.project.name}.png`) });
  });
});
