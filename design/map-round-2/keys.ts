// The key (legend) of each variant as an image: `key-<variant>.png` (light) and `key-<variant>-dark.png`.
//   nix develop -c bun design/map-round-2/keys.ts [--out /tmp/kompass-map-round]
import { join } from "node:path";
import { chromium } from "@playwright/test";

const i = process.argv.indexOf("--out");
const OUT = i > 0 ? (process.argv[i + 1] as string) : "/tmp/kompass-map-round";
const PORT = process.env.KOMPASS_DEV_PORT ?? "7960";
const browser = await chromium.launch({
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
for (const theme of ["light", "dark"] as const) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  for (const id of ["a", "b", "c", "d"]) {
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("  error:", e.message.slice(0, 300)));
    await page.goto(`http://127.0.0.1:${PORT}/?mapkey=${id}`);
    const card = page.locator('[data-testid="map-key"][data-ready="true"]');
    await card.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(500);
    const name = `key-${id}${theme === "dark" ? "-dark" : ""}.png`;
    await card.screenshot({ path: join(OUT, name) });
    console.log(name);
    await page.close();
  }
  await context.close();
}
await browser.close();
