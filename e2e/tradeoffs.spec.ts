import { expect, type Page, test } from "@playwright/test";
import { LADDER } from "../web/test/synthetic";
import { engineReady, openMap, screenshot, waitIdle } from "./helpers";

// The hard limits as trade-offs (docs/planner.md, "Limits as trade-offs") on the fixture's ladder: a
// paved-only plan rides a 2 km loop round a 40 m gravel track; a marker on the route offers the track,
// its card says what it saves, and "Allow here" makes it an exception of the plan.

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 720;

type Snapshot = {
  main: { result: { summary: { distance_m: number } } | null };
  overrides: { kind: string; edges: number[]; limit?: string }[];
  tradeoffs: unknown[];
};
type Planner = { getSnapshot(): Snapshot; setBase(id: string): void };
const planner = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __kompass: { planner: Planner } }).__kompass.planner.getSnapshot();
    return {
      km: (s.main.result?.summary.distance_m ?? 0) / 1000,
      overrides: s.overrides.map((o) => `${o.kind}:${o.limit ?? ""}`),
      tradeoffs: s.tradeoffs.length,
    };
  });

async function tapAt(page: Page, at: readonly [number, number]) {
  const p = await page.evaluate((x) => window.__kompass.map.project(x), [at[0], at[1]] as [number, number]);
  const box = (await page.getByTestId("map").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(350);
}

test.describe.configure({ timeout: 60_000 });

test("a limit's trade-off: the marker, its card, allow here moves the route", async ({ page }, testInfo) => {
  await openMap(page);
  await page.evaluate(() => localStorage.removeItem("kompass.plan.v1"));
  await page.reload();
  await waitIdle(page);
  await engineReady(page);
  await page.evaluate(() =>
    (window as unknown as { __kompass: { planner: Planner } }).__kompass.planner.setBase("paved_quiet"),
  );
  const view = phone(page) ? { center: [0.0062, 0.015], zoom: 14 } : { center: [0.0062, 0.0184], zoom: 14.7 };
  await page.evaluate(
    (v) => (window.__kompass.map as unknown as { jumpTo(o: object): void }).jumpTo(v),
    view,
  );
  await waitIdle(page);
  await tapAt(page, LADDER.s);
  await tapAt(page, LADDER.t);
  await expect(page.getByTestId("stat-km").first()).toHaveText("3.0");

  // the marker on the route, once the route has stayed put a moment
  const marker = page.getByTestId("tradeoff-marker");
  await expect(marker).toHaveCount(1);
  await screenshot(page, testInfo, "tradeoff-marker");

  // its card in the inspector's place, the shortcut dashed on the map
  await marker.click();
  const card = page.getByTestId("tradeoff-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("tradeoff-sentence")).toHaveText("40 m unpaved here would save 2.1 km.");
  await expect(card).toContainText("Paved only");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = window.__kompass.map as unknown as {
          getSource(id: string): { serialize(): { data: { features: unknown[] } } };
        };
        return map.getSource("planner-tradeoff").serialize().data.features.length;
      }),
    )
    .toBe(1);
  await screenshot(page, testInfo, "tradeoff-card");

  // allowed: the route takes the track, the plan lists the exception, no marker is left
  await page.getByTestId("tradeoff-allow").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("stat-km").first()).toHaveText("0.9");
  await expect.poll(async () => (await planner(page)).overrides).toEqual(["allow:paved_only"]);
  await expect(page.getByTestId("undo-toast")).toContainText("Allowed: 40 m unpaved");
  await page.waitForTimeout(600);
  await expect(marker).toHaveCount(0);
  expect((await planner(page)).tradeoffs).toBe(0);
  await screenshot(page, testInfo, "tradeoff-allowed");
  if (phone(page)) await page.getByTestId("profile-chip").click();
  const list = page.getByTestId("plan-exceptions");
  await list.scrollIntoViewIfNeeded();
  await expect(list).toContainText("1 exception");
  await expect(list.getByTestId("plan-exception")).toHaveCount(1);
  await screenshot(page, testInfo, "tradeoff-exceptions");
});
