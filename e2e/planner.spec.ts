import { expect, type Page, test } from "@playwright/test";
import { node } from "../web/test/synthetic";
import { edgePoint, engineReady, openMap, rawScreenshot, screenshot, waitIdle } from "./helpers";

// The planner shell (docs/planner.md) on the synthetic fixture region: a 6 × 6 street grid around
// 0°N 0°E (e2e/fixtures/build-region.ts). Every main flow at both viewports.

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 720;

/** Puts the grid where the chrome leaves the map free: the upper part on a phone, the middle on desktop. */
async function frame(page: Page) {
  // the grid is 0.0225° wide: ~300 px at z13.2 (phone), ~400 px at z13.6 (desktop)
  const view = phone(page) ? { center: [0, -0.0091], zoom: 13.2 } : { center: [0, 0], zoom: 13.6 };
  await page.evaluate((v) => {
    const map = window.__kompass.map as unknown as { jumpTo(o: object): void };
    map.jumpTo(v);
  }, view);
  await waitIdle(page);
}

async function tapAt(page: Page, [lon, lat]: [number, number]) {
  const p = await page.evaluate((at) => window.__kompass.map.project(at), [lon, lat] as [number, number]);
  const box = (await page.getByTestId("map").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + p.x, box.y + p.y);
  // two taps closer together than this are the map's double tap (zoom)
  await page.waitForTimeout(350);
}

/** An edge whose middle lies in the part of the map no chrome covers. */
async function clearEdge(page: Page) {
  const { width, height } = page.viewportSize() as { width: number; height: number };
  const [x0, x1] = phone(page) ? [40, width - 40] : [460, width - 470];
  for (let id = 0; id < 60; id++) {
    const point = await edgePoint(page, id).catch(() => null);
    if (point && point.y > 200 && point.y < height * 0.45 && point.x > x0 && point.x < x1)
      return { id, point };
  }
  throw new Error("no fixture edge in the clear part of the map");
}

/** A fresh planner with nothing saved. */
async function fresh(page: Page, query = "") {
  await openMap(page, query);
  await page.evaluate(() => localStorage.removeItem("kompass.plan.v1"));
  await page.reload();
  await waitIdle(page);
  await engineReady(page);
  await frame(page);
}

const km = async (page: Page) => Number(await page.getByTestId("stat-km").first().textContent());
const plan = (page: Page) =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __kompass: { planner: { getSnapshot(): Record<string, unknown> } } }
    ).__kompass.planner.getSnapshot();
    const main = s.main as { result: { arcs: number[] } | null };
    const compare = s.compare as { result: { arcs: number[] } | null };
    return {
      main: main.result?.arcs ?? null,
      compare: compare.result?.arcs ?? null,
      waypoints: (s.waypoints as unknown[]).length,
    };
  });
/** The lines drawn by the planner's sources: main (the plan) and alt (ghost or compared). */
const drawnLines = (page: Page) =>
  page.evaluate(() => {
    const map = window.__kompass.map as unknown as {
      getSource(
        id: string,
      ): { serialize(): { data: { features: { properties: { kind: string } }[] } } } | undefined;
    };
    const kinds = (id: string) =>
      (map.getSource(id)?.serialize().data.features ?? []).map((f) => f.properties.kind);
    return { main: kinds("planner-main"), alt: kinds("planner-alt") };
  });

/** Opens the whole profile (a sheet on the phone; always on screen on desktop). */
async function openProfile(page: Page) {
  if (phone(page)) await page.getByTestId("profile-chip").click();
  await expect(page.getByTestId("profile")).toBeVisible();
}
/** Opens a group of the profile's preferences (they start collapsed). */
async function openGroup(page: Page, group: string) {
  const head = page.getByTestId(`group-head-${group}`);
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
}
async function closeSheet(page: Page) {
  if (await page.getByTestId("sheet").isVisible()) await page.getByTestId("sheet-close").first().click();
  await expect(page.getByTestId("sheet")).toHaveCount(0);
}
async function addFromPicker(page: Page, id: string, search: string) {
  if (phone(page)) await page.getByTestId("strip-add").click();
  else await page.getByTestId("add-preference").click();
  await page.getByTestId("picker-search").fill(search);
  await page.getByTestId(`pick-${id}`).click();
  await expect(page.getByTestId("picker")).toHaveCount(0);
}

test("plan by tapping: start, destination, a stop; the route, its totals and the list", async ({
  page,
}, testInfo) => {
  await fresh(page);
  await expect(page.getByTestId("status-empty").first()).toContainText("Tap the map to set a start");
  await tapAt(page, node(1, 1));
  await expect(page.getByTestId("status-empty").first()).toContainText("Tap the map for where to go");
  await tapAt(page, node(3, 0));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/^\d+\.\d$/);
  const direct = await km(page);
  expect(direct).toBeGreaterThanOrEqual(1.4);
  expect((await drawnLines(page)).main).toEqual(["main"]);

  // a stop beside the leg joins it: a longer route through it
  await tapAt(page, node(3, 2));
  await expect(page.getByTestId("waypoint-marker")).toHaveCount(3);
  await expect.poll(() => km(page)).toBeGreaterThan(direct);
  // the list (the route sheet on the phone, the route card on desktop): remove the stop again
  if (phone(page)) await page.getByTestId("open-route").click();
  await expect(page.getByTestId("waypoint-row")).toHaveCount(3);
  await expect(page.getByTestId("lanes")).toBeVisible();
  await screenshot(page, testInfo, "planner-route");
  await page.getByTestId("waypoint-remove").nth(1).click();
  await expect(page.getByTestId("waypoint-row")).toHaveCount(2);
  await expect.poll(() => km(page)).toBe(direct);
  // reverse keeps the stops, clear drops them
  await page.getByTestId("reverse").click();
  await expect.poll(() => km(page)).toBeGreaterThan(0);
  await page.getByTestId("clear").click();
  await closeSheet(page);
  await expect(page.getByTestId("waypoint-marker")).toHaveCount(0);
  await expect(page.getByTestId("status-empty").first()).toBeVisible();
});

test("two profiles, two routes: compare, the trade-off, ride it this way", async ({ page }, testInfo) => {
  await fresh(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(3, 0));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  await openProfile(page);
  await page.getByTestId("compare-paved_quiet").click();
  await expect(page.getByTestId("compare-result")).toBeVisible();
  await expect(page.getByTestId("tradeoff")).toContainText(/^Paved & quiet is /);
  // both lines on the map, and they differ
  await expect.poll(async () => (await drawnLines(page)).alt).toEqual(["compare"]);
  const both = await plan(page);
  expect(both.main).not.toBeNull();
  expect(JSON.stringify(both.main)).not.toBe(JSON.stringify(both.compare));
  await screenshot(page, testInfo, "planner-compare");
  // ride it this way: the compared preset becomes the base
  await page.getByTestId("ride-compare").click();
  await expect(page.getByTestId("compare-result")).toHaveCount(0);
  if (phone(page)) await expect(page.getByTestId("profile-chip")).toContainText("Paved & quiet");
  else await expect(page.getByTestId("base-name")).toContainText("Paved & quiet");
  await expect.poll(async () => JSON.stringify((await plan(page)).main)).toBe(JSON.stringify(both.compare));
});

test("the detours slider sets min_factor, shows what it means and reroutes", async ({ page }, testInfo) => {
  await fresh(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(4, 3));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  await openProfile(page);
  const slider = page.getByTestId("detours-slider");
  await slider.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("detours-word")).toHaveText("Detours for good ways");
  await expect(page.getByTestId("detours-hint")).toHaveText("Up to 2× longer for a way you like.");
  const state = () =>
    page.evaluate(() => {
      const s = (
        window as unknown as { __kompass: { planner: { getSnapshot(): Record<string, unknown> } } }
      ).__kompass.planner.getSnapshot();
      const main = s.main as { result: { summary: { cost: number } } | null };
      return { minFactor: s.minFactor as number, cost: main.result?.summary.cost ?? null };
    });
  const before = await state();
  expect(before.minFactor).toBe(0.5);
  await slider.focus();
  await slider.press("End"); // all the way to "go far for good ways"
  await expect(page.getByTestId("detours-word")).toHaveText("Go far for good ways");
  await expect(page.getByTestId("detours-hint")).toHaveText("Up to 3.3× longer for a way you like.");
  await expect.poll(async () => (await state()).minFactor).toBe(0.3);
  await expect(page.getByTestId("change-dot").first()).toBeVisible();
  await screenshot(page, testInfo, "planner-detours");
  // the profile sent to the engine carries bounds.min_factor: the route's cost is computed with it
  // ("Direct" clamps every way the preset likes at 1; the far end changes only ways below 0.5)
  await slider.press("Home");
  await expect(page.getByTestId("detours-word")).toHaveText("Direct");
  await expect.poll(async () => (await state()).minFactor).toBe(1);
  await expect.poll(async () => (await state()).cost).not.toBe(before.cost);
  // back to the preset's value
  await page.getByTestId("detours").getByTestId("change-dot").click();
  await expect(page.getByTestId("detours-word")).toHaveText("Detours for good ways");
  await expect.poll(async () => (await state()).cost).toBe(before.cost);
});

test("a slider reroutes live with the base as a ghost; a preference from the picker; reset", async ({
  page,
}, testInfo) => {
  await fresh(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(3, 0));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  const before = JSON.stringify((await plan(page)).main);
  // one preference's slider: the chip on the phone, the profile card on desktop (its group opened)
  if (phone(page)) await page.getByTestId("chip-unpaved").click();
  else await openGroup(page, "surface");
  const dial = page.getByRole("slider", { name: "Gravel & unpaved" });
  await dial.focus();
  await dial.press("Home"); // all the way to "avoid"
  await expect(page.getByTestId("pref-unpaved").getByTestId("pref-value")).toHaveText("−100");
  await expect.poll(async () => JSON.stringify((await plan(page)).main)).not.toBe(before);
  // the base profile's route stays as the dashed ghost, and the numbers say what moved
  await expect.poll(async () => (await drawnLines(page)).alt).toEqual(["ghost"]);
  await expect(page.getByTestId("delta-line").first()).toContainText("vs base");
  await screenshot(page, testInfo, "planner-slider");

  // a preference from the searchable picker
  if (phone(page)) await page.getByTestId("strip-add").click();
  else await page.getByTestId("add-preference").click();
  await page.getByTestId("picker-search").fill("river");
  await expect(page.getByTestId("pick-water")).toBeVisible();
  await expect(page.getByTestId("pick-unpaved")).toHaveCount(0);
  await page.getByTestId("pick-water").click();
  await expect(page.getByTestId("pref-water")).toBeVisible();
  await openProfile(page);
  await expect(page.getByTestId("change-count")).toHaveText("2 changes");
  await expect(page.getByTestId("change-sentence")).toHaveText(
    "Gravel explorer, but less gravel and more water.",
  );
  await page.getByTestId("reset-profile").click();
  await expect(page.getByTestId("change-count")).toHaveText("· as it comes");
  await expect(page.getByTestId("pref-water")).toHaveCount(0);
});

test("the profile by groups: collapsed with a summary, what each slider touches, dimmed at nothing", async ({
  page,
}, testInfo) => {
  await fresh(page);
  await openProfile(page);
  // collapsed by default, each group with a line of what is set in it; no figures before a route
  const surface = page.getByTestId("group-head-surface");
  await expect(surface).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("group-surface").getByTestId("group-summary")).toHaveText(
    /likes gravel|loves gravel/,
  );
  await expect(page.getByTestId("pref-unpaved")).toHaveCount(0);
  await openGroup(page, "surface");
  await expect(page.getByTestId("pref-unpaved")).toBeVisible();
  await expect(page.getByTestId("pref-touches")).toHaveCount(0);
  await closeSheet(page);

  await tapAt(page, node(1, 1));
  await tapAt(page, node(4, 3));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  await openProfile(page);
  // the engine says per preference how much of the route it applies to
  const touched = await page.evaluate(() => {
    const s = (
      window as unknown as { __kompass: { planner: { getSnapshot(): Record<string, unknown> } } }
    ).__kompass.planner.getSnapshot();
    const main = s.main as { result: { breakdown: { touched: { key: string; length_m: number }[] } } };
    const groups = (s.catalogue as { preferences: { id: string; group: string }[] }).preferences.reduce<
      Record<string, string>
    >((o, p) => Object.assign(o, { [p.id]: p.group }), {});
    return main.result.breakdown.touched.map((t) => ({ ...t, group: groups[t.key] as string }));
  });
  expect(touched.length).toBe(11); // every weight of Gravel explorer
  const some = touched.find((t) => t.length_m >= 5);
  expect(some).toBeDefined();
  for (const g of new Set(touched.map((t) => t.group))) await openGroup(page, g);
  for (const t of touched) {
    const row = page.getByTestId(`pref-${t.key}`);
    if (t.length_m >= 5) {
      await expect(row.getByTestId("pref-touches")).toHaveText(/^\d+(\.\d)? (km|m)$/);
      await expect(row).not.toHaveAttribute("data-dim");
    } else {
      await expect(row.getByTestId("pref-touches")).toHaveText("0 km");
      await expect(row).toHaveAttribute("data-dim", "true");
    }
  }
  await screenshot(page, testInfo, "planner-groups-open");
  // a group whose preferences all touch nothing says so when collapsed
  const byGroup = new Map<string, number>();
  for (const t of touched) byGroup.set(t.group, Math.max(byGroup.get(t.group) ?? 0, t.length_m));
  for (const [g, m] of byGroup) {
    await page.getByTestId(`group-head-${g}`).click();
    await expect(page.getByTestId(`group-head-${g}`)).toHaveAttribute("aria-expanded", "false");
    const none = page.getByTestId(`group-${g}`).getByTestId("group-none");
    if (m < 5) await expect(none).toHaveText("nothing on this route");
    else await expect(none).toHaveCount(0);
  }
  await page.getByTestId(`group-head-${some?.group}`).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, "planner-groups");
});

test("the blank slate is really empty: an invitation, then a preference added from it", async ({
  page,
}, testInfo) => {
  await fresh(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(4, 3));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  await openProfile(page);
  await page.getByTestId("base-name").click();
  await page.getByTestId("base-blank_slate").click();
  await expect(page.getByTestId("base-name")).toContainText("Blank slate");
  await expect(page.getByTestId("profile-empty")).toBeVisible();
  await expect(page.getByTestId("pref-groups")).toHaveCount(0);
  await expect(page.locator('[data-testid^="pref-"][data-row]')).toHaveCount(0);
  await expect(page.getByTestId("change-count")).toHaveText("· as it comes");
  await screenshot(page, testInfo, "planner-blank");
  if (phone(page)) {
    // the strip has no preference chips either
    await closeSheet(page);
    await expect(page.getByTestId("strip").locator('[data-testid^="chip-"]')).toHaveCount(0);
    await openProfile(page);
  }
  await page.getByTestId("profile-empty").getByTestId("add-preference").click();
  await page.getByTestId("picker-search").fill("gravel");
  await page.getByTestId("pick-unpaved").click();
  await expect(page.getByTestId("picker")).toHaveCount(0);
  // the new row's group opens, and the route says what the new slider touches
  await expect(page.getByTestId("profile-empty")).toHaveCount(0);
  await expect(page.getByTestId("group-head-surface")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("pref-unpaved").getByTestId("pref-touches")).toHaveText(/^\d/);
  await expect(page.getByTestId("change-sentence")).toHaveText("Blank slate, but more gravel.");
});

test("the route toggle hides the route lines (button and H), the stops stay", async ({ page }, testInfo) => {
  await fresh(page);
  await expect(page.getByTestId("route-toggle")).toHaveCount(0); // no route yet
  await tapAt(page, node(1, 1));
  await tapAt(page, node(4, 3));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  const visibility = () =>
    page.evaluate(() => {
      const map = window.__kompass.map as unknown as { getLayoutProperty(id: string, p: string): unknown };
      return ["planner-main-line", "planner-main-casing", "planner-alt-line", "planner-ghost-line"].map(
        (id) => map.getLayoutProperty(id, "visibility") ?? "visible",
      );
    });
  const toggle = page.getByTestId("route-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  if (!phone(page)) await expect(toggle).toHaveAttribute("title", "Hide the route (H)");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(visibility).toEqual(["none", "none", "none", "none"]);
  await expect(page.getByTestId("waypoint-marker")).toHaveCount(2);
  expect((await plan(page)).waypoints).toBe(2);
  await screenshot(page, testInfo, "planner-route-hidden");
  // the key brings it back, and hides it again
  await page.locator("body").press("h");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(visibility).toEqual(["visible", "visible", "visible", "visible"]);
  await page.keyboard.press("H");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // typing an "h" into a field leaves it alone
  if (phone(page)) await page.getByTestId("strip-add").click();
  else await page.getByTestId("add-preference").click();
  await page.getByTestId("picker-search").fill("");
  await page.getByTestId("picker-search").press("h");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});

test("a slider moves only from its knob: a tap on the track changes nothing", async ({ page }) => {
  await fresh(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(3, 0));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  const weight = () =>
    page.evaluate(() => {
      const s = (
        window as unknown as {
          __kompass: { planner: { getSnapshot(): { weights: Record<string, number> } } };
        }
      ).__kompass.planner.getSnapshot();
      return s.weights.quiet ?? 0;
    });
  if (phone(page)) await page.getByTestId("chip-quiet").click();
  else await openGroup(page, "traffic");
  const dial = page.getByRole("slider", { name: "Low traffic" });
  await dial.scrollIntoViewIfNeeded();
  const before = await weight();
  const box = (await dial.boundingBox()) as { x: number; y: number; width: number; height: number };
  // a tap and a press-and-drag on the track, well away from the knob
  const y = box.y + box.height / 2;
  const far = before > 0 ? box.x + 16 : box.x + box.width - 16;
  await page.mouse.click(far, y);
  if (phone(page)) await page.touchscreen.tap(far, y);
  await page.mouse.move(far, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
  await page.mouse.up();
  expect(await weight()).toBe(before);
  // a mostly vertical move from the knob does not move it either
  const knob = (await page.getByTestId("dial-Low traffic-knob").boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const kx = knob.x + knob.width / 2;
  const ky = knob.y + knob.height / 2;
  await page.mouse.move(kx, ky);
  await page.mouse.down();
  await page.mouse.move(kx + 3, ky + 30, { steps: 4 });
  await page.mouse.up();
  expect(await weight()).toBe(before);
  // dragging the knob does
  await page.mouse.move(kx, ky);
  await page.mouse.down();
  await page.mouse.move(kx - box.width / 2, ky, { steps: 8 });
  await page.mouse.up();
  await expect.poll(weight).toBeLessThan(before - 30);
  // the keyboard still works
  const dragged = await weight();
  await dial.focus();
  await dial.press("ArrowRight");
  await expect.poll(weight).toBe(Math.min(100, dragged + 5));
  // the detours slider likewise
  await openProfile(page);
  const detours = page.getByTestId("detours-slider");
  await detours.scrollIntoViewIfNeeded();
  const word = await page.getByTestId("detours-word").textContent();
  const d = (await detours.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(d.x + d.width - 14, d.y + d.height / 2);
  await expect(page.getByTestId("detours-word")).toHaveText(word ?? "");
  await expect(detours).toHaveAttribute("aria-valuenow", "10");
});

test("a limit that leaves no way is named, and lifting it brings the route back", async ({
  page,
}, testInfo) => {
  await fresh(page);
  await tapAt(page, node(0, 0));
  await tapAt(page, node(5, 5));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  await addFromPicker(page, "paved_only", "paved");
  await expect(page.getByTestId("error-title").first()).toHaveText("No route with “Paved only”");
  await expect(page.getByTestId("status-error").first()).not.toContainText("Looking for");
  // the route without the limit stays on the map as the ghost
  await expect.poll(async () => (await drawnLines(page)).alt).toEqual(["ghost"]);
  expect((await drawnLines(page)).main).toEqual([]);
  await rawScreenshot(page, testInfo, "planner-error");
  await page.getByTestId("lift-limit").first().click();
  await expect(page.getByTestId("status-error")).toHaveCount(0);
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
});

test("save a preset; it and the plan are there after a reload", async ({ page }) => {
  await fresh(page);
  await tapAt(page, node(1, 1));
  await tapAt(page, node(3, 0));
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  await openProfile(page);
  await openGroup(page, "traffic");
  const dial = page.getByRole("slider", { name: "Low traffic" });
  await dial.focus();
  await dial.press("End");
  await expect(page.getByTestId("change-count")).toHaveText("1 change");
  await page.getByTestId("save-preset").click();
  await page.getByTestId("preset-name").fill("Very quiet");
  await page.getByTestId("preset-save").click();
  await expect(page.getByTestId("base-name")).toContainText("Very quiet");
  await expect(page.getByTestId("change-count")).toHaveText("· as it comes");

  await page.reload();
  await waitIdle(page);
  await engineReady(page);
  await expect(page.getByTestId("waypoint-marker")).toHaveCount(2);
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
  await openProfile(page);
  await expect(page.getByTestId("base-name")).toContainText("Very quiet");
  await openGroup(page, "traffic");
  await expect(page.getByTestId("pref-quiet").getByTestId("pref-value")).toHaveText("+100");
  // the preset is in the chooser, and can go again
  await page.getByTestId("base-name").click();
  await expect(page.getByTestId("base-chooser")).toContainText("Very quiet");
  await page.getByTestId("base-chooser").getByRole("button", { name: "Very quiet" }).click();
  await page.getByTestId("delete-preset").click();
  await expect(page.getByTestId("base-name")).toContainText("Gravel explorer");
});

test("Map & rides: an information layer with its legend, inspecting a way, the ride library", async ({
  page,
}, testInfo) => {
  await fresh(page);
  await page.getByTestId("map-rides").click();
  await expect(page.getByTestId("layers-panel")).toBeVisible();
  await expect(page.getByTestId("rides-panel")).toBeAttached();
  await page.getByTestId("mode-attribute").click();
  await expect(page.getByTestId("map")).toHaveAttribute("data-layer", "surface_class");
  await expect(page.getByTestId("legend")).toContainText("Unknown");
  await screenshot(page, testInfo, "planner-layers");
  // inspect: a tap shows the way instead of adding a stop
  await page.getByTestId("inspect-toggle").click();
  await closeSheet(page);
  await expect(page.getByTestId("legend-pill")).toBeVisible();
  await expect(page.getByTestId("inspect-banner")).toBeVisible();
  const { point } = await clearEdge(page);
  await page.mouse.click(point.x, point.y);
  // the nearest way to the tap (at a junction that may be the neighbour)
  await expect(page.getByTestId("inspect-panel")).toHaveAttribute("data-edge-id", /^\d+$/);
  await expect(page.getByTestId("waypoint-marker")).toHaveCount(0);
  await page.getByTestId("inspect-done").click();
  await expect(page.getByTestId("inspect-panel")).toHaveCount(0);
  // back to the plain map: taps add stops again
  await page.getByTestId("map-rides").click();
  await page.getByTestId("mode-none").click();
  await expect(page.getByTestId("map")).toHaveAttribute("data-layer", "none");
  await closeSheet(page);
  await expect(page.getByTestId("legend-pill")).toHaveCount(0);
  await tapAt(page, node(2, 2));
  await expect(page.getByTestId("waypoint-marker")).toHaveCount(1);
});

test("the region graph downloading: the map works, the planner says so", async ({ page }, testInfo) => {
  await page.route(/\/data\/graph\//, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await r.continue();
  });
  await page.goto("./?dev");
  await page.evaluate(() =>
    localStorage.setItem(
      "kompass.plan.v1",
      JSON.stringify({
        v: 1,
        waypoints: [
          { id: "a", lon: -0.00675, lat: -0.00675 },
          { id: "b", lon: 0.00225, lat: -0.01125 },
        ],
        baseId: "gravel_explorer",
        weights: {},
        limits: {},
        compareId: null,
        lineBy: "plain",
      }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId("status-download").first()).toContainText(
    /Getting the region ready|Loading the region/,
  );
  await rawScreenshot(page, testInfo, "planner-downloading");
  await engineReady(page);
  await expect(page.getByTestId("status-download")).toHaveCount(0);
  await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
});

test.describe("in a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("the planner reads on the dark map", async ({ page }, testInfo) => {
    await fresh(page);
    await tapAt(page, node(1, 1));
    await tapAt(page, node(4, 4));
    await expect(page.getByTestId("stat-km").first()).toHaveText(/\d/);
    await openProfile(page);
    await screenshot(page, testInfo, "planner-profile");
    const slider = page.getByTestId("detours-slider");
    await slider.scrollIntoViewIfNeeded();
    await slider.focus();
    await slider.press("End");
    await expect(page.getByTestId("detours-word")).toHaveText("Go far for good ways");
    await screenshot(page, testInfo, "planner-detours");
  });
});
