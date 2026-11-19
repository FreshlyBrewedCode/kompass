import { expect, test } from "@playwright/test";
import { openMap, screenshot, waitIdle } from "./helpers";

test("the app loads from a sub-path, draws the region map and gets an answer from the wasm engine", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origins = new Set<string>();
  page.on("request", (request) => {
    if (!request.url().startsWith("data:") && !request.url().startsWith("blob:")) {
      origins.add(new URL(request.url()).origin);
    }
  });

  await page.goto("./");
  await expect(page).toHaveTitle("Kompass");

  // the engine: Rust → wasm → Web Worker → typed client → React (a small, unobtrusive pill)
  await expect(page.getByTestId("engine-status")).toHaveAttribute("data-status", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("engine-version")).toHaveText(/^\d+\.\d+\.\d+$/);
  // Zurich main station → Bern station as the crow flies
  const km = Number(await page.getByTestId("engine-distance").textContent());
  expect(km).toBeGreaterThan(94);
  expect(km).toBeLessThan(97);

  // the map: a full-screen canvas, its style (base map + overlay) loaded from the fixture region
  await waitIdle(page);
  const box = await page.locator(".maplibregl-canvas").boundingBox();
  const viewport = page.viewportSize() as { width: number; height: number };
  expect(box?.width).toBe(viewport.width);
  expect(box?.height).toBe(viewport.height);

  // installable later: the manifest resolves relative to the sub-path
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await page.request.get(new URL(manifestHref as string, page.url()).href)).json();
  expect(manifest).toMatchObject({ name: "Kompass", start_url: "./", display: "standalone" });

  // no horizontal scrolling on any viewport
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

  // everything came from this one origin: no third-party tiles, glyphs, sprites or styles at run time
  expect([...origins]).toEqual([new URL(page.url()).origin]);
  expect(errors).toEqual([]);
  await screenshot(page, testInfo, "app");
});

test("the region data is served with HTTP range support", async ({ page }) => {
  await page.goto("./");
  const url = new URL("data/overlay.pmtiles", page.url()).href;
  const part = await page.request.get(url, { headers: { range: "bytes=0-6" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toMatch(/^bytes 0-6\/\d+$/);
  expect((await part.body()).toString()).toBe("PMTiles"); // the PMTiles magic number
  expect(part.headers()["cache-control"]).toContain("max-age=31536000");
});

test.describe("in a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("the app and the base map follow it", async ({ page }, testInfo) => {
    await openMap(page, "mode=attribute");
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await page.evaluate(() => window.__kompass.map.getStyle().sprite)).toMatch(/sprites\/v4\/dark$/);
    await screenshot(page, testInfo, "app");
  });
});
