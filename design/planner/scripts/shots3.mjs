// Round 3 screenshots and boards. Usage: bun scripts/shots3.mjs [outDir]
// Needs the dev server on :7952 and a Chromium (`nix build nixpkgs#chromium -o .chromium`, or CHROMIUM=<path>).
// ONLY=name,name limits the shots; EXTRA=1 adds the states that are not part of the review set; BOARDS=0 skips the boards.
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "/tmp/kompass-design-3";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? ".chromium/bin/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const P = { w: 390, h: 844 };
const D = { w: 1440, h: 900 };
const SHOTS = [
  { name: "phone-plan", ...P, q: "theme=light" },
  { name: "phone-chip-slider", ...P, q: "theme=light&demo=1&chip=water" },
  { name: "phone-profile-list", ...P, q: "theme=light&demo=1&sheet=profile" },
  { name: "phone-picker", ...P, q: "theme=light&demo=1&picker=1" },
  { name: "x-phone-base", ...P, q: "theme=light&demo=1&sheet=profile", click: "Choose the base profile" },
  { name: "phone-compare", ...P, q: "theme=light&compare=1" },
  { name: "phone-layers", ...P, q: "theme=light&sheet=layers&layer=debug" },
  { name: "phone-empty", ...P, q: "theme=light&state=empty" },
  { name: "phone-dark-plan", ...P, q: "theme=dark" },
  { name: "desktop-plan", ...D, q: "theme=light" },
  { name: "desktop-dark", ...D, q: "theme=dark&demo=1" },
  { name: "desktop-compare", ...D, q: "theme=light&compare=1" },
  // for the colour board: the same state in round 2 and round 3
  { name: "color-r2-phone", ...P, path: "c2", q: "theme=light&view=profile&demo=1" },
  { name: "color-r2-desktop", ...D, path: "c1", q: "theme=light&view=plan&demo=1" },
  { name: "color-r3-desktop", ...D, q: "theme=light&demo=1" },
  ...(process.env.EXTRA ? [
    { name: "x-phone-hold", ...P, q: "theme=light&demo=1&hold=climb" },
    { name: "x-phone-route", ...P, q: "theme=light&demo=1&sheet=route" },
    { name: "x-phone-download", ...P, q: "theme=light&state=download&still=1" },
    { name: "x-phone-busy", ...P, q: "theme=light&state=busy" },
    { name: "x-phone-error", ...P, q: "theme=light&state=error" },
    { name: "x-phone-explored", ...P, q: "theme=light&layer=explored" },
    { name: "x-phone-legend-dark", ...P, q: "theme=dark&layer=debug" },
    { name: "x-phone-dark-profile", ...P, q: "theme=dark&demo=1&sheet=profile" },
    { name: "x-phone-surface-line", ...P, q: "theme=light&line=surface" },
    { name: "x-tablet", w: 820, h: 1180, q: "theme=light&demo=1&chip=water" },
    { name: "x-tablet-profile", w: 820, h: 1180, q: "theme=light&demo=1&sheet=profile" },
    { name: "x-landscape", w: 844, h: 390, q: "theme=light&demo=1" },
    { name: "x-desktop-picker", ...D, q: "theme=light&demo=1&picker=1" },
    { name: "x-desktop-layers", ...D, q: "theme=dark&sheet=layers&layer=debug" },
    { name: "x-desktop-error", ...D, q: "theme=light&state=error" },
  ] : []),
];
const only = process.env.ONLY?.split(",");
for (const s of SHOTS) {
  if (only && !only.includes(s.name)) continue;
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, hasTouch: s.w < 500, isMobile: s.w < 500 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${s.name}] page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && console.log(`[${s.name}] console: ${m.text().slice(0, 300)}`));
  await page.goto(`http://127.0.0.1:7952/${s.path ?? "final"}?${s.q}`);
  await page.waitForFunction(() => window.__kompassMap?.loaded() && window.__kompassMap.areTilesLoaded(), null, { timeout: 60000 }).catch(() => console.log(`[${s.name}] map did not settle`));
  if (s.click) await page.getByLabel(s.click).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${out}/${s.name}.png` });
  await ctx.close();
  console.log(s.name);
}

if (!only && process.env.BOARDS !== "0") {
  // boards: reviewed on a phone, so big labels and few pictures per board
  const img = (n) => `data:image/png;base64,${readFileSync(`${out}/${n}.png`).toString("base64")}`;
  const fig = (n, w, t, r) => `<figure style="margin:0"><figcaption style="margin:0 0 14px 4px;font-size:30px;color:#c9ccd1">${t}</figcaption><img src="${img(n)}" style="width:${w}px;display:block;border-radius:${r}px;box-shadow:0 10px 50px #000b"></figure>`;
  const board = async (name, title, body) => {
    const ctx = await browser.newContext({ viewport: { width: 2400, height: 600 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<body style="margin:0;background:#1d1f22;font:600 30px system-ui;color:#fff;padding:40px 44px;box-sizing:border-box;width:2400px"><h1 style="margin:0 0 30px;font-size:56px;letter-spacing:-0.02em">${title}</h1>${body}</body>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    await ctx.close();
    console.log(name);
  };
  const row = (inner) => `<div style="display:flex;justify-content:space-between;margin-bottom:44px">${inner}</div>`;
  await board("board-phone", "Round 3 · phone", row(fig("phone-plan", 548, "1 · Planning", 36) + fig("phone-chip-slider", 548, "2 · Tap a chip: one slider", 36) + fig("phone-profile-list", 548, "3 · The whole profile", 36) + fig("phone-picker", 548, "4 · Add a preference", 36)));
  await board("board-desktop", "Round 3 · desktop", `<div style="display:grid;gap:44px">${fig("desktop-plan", 2312, "1 · Planning, light", 18)}${fig("desktop-dark", 2312, "2 · Profile with 2 changes, dark", 18)}</div>`);
  await board("board-color", "Chrome colour · round 2 → round 3", row(`<div style="display:flex;gap:44px">${fig("color-r2-phone", 548, "Round 2 (C2)", 36)}${fig("phone-chip-slider", 548, "Round 3", 36)}</div><div style="display:grid;gap:36px">${fig("color-r2-desktop", 1124, "Round 2 (C1)", 12)}${fig("color-r3-desktop", 1124, "Round 3", 12)}</div>`));
}
await browser.close();
