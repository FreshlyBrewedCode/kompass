// All four keys side by side: `sheet-keys-<theme>.png`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const i = process.argv.indexOf("--dir");
const DIR = i > 0 ? (process.argv[i + 1] as string) : "/tmp/kompass-map-round";
const browser = await chromium.launch({
  ...(process.env.KOMPASS_E2E_CHROMIUM ? { executablePath: process.env.KOMPASS_E2E_CHROMIUM } : {}),
});
for (const theme of ["light", "dark"]) {
  const imgs = ["a", "b", "c", "d"].map((id) => {
    const data = readFileSync(join(DIR, `key-${id}${theme === "dark" ? "-dark" : ""}.png`)).toString("base64");
    return `<img src="data:image/png;base64,${data}">`;
  });
  const page = await browser.newPage({ viewport: { width: 2 * 390 + 36, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><style>
    body{margin:0;padding:12px;background:${theme === "dark" ? "#0b0c0b" : "#ffffff"}}
    main{display:grid;grid-template-columns:repeat(2,390px);gap:12px}
    img{display:block;width:390px;border-radius:10px}</style><main>${imgs.join("")}</main>`);
  const out = join(DIR, `sheet-keys-${theme}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
  await page.close();
}
await browser.close();
