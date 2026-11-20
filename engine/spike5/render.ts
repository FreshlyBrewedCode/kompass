// Spike #5: renders debug SVGs (from `kompass match --svg <dir>`) to PNGs next to them, in headless
// Chromium (the nix one: KOMPASS_E2E_CHROMIUM). Usage: bun engine/spike5/render.ts <dir> [name filter]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const dir = process.argv[2] ?? ".";
const filter = process.argv[3] ?? "";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
});
const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
let n = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg") && f.includes(filter))) {
  await page.goto(`file://${join(dir, f)}`);
  await page.screenshot({ path: join(dir, f.replace(/\.svg$/, ".png")) });
  n++;
}
await browser.close();
console.log(`rendered ${n}`);
