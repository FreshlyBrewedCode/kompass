// Renders the mock-ups to PNG. Usage, from the repo root (after `bun install`, for the font):
//   nix develop -c bun docs/design/steering-widgets/round-1/render.mjs [outDir]
// Uses the nix Chromium (KOMPASS_E2E_CHROMIUM, set by the dev shell) on file URLs: no server.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? "/tmp/58-66";
mkdirSync(out, { recursive: true });
const url = (file, q) => `${pathToFileURL(join(here, file)).href}?${q}`;
const NAMES = { 1: "collapsed", 2: "board", 3: "hills" };

const browser = await chromium.launch({ executablePath: process.env.KOMPASS_E2E_CHROMIUM || undefined });
async function shot(file, q, width, height, name) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] ${e.message}`));
  await page.goto(url(file, q));
  for (const f of page.frames()) {
    await f.waitForLoadState("load");
    await f.evaluate(() => document.fonts.ready);
    if (!(await f.evaluate(() => document.fonts.check('600 14px "Manrope Variable"')))) console.log(`[${name}] font missing`);
  }
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: file === "sheet.html" });
  await ctx.close();
}
const only = process.env.ONLY?.split(",");
for (const d of ["A", "B", "C", "D"]) {
  if (only && !only.includes(d)) continue;
  for (const n of [1, 2, 3]) await shot("index.html", `f=${d}-${n}`, 390, 844, `${d}-${n}-${NAMES[n]}`);
  await shot("sheet.html", `d=${d}`, 1250, 940, d);
}
if (!only || only.includes("desktop")) await shot("index.html", "f=fav-desktop", 1440, 900, "fav-desktop");
await browser.close();
console.log(`PNGs in ${out}`);
