// Screenshots of the outdoor style on the demo region, for tuning it (docs/map.md, "Where to tune").
// Needs a dev server on the demo region (never another region: the pictures are meant to be public):
//   KOMPASS_DATA_DIR=data/build/demo KOMPASS_DEV_PORT=7960 bun run dev
//   nix develop -c bun scripts/map-shots.ts [--out /tmp/kompass-map] [--only z13,route] [--port 7960]
//     [--look '{"tracks":"simple","ground":"meadow"}'] (the map style options, src/map/look.ts) [--dpr 3]
// Each shot is the map alone (the chrome hidden), except `key`: the Map & rides sheet with the key.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const PORT = arg("port", process.env.KOMPASS_DEV_PORT ?? "7960");
const OUT = arg("out", "/tmp/kompass-map");
/** the map style options as stored (`kompass.mapLook`); empty: the defaults */
const LOOK = arg("look", "");
const DPR = Number(arg("dpr", "2"));
const only = arg("only", "")
  .split(",")
  .filter((s) => s !== "");

type Theme = "light" | "dark";
type Viewport = "phone" | "desktop";
type Shot = {
  name: string;
  theme: Theme;
  viewport: Viewport;
  zoom: number;
  center: [number, number];
  query?: string;
  route?: boolean;
  ridden?: boolean;
  key?: boolean;
};

/** Views on the demo region (Titisee, Black Forest): village, main roads, lake, forest tracks. */
const AT: Record<number, [number, number]> = {
  10: [8.12, 47.9],
  11: [8.105, 47.905],
  12: [8.14, 47.902],
  13: [8.15, 47.899],
  14: [8.152, 47.902],
  15: [8.1535, 47.9035],
  16: [8.158, 47.9025],
};
const at = (zoom: number) => AT[zoom] ?? (AT[13] as [number, number]);
const phone = (zoom: number, theme: Theme = "light", extra: Partial<Shot> = {}): Shot => ({
  name: `${theme}-phone-z${zoom}`,
  theme,
  viewport: "phone",
  zoom,
  center: at(zoom),
  ...extra,
});

const SHOTS: Shot[] = [
  ...[10, 11, 12, 13, 14, 15, 16].map((z) => phone(z)),
  { ...phone(12), name: "light-desktop-z12", viewport: "desktop" },
  { ...phone(14), name: "light-desktop-z14", viewport: "desktop" },
  phone(13, "dark"),
  phone(15, "dark"),
  phone(11, "dark"),
  phone(13, "light", { name: "light-phone-z13-route", route: true }),
  phone(13, "light", { name: "light-phone-z13-explored", query: "layer=explored", ridden: true }),
  phone(13, "light", { name: "light-phone-z13-surface", query: "layer=surface_class" }),
  phone(14, "light", { name: "light-phone-z14-cost", query: "layer=cost" }),
  phone(13, "light", { name: "light-phone-z13-traffic", query: "layer=road_near_traffic" }),
  phone(13, "dark", { name: "dark-phone-z13-route", route: true }),
  phone(14, "light", { name: "light-phone-key", key: true }),
  phone(14, "dark", { name: "dark-phone-key", key: true }),
];

const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

type Win = {
  __kompass: {
    map: {
      jumpTo(o: object): void;
      querySourceFeatures(s: string, o: object): { id?: number }[];
    };
    store: { setRidden(m: Map<number, object>): void };
    planner: {
      addWaypointAt(lon: number, lat: number): void;
      getSnapshot(): { routeResult?: unknown; line?: { result?: unknown } | null };
    };
  };
};

async function hideChrome(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="map"]');
    if (!el) return;
    const keep = new Set<Element>();
    for (let n: Element | null = el; n; n = n.parentElement) keep.add(n);
    const style = document.createElement("style");
    style.textContent = "[data-shot-hide]{visibility:hidden!important}";
    document.head.append(style);
    const mark = () => {
      for (const k of keep) {
        for (const child of k.children) {
          if (!keep.has(child) && k !== el) child.setAttribute("data-shot-hide", "");
        }
      }
      // the planner's markers and route stay: they are on the map
    };
    mark();
    new MutationObserver(mark).observe(document.body, { childList: true, subtree: true });
  });
}

async function settle(page: Page) {
  const map = page.getByTestId("map");
  await page.waitForTimeout(300);
  await map.and(page.locator('[data-idle="true"]')).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
for (const shot of SHOTS) {
  if (only.length > 0 && !only.some((o) => shot.name.includes(o))) continue;
  const context = await browser.newContext({ ...SIZES[shot.viewport], colorScheme: shot.theme });
  const page = await context.newPage();
  if (LOOK) await page.addInitScript((look) => localStorage.setItem("kompass.mapLook", look), LOOK);
  page.on("console", (m) => {
    if (m.type() === "error" && !/glyph|fonts|404/.test(m.text()))
      console.log("  console:", m.text().slice(0, 300));
  });
  await page.goto(`http://127.0.0.1:${PORT}/?dev${shot.query ? `&${shot.query}` : ""}`);
  await page.getByTestId("map").and(page.locator('[data-loaded="true"]')).waitFor({ timeout: 60_000 });
  if (!shot.key) await hideChrome(page);
  await page.evaluate(([c, z]) => (window as never as Win).__kompass.map.jumpTo({ center: c, zoom: z }), [
    shot.center,
    shot.zoom,
  ] as const);
  await settle(page);
  if (shot.route || shot.query === "layer=cost") {
    await page
      .getByTestId("engine-status")
      .and(page.locator('[data-status="ready"]'))
      .waitFor({ timeout: 60_000, state: "attached" });
  }
  if (shot.route) {
    await page.evaluate(() => {
      const { planner } = (window as never as Win).__kompass;
      planner.addWaypointAt(8.128, 47.921);
      planner.addWaypointAt(8.17, 47.876);
    });
    await page.waitForTimeout(2500);
    await page.evaluate(([c, z]) => (window as never as Win).__kompass.map.jumpTo({ center: c, zoom: z }), [
      shot.center,
      shot.zoom,
    ] as const);
    await settle(page);
  }
  if (shot.query === "layer=cost") await page.waitForTimeout(2000);
  if (shot.ridden) {
    // a made-up history: edge ids are Hilbert-sorted, so runs of ids are neighbourhoods
    await page.evaluate(() => {
      const k = (window as never as Win).__kompass;
      const out = new Map<number, object>();
      for (const f of k.map.querySourceFeatures("overlay", { sourceLayer: "edges" })) {
        if (typeof f.id === "number" && Math.floor(f.id / 60) % 3 === 0)
          out.set(f.id, { count: 1 + (Math.floor(f.id / 60) % 7), lastRidden: 0 });
      }
      k.store.setRidden(out);
    });
    await page.waitForTimeout(1500);
  }
  if (shot.key) {
    await page.getByTestId("map-rides").click();
    await page.getByTestId("mode-none").click();
    await page.getByTestId("map-key-toggle").click();
    await page.getByTestId("map-key").scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: join(OUT, `${shot.name}.png`) });
  console.log(shot.name);
  await context.close();
}
await browser.close();
