// Round 2 screenshots. Usage: bun scripts/shots2.mjs [ids, comma separated] [outDir]
// Needs the dev server on :7952 and a Chromium (`nix build nixpkgs#chromium -o .chromium`).
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ids = (process.argv[2] ?? "c1,c2,c3").split(",");
const out = process.argv[3] ?? "/tmp/kompass-design-2";
const NAMES = { c1: "Sheet", c2: "Strip", c3: "Bench" };
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? ".chromium/bin/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const P = { w: 390, h: 844 };
const D = { w: 1440, h: 900 };
const SHOTS = [
  { name: "phone", ...P, q: "theme=light&view=plan" },
  { name: "phone-profile", ...P, q: "theme=light&view=profile&demo=1" },
  { name: "phone-picker", ...P, q: "theme=light&view=profile&demo=1&picker=1" },
  { name: "desktop", ...D, q: "theme=dark&view=profile&demo=1" },
  ...(process.env.EXTRA ? [
    { name: "x-phone-hold", ...P, q: "theme=light&view=profile&demo=1&hold=climb" },
    { name: "x-phone-compare", ...P, q: "theme=light&view=profile&compare=1" },
    { name: "x-phone-debug", ...P, q: "theme=dark&view=layers&layer=debug" },
    { name: "x-phone-explored", ...P, q: "theme=light&view=layers&layer=explored" },
    { name: "x-phone-dark", ...P, q: "theme=dark&view=profile&demo=1" },
    { name: "x-desktop-light", ...D, q: "theme=light&view=plan&demo=1" },
    { name: "x-desktop-compare", ...D, q: "theme=dark&view=profile&compare=1" },
    { name: "x-desktop-picker", ...D, q: "theme=light&view=profile&demo=1&picker=1" },
    { name: "x-desktop-layers", ...D, q: "theme=dark&view=layers&layer=debug&demo=1" },
  ] : []),
];
const only = process.env.ONLY?.split(",");
for (const id of ids) {
  for (const s of SHOTS) {
    if (only && !only.includes(s.name)) continue;
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, hasTouch: s.w < 500, isMobile: s.w < 500 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${id}-${s.name}] page error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && console.log(`[${id}-${s.name}] console: ${m.text().slice(0, 300)}`));
    await page.goto(`http://127.0.0.1:7952/${id}?${s.q}`);
    await page.waitForFunction(() => window.__kompassMap?.loaded() && window.__kompassMap.areTilesLoaded(), null, { timeout: 60000 }).catch(() => console.log(`[${id}-${s.name}] map did not settle`));
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${out}/${id}-${s.name}.png` });
    await ctx.close();
    console.log(`${id}-${s.name}`);
  }
  if (only) continue;
  // board: three phone states on top, the desktop below; big labels, because it is reviewed on a phone
  const ctx = await browser.newContext({ viewport: { width: 2400, height: 3260 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const img = (n) => `data:image/png;base64,${readFileSync(`${out}/${id}-${n}.png`).toString("base64")}`;
  const fig = (n, w, t, r) => `<figure style="margin:0"><figcaption style="margin:0 0 14px 4px;font-size:30px;color:#c9ccd1">${t}</figcaption><img src="${img(n)}" style="width:${w}px;display:block;border-radius:${r}px;box-shadow:0 10px 50px #000b"></figure>`;
  await page.setContent(`<body style="margin:0;background:#1d1f22;font:600 30px system-ui;color:#fff;padding:40px 44px;box-sizing:border-box;width:2400px">
    <h1 style="margin:0 0 30px;font-size:56px;letter-spacing:-0.02em">${id.toUpperCase()} · ${NAMES[id] ?? ""}</h1>
    <div style="display:flex;justify-content:space-between;margin-bottom:44px">
      ${fig("phone", 730, "1 · Planning", 44)}${fig("phone-profile", 730, "2 · Profile, two added", 44)}${fig("phone-picker", 730, "3 · Add a preference", 44)}
    </div>
    ${fig("desktop", 2312, "4 · Desktop, dark", 18)}
  </body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: `${out}/${id}-board.png`, fullPage: true });
  await ctx.close();
  console.log(`${id}-board`);
}
await browser.close();
