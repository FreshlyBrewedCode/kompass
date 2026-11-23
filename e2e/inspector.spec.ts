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
  // the clipboard, stubbed: what the copy button writes is remembered for the test
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied?: string }).copied ?? null);

/** The context menu's coordinates row: `lat, lon` near the pressed point; the copy button writes it. */
async function expectCoords(page: Page, at: [number, number]) {
  const text = page.getByTestId("press-coords-text");
  await expect(text).toHaveText(/^-?\d+\.\d{5}, -?\d+\.\d{5}$/);
  const shown = (await text.textContent()) ?? "";
  const [lat, lon] = shown.split(", ").map(Number) as [number, number];
  // the pressed pixel, not the way: within a pixel or two of where the gesture went
  expect(Math.abs(lat - at[1])).toBeLessThan(2e-4);
  expect(Math.abs(lon - at[0])).toBeLessThan(2e-4);
  const copy = page.getByRole("button", { name: "Copy coordinates" });
  await copy.click();
  await expect.poll(() => copied(page)).toBe(shown);
  await expect(page.getByTestId("press-coords-status")).toHaveText("Copied");
}

/** A page point's `[lon, lat]` on the map. */
const lngLatAt = (page: Page, point: { x: number; y: number }) =>
  page.evaluate(
    ([x, y]) => {
      const box = document.querySelector('[data-testid="map"]')?.getBoundingClientRect();
      const map = window.__kompass.map as unknown as {
        unproject(p: [number, number]): { lng: number; lat: number };
      };
      const ll = map.unproject([x - (box?.left ?? 0), y - (box?.top ?? 0)]);
      return [ll.lng, ll.lat] as [number, number];
    },
    [point.x, point.y] as const,
  );

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
  overrides: { kind: string; edges: number[] }[];
  run: { edge: number; result: { edges: number[] } } | null;
};
const planner = (page: Page) =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __kompass: { planner: { getSnapshot(): Snapshot } } }
    ).__kompass.planner.getSnapshot();
    return {
      arcs: s.main.result?.arcs ?? [],
      waypoints: s.waypoints.length,
      weights: s.weights,
      overrides: s.overrides.map((o) => o.kind),
      run: s.run?.result.edges ?? [],
    };
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

const sourceKinds = (page: Page, source: string) =>
  page.evaluate((id) => {
    const map = window.__kompass.map as unknown as {
      getSource(id: string): { serialize(): { data: { features: { properties: { kind: string } }[] } } };
    };
    return map
      .getSource(id)
      .serialize()
      .data.features.map((f) => f.properties.kind);
  }, source);

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
  // the pressed point's coordinates, with a copy button
  await expectCoords(page, await lngLatAt(page, used.point));
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

test("avoid a segment of the route: the route moves, the plan lists it, undo", async ({ page }, testInfo) => {
  await planRoute(page);
  const inspector = page.getByTestId("inspector");
  const before = (await planner(page)).arcs;
  // a way of the route away from the stops (its run then has another way round on the fixture grid)
  const ends = new Set([before[0], before.at(-1)].map((a) => (a ?? 0) >> 1));
  const used = (await edgesWhere(page, true)).find((c) => !ends.has(c.id));
  if (!used) throw new Error("no fixture edge of the route away from its stops");
  await inspectAt(page, used.point);
  await expect(inspector).toHaveAttribute("data-mode", "used");
  const avoid = page.getByTestId("inspector-avoid");
  // enabled once the way's run between junctions is in (the ring then covers all of it)
  await expect(avoid).toBeEnabled();
  await expect(avoid).toContainText(/Avoid this segment · \d+ m/);
  expect((await planner(page)).run).toContain(used.id);
  await screenshot(page, testInfo, "exceptions-actions");

  // avoided: the route leaves the way, the inspector says why, the map marks it
  await avoid.click();
  await expect.poll(async () => (await planner(page)).overrides).toEqual(["avoid"]);
  await expect.poll(async () => (await planner(page)).arcs.some((a) => a >> 1 === used.id)).toBe(false);
  const moved = (await planner(page)).arcs;
  expect(moved).not.toEqual(before);
  await expect(page.getByTestId("inspector-exception")).toHaveAttribute("data-kind", "avoid");
  await expect(inspector).toHaveAttribute("data-mode", "avoided");
  await expect.poll(() => sourceKinds(page, "planner-overrides")).toEqual(["avoid"]);
  await expect(page.getByTestId("undo-toast")).toBeVisible();
  await screenshot(page, testInfo, "exceptions-avoided");

  // the plan's exceptions in the profile: removed there, the route is back; undo avoids it again
  await page.getByTestId("inspector-close").click();
  if (phone(page)) await page.getByTestId("profile-chip").click();
  const list = page.getByTestId("plan-exceptions");
  await list.scrollIntoViewIfNeeded();
  await expect(list.getByTestId("plan-exception")).toHaveCount(1);
  await expect(list).toContainText("1 exception");
  await screenshot(page, testInfo, "exceptions-list");
  await list.getByTestId("plan-exception-remove").click();
  await expect.poll(async () => (await planner(page)).arcs).toEqual(before);
  await expect(page.getByTestId("undo-toast")).toContainText("Removed");
  await page.getByTestId("undo-button").click();
  await expect.poll(async () => (await planner(page)).arcs).toEqual(moved);
  await expect(list.getByTestId("plan-exception")).toHaveCount(1);
});

test("the context menu where no way is near: the point's coordinates, copied", async ({ page }, testInfo) => {
  await fresh(page);
  const box = (await page.getByTestId("map").boundingBox()) as { x: number; y: number };
  const card = page.getByTestId("point-card");
  // the middle of a grid cell (30 px or more from its ways) in the clear part of the map; a way after
  // all (a diagonal): the next one
  const { width, height } = page.viewportSize() as { width: number; height: number };
  const [x0, x1] = phone(page) ? [40, width - 40] : [460, width - 470];
  let at: [number, number] | null = null;
  for (let i = 0; i < 5 && !at; i++)
    for (let j = 0; j < 5 && !at; j++) {
      const candidate = node(i + 0.5, j + 0.5);
      const p = await page.evaluate((x) => window.__kompass.map.project(x), candidate);
      if (p.y < 150 || p.y > height * 0.45 || p.x < x0 || p.x > x1) continue;
      await inspectAt(page, { x: box.x + p.x, y: box.y + p.y });
      await expect(card.or(page.getByTestId("inspector"))).toBeVisible();
      if (await card.isVisible()) at = candidate;
      else await page.getByTestId("inspector-close").click();
    }
  if (!at) throw new Error("no point without a way on the fixture");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  expect((await planner(page)).waypoints).toBe(0);
  await expectCoords(page, at);
  await screenshot(page, testInfo, "context-point");

  // no clipboard: the text is selected instead, and the rider is told
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }),
  );
  await page.getByRole("button", { name: "Copy coordinates" }).click();
  await expect(page.getByTestId("press-coords-status")).toHaveText("Copy failed: selected");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    await page.getByTestId("press-coords-text").textContent(),
  );
  await page.getByTestId("point-card-close").click();
  await expect(card).toHaveCount(0);
});
