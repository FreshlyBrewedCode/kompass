import { expect, type Page, test } from "@playwright/test";
import { node } from "../web/test/synthetic";
import { edgePoint, engineReady, openMap, screenshot, waitIdle } from "./helpers";

// The segment inspector (docs/planner.md, "The segment inspector") on the synthetic fixture region:
// right-click at the desk, long press on the phone, on a way the route uses and on one it avoids, in
// normal planning (no layer switch); a line opens its slider in place and the explanation follows.

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
  // what the browser would do with a right-click: remembered for the test
  await page.evaluate(() => {
    window.addEventListener("contextmenu", (e) => {
      (window as unknown as { menuPrevented: boolean }).menuPrevented = e.defaultPrevented;
    });
  });
}

async function tapAt(page: Page, at: [number, number]) {
  const p = await page.evaluate((x) => window.__kompass.map.project(x), at);
  const box = (await page.getByTestId("map").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(350);
}

/** The inspector's gesture: a right-click at the desk, a long press (touch, held 700 ms) on the phone. */
async function inspectAt(page: Page, point: { x: number; y: number }) {
  if (!phone(page)) {
    await page.mouse.click(point.x, point.y, { button: "right" });
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y }],
  });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

type Snapshot = {
  main: { result: { arcs: number[] } | null };
  waypoints: unknown[];
  weights: Record<string, number>;
};
const planner = (page: Page) =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __kompass: { planner: { getSnapshot(): Snapshot } } }
    ).__kompass.planner.getSnapshot();
    return { arcs: s.main.result?.arcs ?? [], waypoints: s.waypoints.length, weights: s.weights };
  });

/** Edges on (or off) the planned route whose middle lies where no chrome covers the map. */
async function edgesWhere(page: Page, used: boolean) {
  const route = new Set((await planner(page)).arcs.map((a) => a >> 1));
  const { width, height } = page.viewportSize() as { width: number; height: number };
  const [x0, x1] = phone(page) ? [40, width - 40] : [460, width - 470];
  const found: { id: number; point: { x: number; y: number } }[] = [];
  for (let id = 0; id < 80; id++) {
    if (route.has(id) !== used) continue;
    const point = await edgePoint(page, id).catch(() => null);
    if (point && point.y > 150 && point.y < height * 0.45 && point.x > x0 && point.x < x1)
      found.push({ id, point });
  }
  if (found.length === 0)
    throw new Error(`no fixture edge ${used ? "on" : "off"} the route in the clear part of the map`);
  return found;
}

const ring = (page: Page) =>
  page.evaluate(() => {
    const map = window.__kompass.map as unknown as {
      getSource(id: string): { serialize(): { data: { features: { properties: { kind: string } }[] } } };
    };
    return map
      .getSource("planner-inspect")
      .serialize()
      .data.features.map((f) => f.properties.kind);
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

/** A planned route on the fixture: taps add stops. */
async function planRoute(page: Page) {
  await fresh(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(4, 4));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/^\d+\.\d$/);
  await waitIdle(page);
}

// each flow is long for a CPU-rendered map (CI runners): room beyond the default 30 s
test.describe.configure({ timeout: 60_000 });

test("the segment inspector on a used way: why it is used, a slider in place", async ({ page }, testInfo) => {
  await planRoute(page);

  // a way the route uses: why is this used, with no layer switched on
  const [used] = await edgesWhere(page, true);
  if (!used) throw new Error("unreachable");
  await inspectAt(page, used.point);
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-edge-id", String(used.id));
  await expect(inspector).toHaveAttribute("data-mode", "used");
  await expect(page.getByTestId("inspector-headline")).toHaveText(/^Counts as \d/);
  await expect(page.getByTestId("map")).not.toHaveAttribute("data-layer", "cost");
  // the gesture neither adds a stop nor opens the browser's menu; the way is ringed on the route
  expect((await planner(page)).waypoints).toBe(2);
  if (!phone(page))
    expect(await page.evaluate(() => (window as unknown as { menuPrevented: boolean }).menuPrevented)).toBe(
      true,
    );
  await expect.poll(() => ring(page)).toContain("route");
  await screenshot(page, testInfo, "inspector-used");

  // a line opens its slider in place; the explanation and the route follow
  const line = page.locator('[data-testid^="inspector-line-"] button:enabled').first();
  await expect(line).toBeVisible();
  const key = ((await line.locator("..").getAttribute("data-testid")) ?? "").replace("inspector-line-", "");
  await line.click();
  const slider = page.getByTestId(`inspector-slider-${key}`);
  await expect(slider).toBeVisible();
  const before = (await planner(page)).weights[key] ?? 0;
  const value = slider.getByTestId("inspector-slider-value");
  await slider.getByRole("slider").focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press(before >= 80 ? "ArrowLeft" : "ArrowRight");
  const after = before >= 80 ? before - 20 : before + 20;
  await expect.poll(async () => (await planner(page)).weights[key]).toBe(after);
  await expect(value).toHaveText(after > 0 ? `+${after}` : after < 0 ? `−${-after}` : "0");
  // the line stays where it was, open, while its value moves
  await expect(page.getByTestId(`inspector-line-${key}`)).toBeVisible();
  await expect(slider).toBeVisible();
  await screenshot(page, testInfo, "inspector-slider");
  await page.getByTestId("inspector-close").click();
  await expect(inspector).toHaveCount(0);
  await expect.poll(() => ring(page)).toEqual([]);
});

test("the segment inspector on an avoided way: why not, and use this way", async ({ page }, testInfo) => {
  await planRoute(page);
  const inspector = page.getByTestId("inspector");

  // a way the route avoids: why not this, against the route through it (a closed way says what closes
  // it instead: the next one then)
  let off: { id: number; point: { x: number; y: number } } | null = null;
  for (const candidate of await edgesWhere(page, false)) {
    await inspectAt(page, candidate.point);
    await expect(inspector).toHaveAttribute("data-edge-id", String(candidate.id));
    await expect(inspector).not.toHaveAttribute("data-tone", "");
    if ((await inspector.getAttribute("data-mode")) === "closed") {
      await expect(page.getByTestId("inspector-noslider")).toContainText("No slider");
      continue;
    }
    off = candidate;
    break;
  }
  if (!off) throw new Error("no open fixture edge off the route");
  await expect(inspector).toHaveAttribute("data-mode", "whynot");
  await expect(page.getByTestId("inspector-verdict")).toHaveText(
    /^(Not used: through here counts|Through here counts about the same|Through here is the planned|Through here counts .* less)/,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("whynot-via")).toBeVisible();
  await expect.poll(() => altKinds(page)).toEqual(["compare"]);
  await expect.poll(() => ring(page)).toContain("way");
  expect((await planner(page)).waypoints).toBe(2);
  await screenshot(page, testInfo, "inspector-avoided");

  // "use this way": the point becomes a stop, and the way is now on the route
  await page.getByTestId("inspector-use").click();
  await expect.poll(async () => (await planner(page)).waypoints).toBe(3);
  await expect(inspector).toHaveAttribute("data-mode", "used", { timeout: 10_000 });
  await expect.poll(() => altKinds(page)).not.toContain("compare");
  // Escape (desk) or the close button: back to the plan
  if (phone(page)) await page.getByTestId("inspector-close").click();
  else await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
});
