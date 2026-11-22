import { expect, type Page, test } from "@playwright/test";
import { node } from "../web/test/synthetic";
import { engineReady, openMap, screenshot, waitIdle } from "./helpers";

// The structured controls prototype (#66, docs/planner.md) on the synthetic fixture region: the switch
// in "Map & rides", a way moved to another tier by tap-and-pick (the route follows), a hills handle by
// its stepper, and back to the sliders as they were.

test.describe.configure({ timeout: 60_000 });

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 720;

type Snap = {
  controls: string;
  main: { result: { arcs: number[]; breakdown: { rows?: { key: string; length_m: number }[] } } | null };
  structured: { hills: { up: Record<string, number> } } | null;
  weights: Record<string, number>;
};
const snap = (page: Page) =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __kompass: { planner: { getSnapshot(): Snap } } }
    ).__kompass.planner.getSnapshot();
    return {
      controls: s.controls,
      arcs: JSON.stringify(s.main.result?.arcs ?? null),
      rows: s.main.result?.breakdown.rows ?? [],
      up10: s.structured?.hills.up["10"] ?? null,
      weights: s.weights,
    };
  });

async function tapAt(page: Page, at: [number, number]) {
  const p = await page.evaluate((x) => window.__kompass.map.project(x), at);
  const box = (await page.getByTestId("map").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(350);
}

async function openGroup(page: Page, group: string) {
  const head = page.getByTestId(`group-head-${group}`);
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
}

test("the structured controls: switch on, a tier by tap-and-pick, a hills handle, back to the sliders", async ({
  page,
}, testInfo) => {
  await openMap(page);
  await page.evaluate(() => {
    localStorage.removeItem("kompass.plan.v1");
    localStorage.removeItem("kompass.controls.v1");
  });
  await page.reload();
  await waitIdle(page);
  await engineReady(page);
  const view = phone(page) ? { center: [0, -0.0091], zoom: 13.2 } : { center: [0, 0], zoom: 13.6 };
  await page.evaluate(
    (v) => (window.__kompass.map as unknown as { jumpTo(o: object): void }).jumpTo(v),
    view,
  );
  await waitIdle(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(4, 3));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  const sliders = await snap(page);
  expect(sliders.controls).toBe("sliders");

  // the switch, next to Appearance
  await page.getByTestId("map-rides").click();
  await page.getByTestId("controls-switch").click();
  await expect.poll(async () => (await snap(page)).controls).toBe("structured");
  await expect(page.getByTestId("controls-switch")).toHaveAttribute("aria-checked", "true");
  if (await page.getByTestId("sheet-close").first().isVisible())
    await page.getByTestId("sheet-close").first().click();
  else await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("layers-panel")).toHaveCount(0);
  await expect.poll(async () => (await snap(page)).rows.length).toBeGreaterThan(0);

  // the profile: the boards and the curve collapsed to a line each
  if (phone(page)) await page.getByTestId("profile-chip").click();
  await expect(page.getByTestId("controls-note")).toBeVisible();
  await expect(page.getByTestId("group-head-ways").getByTestId("group-summary")).not.toBeEmpty();
  await expect(page.getByTestId("tier-glyph-way")).toBeVisible();
  await screenshot(page, testInfo, "structured-collapsed");

  // the way type the route rides most: tap its chip, pick Avoid, the route goes round it
  const ways = [
    "main",
    "country_road",
    "residential",
    "service",
    "track",
    "path",
    "cycle_path",
    "cycle_path_roadside",
  ];
  const before = await snap(page);
  const top = before.rows.filter((r) => ways.includes(r.key)).sort((a, b) => b.length_m - a.length_m)[0]
    ?.key as string;
  await openGroup(page, "ways");
  const chip = page.getByTestId(`tier-chip-${top}`);
  await chip.click();
  await expect(page.getByTestId("tier-picker")).toBeVisible();
  await page.getByTestId("tier-pick-avoid").click();
  await expect(chip).toHaveAttribute("data-tier", "avoid");
  await expect(page.getByTestId("tier-lane-avoid").getByTestId(`tier-chip-${top}`)).toBeVisible();
  await expect.poll(async () => (await snap(page)).arcs).not.toBe(before.arcs);
  await expect(page.getByTestId("change-count")).toHaveText("1 change");
  await page.getByTestId("tier-picker").scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, "structured-board");
  await page.getByTestId("tier-picker-close").click();
  await page.getByTestId("group-head-ways").click();

  // a hills handle by its stepper: +10 % one step dearer
  await openGroup(page, "terrain");
  await expect(page.getByTestId("hills-grade")).toHaveText("+10 %");
  const v0 = (await snap(page)).up10 as number;
  await page.getByTestId("hills-plus").click();
  await expect.poll(async () => (await snap(page)).up10).toBeGreaterThan(v0);
  await expect(page.getByTestId("hills-sentence")).toContainText("At 10 % uphill a metre counts as");
  await page.getByTestId("hills-prev").click();
  await expect(page.getByTestId("hills-grade")).toHaveText("+6 %");
  await expect(page.getByTestId("change-count")).toHaveText("2 changes");
  await page.getByTestId("hills-chart").scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, "structured-hills");

  // back to the sliders: the slider profile and its route as they were
  await page.getByTestId("controls-back").click();
  await expect.poll(async () => (await snap(page)).controls).toBe("sliders");
  await expect.poll(async () => (await snap(page)).arcs).toBe(sliders.arcs);
  expect((await snap(page)).weights).toEqual(sliders.weights);
  await expect(page.getByTestId("controls-note")).toHaveCount(0);
  await expect(page.getByTestId("tier-glyph-way")).toHaveCount(0);
  await openGroup(page, "surface");
  await expect(page.getByTestId("pref-unpaved")).toBeVisible();
  await expect(page.getByTestId("change-count")).toHaveText("· as it comes");
});
