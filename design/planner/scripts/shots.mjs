// Screenshots of every direction. Usage: bun scripts/shots.mjs [letters] [outDir]
// Needs the dev server on :7952 and a Chromium (`nix build nixpkgs#chromium -o .chromium`).
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const letters = (process.argv[2] ?? "abcd").split("");
const out = process.argv[3] ?? "/tmp/kompass-design-1";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? ".chromium/bin/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const SHOTS = [
  { name: "phone", w: 390, h: 844, q: "theme=light&view=plan" },
  { name: "phone-profile", w: 390, h: 844, q: "theme=light&view=profile" },
  { name: "desktop", w: 1440, h: 900, q: "theme=dark&view=plan&compare=1" },
  ...(process.env.EXTRA ? [
    { name: "x-phone-dark", w: 390, h: 844, q: "theme=dark&view=plan" },
    { name: "x-phone-layers", w: 390, h: 844, q: "theme=light&view=layers&layer=debug" },
    { name: "x-desktop-light", w: 1440, h: 900, q: "theme=light&view=profile" },
    { name: "x-desktop-explored", w: 1440, h: 900, q: "theme=dark&view=layers&layer=explored" },
  ] : []),
];
for (const l of letters) {
  for (const s of SHOTS) {
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, hasTouch: s.w < 500, isMobile: s.w < 500 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${l}-${s.name}] page error: ${e.message}`));
    await page.goto(`http://127.0.0.1:7952/${l}?${s.q}`);
    await page.waitForFunction(() => window.__kompassMap?.loaded() && window.__kompassMap.areTilesLoaded(), null, { timeout: 60000 }).catch(() => console.log(`[${l}-${s.name}] map did not settle`));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${l}-${s.name}.png` });
    await ctx.close();
    console.log(`${l}-${s.name}`);
  }
  // board: phone light planning + phone profile + desktop dark, on one image
  const ctx = await browser.newContext({ viewport: { width: 2400, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const img = (n) => `data:image/png;base64,${readFileSync(`${out}/${l}-${n}.png`).toString("base64")}`;
  await page.setContent(`<body style="margin:0;background:#1d1f22;display:flex;gap:28px;align-items:center;justify-content:center;height:1000px;font:600 15px system-ui;color:#ddd">
    ${[["phone", 416, "Phone · planning · light"], ["phone-profile", 416, "Phone · profile and compare"], ["desktop", 1440, "Desktop · dark"]].map(([n, w, t]) => `<figure style="margin:0"><figcaption style="margin:0 0 10px 2px"><span style="color:#fff;font-size:19px;margin-right:10px">${l.toUpperCase()}</span>${t}</figcaption><img src="${img(n)}" style="width:${w}px;display:block;border-radius:${n === "desktop" ? 10 : 26}px;box-shadow:0 8px 40px #000a"></figure>`).join("")}
  </body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: `${out}/${l}-board.png` });
  await ctx.close();
}
await browser.close();
