// Spike #5: contact sheets of debug PNGs, 6 per sheet (3 × 2 at 400 px), for looking at many at once.
// Usage: bun engine/spike5/sheet.ts <out prefix> <png…>
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [prefix, ...files] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
});
const page = await browser.newPage({ viewport: { width: 1200, height: 830 } });
for (let i = 0; i * 6 < files.length; i++) {
  const group = files.slice(i * 6, i * 6 + 6);
  const html = `<body style="margin:0;display:grid;grid-template-columns:repeat(3,400px);font:11px sans-serif">${group
    .map(
      (f, k) =>
        `<div><img src="file://${f}" width="400" height="400"><div style="position:relative;top:-400px;background:#fffc;width:20px">${i * 6 + k}</div></div>`,
    )
    .join("")}</body>`;
  const tmp = `${prefix}-${i}.html`;
  writeFileSync(tmp, html);
  await page.goto(`file://${tmp}`);
  await page.screenshot({ path: `${prefix}-${i}.png` });
}
await browser.close();
