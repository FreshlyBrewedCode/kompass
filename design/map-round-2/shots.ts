// Screenshots of the map style round 2 variants on the demo region (dev server on 7960).
//   nix develop -c bun design/map-round-2/shots.ts [--variants a,b,c,d] [--themes light,dark]
//       [--viewports phone,desktop] [--zooms 11,13,15] [--out /tmp/kompass-map-round] [--view main]
// Never point the dev server at anything but the demo region: the pictures are public.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const PORT = process.env.KOMPASS_DEV_PORT ?? "7960";
const OUT = arg("out", "/tmp/kompass-map-round");
const variants = arg("variants", "a,b,c,d").split(",");
const themes = arg("themes", "light").split(",") as ("light" | "dark")[];
const viewports = arg("viewports", "phone").split(",");
const zooms = arg("zooms", "11,13,15").split(",").map(Number);
const viewName = arg("view", "main");
const extra = arg("query", "");
/** `none`: the map alone (the comparison); `full`: with the planner's chrome */
const chrome = arg("chrome", "none");
/** a GeoJSON line drawn as the planner's route (mock-route.py) */
const routeFile = arg("route", "");
const suffix = arg("suffix", "");
/** `--ridden 1`: mark a third of the edges in view as ridden (with `--query layer=explored`) */
const ridden = arg("ridden", "") !== "";

/** Views on the demo region (Black Forest east of Freiburg): village, main road, lake, forest tracks. */
export const VIEWS: Record<string, Record<number, [number, number]>> = {
  main: { 11: [8.105, 47.905], 13: [8.15, 47.899], 15: [8.1535, 47.9035] },
};

const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
for (const theme of themes) {
  for (const vp of viewports) {
    const context = await browser.newContext({ ...SIZES[vp as keyof typeof SIZES], colorScheme: theme });
    for (const variant of variants) {
      const page = await context.newPage();
      const style = variant === "0" ? "" : `&mapstyle=${variant}`;
      await page.goto(`http://127.0.0.1:${PORT}/?dev${style}${extra ? `&${extra}` : ""}`);
      const map = page.getByTestId("map");
      page.on("console", (m) => {
        if (m.type() === "error" && !/glyph|fonts|404/.test(m.text())) console.log("  console:", m.text().slice(0, 300));
      });
      await map.and(page.locator('[data-loaded="true"]')).waitFor({ timeout: 60_000 });
      if (chrome === "none") {
        // hide everything that is not the map or one of its ancestors
        await page.evaluate(() => {
          const el = document.querySelector('[data-testid="map"]');
          if (!el) return;
          const keep = new Set<Element>();
          for (let n: Element | null = el; n; n = n.parentElement) keep.add(n);
          const style = document.createElement("style");
          style.textContent = "[data-r2-hide]{visibility:hidden!important}";
          document.head.append(style);
          const mark = () => {
            for (const k of keep) {
              for (const child of k.children) {
                if (!keep.has(child) && k !== el) child.setAttribute("data-r2-hide", "");
              }
            }
          };
          mark();
          new MutationObserver(mark).observe(document.body, { childList: true, subtree: true });
        });
      }
      for (const zoom of zooms) {
        const center = VIEWS[viewName]?.[zoom] ?? VIEWS[viewName]?.[13];
        await page.evaluate(
          ([c, z]) => {
            const { map } = (window as never as { __kompass: { map: { jumpTo(o: object): void } } }).__kompass;
            map.jumpTo({ center: c, zoom: z });
          },
          [center, zoom] as const,
        );
        await page.waitForTimeout(300);
        await map.and(page.locator('[data-idle="true"]')).waitFor({ timeout: 60_000 });
        await page.waitForTimeout(1200);
        if (ridden) {
          // a made-up history: edge ids are Hilbert-sorted, so runs of ids are neighbourhoods
          await page.evaluate(() => {
            type F = { id?: number };
            const k = (
              window as never as {
                __kompass: {
                  map: { querySourceFeatures(s: string, o: object): F[] };
                  store: { setRidden(m: Map<number, object>): void };
                };
              }
            ).__kompass;
            const out = new Map<number, object>();
            for (const f of k.map.querySourceFeatures("overlay", { sourceLayer: "edges" })) {
              if (typeof f.id === "number" && Math.floor(f.id / 60) % 3 === 0)
                out.set(f.id, { count: 1 + (Math.floor(f.id / 60) % 7), lastRidden: 0 });
            }
            k.store.setRidden(out);
          });
          await page.waitForTimeout(1500);
        }
        if (routeFile) {
          // the stand-in route (mock-route.py), drawn like the planner's line (planner/route-layer.ts)
          await page.evaluate(
            ([data, dark]) => {
              type M = {
                getSource(id: string): unknown;
                addSource(id: string, s: object): void;
                addLayer(l: object, before?: string): void;
                getStyle(): { layers: { id: string; type: string }[] };
              };
              const { map } = (window as never as { __kompass: { map: M } }).__kompass;
              if (map.getSource("r2-route")) return;
              const before = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
              const w = (z13: number, z17: number) => ["interpolate", ["linear"], ["zoom"], 10, z13 * 0.7, 13, z13, 17, z17];
              const layout = { "line-cap": "round", "line-join": "round" };
              map.addSource("r2-route", { type: "geojson", data });
              map.addLayer(
                {
                  id: "r2-route-casing",
                  type: "line",
                  source: "r2-route",
                  layout,
                  paint: { "line-color": dark ? "#0c0e0d" : "#ffffff", "line-width": w(9, 13), "line-opacity": 0.9 },
                },
                before,
              );
              map.addLayer(
                {
                  id: "r2-route-line",
                  type: "line",
                  source: "r2-route",
                  layout,
                  paint: { "line-color": dark ? "#ff7a57" : "#d23f18", "line-width": w(5, 8) },
                },
                before,
              );
            },
            [JSON.parse(readFileSync(routeFile, "utf8")), theme === "dark"] as const,
          );
          await page.waitForTimeout(1200);
        }
        const name = `${variant}-${theme}-${vp}-z${zoom}${viewName === "main" ? "" : `-${viewName}`}${suffix}.png`;
        await page.screenshot({ path: join(OUT, name) });
        console.log(name);
      }
      await page.close();
    }
    await context.close();
  }
}
await browser.close();
