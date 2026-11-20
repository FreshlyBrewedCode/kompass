// Comparison sheets of the round: the four variants of one zoom and theme in a 2×2 grid, labelled.
//   nix develop -c bun design/map-round-2/sheet.ts [--dir /tmp/kompass-map-round] [--zooms 11,13,15]
//       [--themes light,dark] [--viewport phone] [--suffix ""]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const DIR = arg("dir", "/tmp/kompass-map-round");
const zooms = arg("zooms", "11,13,15").split(",");
const themes = arg("themes", "light,dark").split(",");
const viewport = arg("viewport", "phone");
const suffix = arg("suffix", "");
const NAMES: Record<string, string> = {
  a: "A · Classic",
  b: "B · Surface first",
  c: "C · Quiet base",
  d: "D · Bands",
};

const browser = await chromium.launch({
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
});
for (const theme of themes) {
  for (const zoom of zooms) {
    const cells = Object.entries(NAMES).flatMap(([id, name]) => {
      const file = join(DIR, `${id}-${theme}-${viewport}-z${zoom}${suffix}.png`);
      if (!existsSync(file)) return [];
      const data = readFileSync(file).toString("base64");
      return [`<figure><figcaption>${name}</figcaption><img src="data:image/png;base64,${data}"></figure>`];
    });
    if (cells.length === 0) continue;
    const dark = theme === "dark";
    const columns = 2;
    // desktop shots are shown at half size (the sheet is rendered at 2×, so no pixel is lost)
    const width = viewport === "phone" ? 390 : 720;
    const page = await browser.newPage({
      viewport: { width: columns * width + (columns + 1) * 12, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.setContent(`<!doctype html><style>
      body{margin:0;padding:12px;background:${dark ? "#0b0c0b" : "#ffffff"};color:${dark ? "#f0f1ed" : "#161816"};
        font:600 17px/1.2 system-ui,sans-serif}
      h1{font-size:15px;font-weight:500;margin:0 0 10px;opacity:.7}
      main{display:grid;grid-template-columns:repeat(${columns},${width}px);gap:12px}
      figure{margin:0} figcaption{padding:0 0 6px}
      img{display:block;width:${width}px;border-radius:10px}
    </style><h1>Kompass map round 2 · zoom ${zoom} · ${theme}${suffix ? ` · ${suffix.slice(1)}` : ""} · demo region</h1>
    <main>${cells.join("")}</main>`);
    const out = join(DIR, `sheet-z${zoom}-${theme}${viewport === "phone" ? "" : `-${viewport}`}${suffix}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(out);
    await page.close();
  }
}
await browser.close();
