import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

// Screenshots land outside the repo; KOMPASS_E2E_SCREENSHOT_DIR moves them.
const SHOTS = process.env.KOMPASS_E2E_SCREENSHOT_DIR ?? "test-results/screenshots";

/** Opens the app on the fixture region (`?dev` exposes `window.__kompass`) and waits for the first paint. */
export async function openMap(page: Page, query = "") {
  await page.goto(`./?dev${query ? `&${query}` : ""}`);
  await waitIdle(page);
}

/** The map has loaded its style and finished fetching and painting tiles. */
export async function waitIdle(page: Page) {
  const map = page.getByTestId("map");
  await expect(map).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
  await expect(map).toHaveAttribute("data-idle", "true", { timeout: 20_000 });
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await waitIdle(page);
  await page.waitForTimeout(800); // a frame or two after idle, so labels and lines are painted
  const dark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-${dark ? "dark-" : ""}${testInfo.project.name}.png`) });
}

type Kompass = {
  store: { setRidden(ids: Iterable<number>): void };
  map: {
    getLayoutProperty(layer: string, property: string): unknown;
    getPaintProperty(layer: string, property: string): unknown;
    getSource(id: string): unknown;
    getStyle(): { sprite?: string };
    queryRenderedFeatures(options: { layers: string[] }): { id?: number; state?: Record<string, unknown> }[];
    querySourceFeatures(
      source: string,
      options?: { sourceLayer: string },
    ): {
      id?: number;
      geometry: { coordinates: [number, number][] };
    }[];
    project(lngLat: [number, number]): { x: number; y: number };
    getBounds(): { contains(lngLat: [number, number]): boolean };
    getZoom(): number;
  };
  /** the ride worker, called directly (dev hook) */
  ridesCall(method: string, params: unknown): Promise<unknown>;
};
declare global {
  interface Window {
    __kompass: Kompass;
  }
}

/** The screen position of the middle vertex of an edge (a point certainly on the line). */
export async function edgePoint(page: Page, id: number): Promise<{ x: number; y: number }> {
  return page.evaluate((edgeId) => {
    const { map } = window.__kompass;
    const feature = map.querySourceFeatures("overlay", { sourceLayer: "edges" }).find((f) => f.id === edgeId);
    if (!feature) throw new Error(`edge ${edgeId} is not loaded`);
    const coords = feature.geometry.coordinates;
    const middle = coords[Math.floor(coords.length / 2)] as [number, number];
    const point = map.project(middle);
    return { x: point.x, y: point.y };
  }, id);
}

/** How many rendered overlay edges carry `ridden` in their feature state. */
export async function riddenRendered(page: Page): Promise<number> {
  return page.evaluate(() => {
    const features = window.__kompass.map.queryRenderedFeatures({ layers: ["overlay-edges"] });
    return new Set(features.filter((f) => f.state?.ridden === true).map((f) => f.id)).size;
  });
}
