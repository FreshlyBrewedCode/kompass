import { expect, type Page, test } from "@playwright/test";
import { node } from "../web/test/synthetic";
import { edgePoint, engineReady, openMap, screenshot, waitIdle } from "./helpers";

// The cost debug view (docs/planner.md, "Cost") on the synthetic fixture region: the Cost layer, and a
// tap on it opening the segment inspector ("why not this" against a planned route). Both viewports.

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 720;

async function fresh(page: Page) {
  await openMap(page);
  await page.evaluate(() => localStorage.removeItem("kompass.plan.v1"));
  await page.reload();
  await waitIdle(page);
  await engineReady(page);
  const view = phone(page) ? { center: [0, -0.0091], zoom: 13.2 } : { center: [0, 0], zoom: 13.6 };
  await page.evaluate(
    (v) => (window.__kompass.map as unknown as { jumpTo(o: object): void }).jumpTo(v),
    view,
  );
  await waitIdle(page);
}

async function tapAt(page: Page, at: [number, number]) {
  const p = await page.evaluate((x) => window.__kompass.map.project(x), at);
  const box = (await page.getByTestId("map").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(350);
}

type Snapshot = { main: { result: { arcs: number[] } | null }; waypoints: unknown[] };
const planner = (page: Page) =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __kompass: { planner: { getSnapshot(): Snapshot } } }
    ).__kompass.planner.getSnapshot();
    return { arcs: s.main.result?.arcs ?? [], waypoints: s.waypoints.length };
  });

/** An edge off the planned route whose middle lies where no chrome covers the map. */
async function edgeOffRoute(page: Page) {
  const route = new Set((await planner(page)).arcs.map((a) => a >> 1));
  const { width, height } = page.viewportSize() as { width: number; height: number };
  const [x0, x1] = phone(page) ? [40, width - 40] : [460, width - 470];
  for (let id = 0; id < 60; id++) {
    if (route.has(id)) continue;
    const point = await edgePoint(page, id).catch(() => null);
    if (point && point.y > 210 && point.y < height * 0.45 && point.x > x0 && point.x < x1)
      return { id, point };
  }
  throw new Error("no fixture edge off the route in the clear part of the map");
}

/** Rendered edges the cost layer colours (feature state `ck` set). */
const coloured = (page: Page) =>
  page.evaluate(() => {
    const features = window.__kompass.map.queryRenderedFeatures({ layers: ["cost-line", "cost-closed"] });
    return new Set(features.filter((f) => Number(f.state?.ck ?? 0) > 0).map((f) => f.id)).size;
  });

const altKinds = (page: Page) =>
  page.evaluate(() => {
    const map = window.__kompass.map as unknown as {
      getSource(id: string): { serialize(): { data: { features: { properties: { kind: string } }[] } } };
    };
    return map
      .getSource("planner-alt")
      .serialize()
      .data.features.map((f) => f.properties.kind);
  });

test("the Cost layer: edges coloured by the profile, a tap explains one, why not through here", async ({
  page,
}, testInfo) => {
  await fresh(page);
  // a planned route first (taps add stops while no layer is on)
  await tapAt(page, node(1, 1));
  await tapAt(page, node(4, 4));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/^\d+\.\d$/);

  // switch on Cost: one more entry among the layers; taps now explain a way
  await page.getByTestId("map-rides").click();
  await page.getByTestId("mode-cost").click();
  await expect(page.getByTestId("map")).toHaveAttribute("data-layer", "cost");
  await expect(page.getByTestId("cost-legend")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("inspect-toggle")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("sheet-close").first().click();
  await expect(page.getByTestId("legend-pill")).toBeVisible();
  await waitIdle(page);
  await expect.poll(() => coloured(page)).toBeGreaterThan(20);
  await screenshot(page, testInfo, "cost-layer");

  // tap a way: the segment inspector (its "why not this" is e2e/inspector.spec.ts)
  const { point } = await edgeOffRoute(page);
  const before = (await planner(page)).arcs;
  await page.mouse.click(point.x, point.y);
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-mode", /^(whynot|closed)$/);
  await expect(page.getByTestId("inspector-headline")).toBeVisible();
  await expect(page.getByTestId("cost-arithmetic").first()).toBeAttached();
  // a tap explains, it does not add a stop
  expect((await planner(page)).waypoints).toBe(2);
  await screenshot(page, testInfo, "cost-tap");
  await page.getByTestId("inspector-close").click();
  await expect(inspector).toHaveCount(0);
  await expect.poll(() => altKinds(page)).toEqual([]);
  expect(await planner(page)).toEqual({ arcs: before, waypoints: 2 });
});
