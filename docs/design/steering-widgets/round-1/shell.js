// The shared frame of every mock-up: the phone, the sheet, the grouped panel as built in #61, and the
// made-up content (a gravel rider's settings, a 41.6 km route). Nothing here is real data.
/* global ICONS */
ICONS.history =
  '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>';

const I = (name, size = 16, style = "") =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="${style}">${ICONS[name]}</svg>`;

// ------------------------------------------------------------------ content
/** Tiers, worst to best (left to right, like the sliders: avoid on the left). */
const TIERS = [
  { id: "avoid", label: "Avoid", short: "never", km: null },
  { id: "dislike", label: "Dislike", short: "2 km", km: 2 },
  { id: "fine", label: "Fine", short: "1.35 km", km: 1.35 },
  { id: "like", label: "Like", short: "1.15 km", km: 1.15 },
  { id: "love", label: "Love", short: "1 km", km: 1 },
];
const tier = (id) => TIERS.find((t) => t.id === id);
const TIER_INK = { love: "var(--t-love)", like: "var(--t-like)", fine: "var(--t-fine)", dislike: "var(--t-dislike)" };

/** The road-type board, in the order of the road's size. `km`: on the current route. */
const WAYS = [
  { id: "main", name: "Main road", color: "#8e2f3c", tier: "avoid", km: 0 },
  { id: "country", name: "Country road", color: "#dcae2f", tier: "dislike", km: 8.0 },
  { id: "residential", name: "Residential", color: "#a8aeb6", tier: "fine", km: 3.7 },
  { id: "service", name: "Service road", color: "#c9cdd2", tier: "fine", km: 0.9 },
  { id: "roadside", name: "Cycle path", sub: "beside a road", color: "#a59cff", tier: "fine", km: 2.3 },
  { id: "cycle", name: "Cycle path", sub: "away from roads", color: "#6f5df0", tier: "love", km: 4.1 },
  { id: "track", name: "Track", color: "#86a845", tier: "love", km: 19.4 },
  { id: "path", name: "Path", color: "#1f7a5c", tier: "like", km: 3.2, changed: true },
];
const way = (id) => WAYS.find((w) => w.id === id);
const ROUTE_KM = 41.6;
const km = (v) => `${v.toFixed(1)} km`;
const tierKm = (t) => WAYS.filter((w) => w.tier === t).reduce((s, w) => s + w.km, 0);

/** The hills curve: handles at fixed grades, the value is what a metre counts as. */
const HILLS = [
  { g: -15, v: 1.6, word: "steep descent", band: "steeper than −12 %", km: 0.3 },
  { g: -8, v: 1.1, word: "descent", band: "−12 to −5 %", km: 3.6 },
  { g: 0, v: 1, word: "the yardstick", band: "−5 to +2 %", km: 24.6, pinned: true },
  { g: 3, v: 1.1, word: "gentle rise", band: "2 to 5 %", km: 7.1 },
  { g: 6, v: 1.4, word: "steady climb", band: "5 to 8 %", km: 3.6 },
  { g: 10, v: 2.5, word: "steep", band: "8 to 12 %", km: 1.8 },
  { g: 15, v: 5, word: "a wall", band: "steeper than 12 %", km: 0.6 },
];
const gLabel = (g) => (g === 0 ? "flat" : `${g > 0 ? "+" : "−"}${Math.abs(g)} %`);
const mLabel = (v) => `${v % 1 === 0 ? v : v.toFixed(v * 10 % 1 === 0 ? 1 : 2)} m`;
const HILLS_EXTRA_KM = HILLS.reduce((s, h) => s + h.km * (h.v - 1), 0); // 7.8
/** The route's grade distribution: km per 2 % bin from −20 to +20 %. */
const HIST = [0, 0.05, 0.1, 0.2, 0.4, 0.7, 1.3, 2.4, 4.6, 9.2, 9.6, 5.4, 3.3, 2.0, 1.2, 0.6, 0.3, 0.15, 0.07, 0.03];
const PRESETS = ["Flat please", "Don't mind", "Climber", "No walls"];
const LOOSE = 20;

/** Log-linear between the handles, flat beyond the ends. */
function curve(points, g) {
  if (g <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [g0, v0] = points[i - 1];
    const [g1, v1] = points[i];
    if (g <= g1) return Math.exp(Math.log(v0) + ((g - g0) / (g1 - g0)) * (Math.log(v1) - Math.log(v0)));
  }
  return points[points.length - 1][1];
}
const PTS = HILLS.map((h) => [h.g, h.v]);
/** A sparkline of a curve, for the collapsed line and the preset cards. */
function spark(points, w = 56, h = 20, stroke = "currentColor") {
  const x = (g) => 1 + ((g + 20) / 40) * (w - 2);
  const y = (v) => h - 2 - (Math.log2(Math.max(v, 1)) / 3) * (h - 4);
  const d = [[-20, points[0][1]], ...points, [20, points[points.length - 1][1]]]
    .map(([g, v], i) => `${i ? "L" : "M"}${x(g).toFixed(1)} ${y(v).toFixed(1)}`)
    .join("");
  return `<svg width="${w}" height="${h}" style="flex:none"><line x1="1" x2="${w - 1}" y1="${h - 2}" y2="${h - 2}" stroke="rgb(22 24 22 / .15)"/><line x1="${x(0)}" x2="${x(0)}" y1="2" y2="${h - 2}" stroke="rgb(22 24 22 / .15)"/><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ------------------------------------------------------------------ frame
const mapSvg = (w = 390, h = 844, box = "0 0 390 844") => `
<svg class="map" viewBox="${box}" preserveAspectRatio="xMidYMid slice" width="${w}" height="${h}">
  <rect x="-100" width="700" height="844" fill="#efe9d6"/>
  <path d="M-20 60 C60 20 120 110 210 80 S330 10 420 70 V-10 H-20Z" fill="#cfdcb4"/>
  <path d="M250 210 C300 180 380 200 400 260 V420 C340 400 270 330 250 210Z" fill="#cfdcb4"/>
  <path d="M-10 300 C60 280 110 330 90 400 S10 470 -10 450Z" fill="#cfdcb4"/>
  <g fill="none" stroke="#fffdf6" stroke-width="5" stroke-linecap="round">
    <path d="M-10 170 C80 150 150 210 240 190 S350 150 400 180"/><path d="M130 -10 C120 90 170 170 150 260 S110 380 140 470"/>
    <path d="M300 60 C280 140 320 220 290 320"/>
  </g>
  <path d="M60 250 C110 200 150 150 215 165 S290 120 330 95" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
  <path d="M60 250 C110 200 150 150 215 165 S290 120 330 95" fill="none" stroke="#d23f18" stroke-width="4.5" stroke-linecap="round"/>
  <g font-family="Manrope Variable" font-weight="700" font-size="12" text-anchor="middle">
    <circle cx="60" cy="250" r="12" fill="#161816" stroke="#fff" stroke-width="2"/><text x="60" y="254.5" fill="#fff">A</text>
    <circle cx="330" cy="95" r="12" fill="#161816" stroke="#fff" stroke-width="2"/><text x="330" y="99.5" fill="#fff">B</text>
  </g>
</svg>`;
const topbar = () => `
<div class="topbar">
  <div class="pill round">${I("compass", 20)}</div>
  <div class="pill later">Ride mode</div>
  <div class="pill" style="margin-left:auto">${I("eye", 18)}${I("layers", 18)}</div>
</div>`;
const stats = () => `
<div class="stats">
  <span><b>41.6</b><small>km</small></span><span><b>620</b><small>m ↑</small></span><span><b>2:48</b><small>h</small></span>
  <div class="close">${I("x", 16)}</div>
</div>`;
const baseBox = () => `
<div class="base">
  <div class="l1">Gravel explorer ${I("chevron-down", 16)} <i class="dot"></i><span>1 change</span></div>
  <div class="xs mut">Tracks, forest edges, something new · but paths a tier up</div>
</div>`;

/** `detent`: "half" (the sheet as tall as its content) or "full". `dock`: pinned to the sheet's bottom. */
function phone({ detent = "full", body, dock = "" }) {
  return `<div class="phone">${mapSvg()}${topbar()}
  <div class="sheet ${detent} ${dock ? "docked" : ""}"><div class="grab"></div>${stats()}<div class="sheet-body">${body}</div>${dock}</div></div>`;
}

function group({ icon, label, count, changed, right = "", sum, dim, open, body = "" }) {
  return `<section class="grp ${dim ? "dim" : ""}">
  <div class="grp-head">${I(icon, 16)}
    <div class="grp-text">
      <div class="grp-title">${label}${changed ? '<i class="dot"></i>' : ""}${count ? `<span class="cnt">${count}</span>` : ""}<span class="grp-right">${dim ? "nothing on this route" : right}</span></div>
      <div class="grp-sum">${sum}</div>
    </div>${I(open ? "chevron-up" : "chevron-down", 16, "color:var(--muted-foreground)")}
  </div>${open ? `<div class="grp-body">${body}</div>` : ""}</section>`;
}

/** The slider groups that stay as they are. */
const REST = {
  traffic: { icon: "car", label: "Traffic", count: 1, sum: "loves quiet" },
  landscape: { icon: "trees", label: "Landscape", count: 2, sum: "likes forest edge, rather avoids built-up areas" },
  trail: { icon: "footprints", label: "Trail difficulty", count: 1, sum: "avoids sketchy trails", dim: true },
  history: { icon: "history", label: "My rides", count: 1, sum: "likes new ground" },
};
const ORDER = ["surface", "ways", "traffic", "landscape", "terrain", "trail", "history"];

/**
 * The panel of one direction. `dir` gives the collapsed lines of the three widget groups
 * (`{ surface, ways, terrain }`, each `{ sum, right }`) and their open bodies (`bodies`).
 * `open`: which group is open; `from`: the first group shown (the sheet is scrolled to it).
 */
function panel(dir, { open = null, from = "surface", upTo = "history" } = {}) {
  const widgets = {
    surface: { icon: "grid-3x3", label: "Surface", ...dir.surface },
    ways: { icon: "route", label: "Way type", changed: true, ...dir.ways },
    terrain: { icon: "mountain", label: "Terrain", ...dir.terrain },
  };
  return ORDER.slice(ORDER.indexOf(from), ORDER.indexOf(upTo) + 1)
    .map((id) => group({ ...(widgets[id] ?? REST[id]), open: id === open, body: id === open ? dir.bodies[id]() : "" }))
    .join("");
}

/** The three phone frames of a direction. */
function frames(key, dir) {
  window.FRAMES = window.FRAMES ?? {};
  window.FRAMES[`${key}-1`] = () => phone({ detent: "half", body: baseBox() + panel(dir) });
  window.FRAMES[`${key}-2`] = () =>
    phone({ body: panel(dir, { open: "ways", from: "surface" }), dock: dir.dock?.ways?.() ?? "" });
  window.FRAMES[`${key}-3`] = () =>
    phone({ body: panel(dir, { open: "terrain", from: "landscape" }), dock: dir.dock?.terrain?.() ?? "" });
}

// ------------------------------------------------------------------ parts shared by directions
const presets = (on = 1) =>
  `<div class="seg">${PRESETS.map((p, i) => `<div class="${i === on ? "on" : ""}">${p}</div>`).join("")}</div>`;
const stepper = (val, cls = "") =>
  `<div class="step ${cls}"><div class="btn"><i>${I("minus", 16)}</i></div><div class="val">${val}</div><div class="btn"><i>${I("plus", 16)}</i></div></div>`;
const looseRow = () => `
<div class="line"><div class="grow"><div class="t">Steeper on loose ground</div>
  <div class="s">8 % on gravel is read as ${(8 * (1 + LOOSE / 100)).toFixed(1)} %</div></div>${stepper(`${LOOSE} %`)}</div>`;
const hillsTotal = () =>
  `<div class="total"><b>+${HILLS_EXTRA_KM.toFixed(1)} km</b> the hills of this route count as, on top of its 41.6 km</div>`;
const wayName = (w, sep = " ") => (w.sub ? `${w.name}${sep}<small>${w.sub}</small>` : w.name);

/** The surface board (only its collapsed line is drawn in this round). */
const SURFS = [
  { id: "paved", name: "Paved", color: "#5d6b7c", tier: "fine", km: 9.8 },
  { id: "rough", name: "Rough paved", sub: "cobbles", color: "#8a94a2", tier: "dislike", km: 0.4 },
  { id: "compacted", name: "Fine gravel", sub: "compacted", color: "#dcae5a", tier: "love", km: 14.6 },
  { id: "gravel", name: "Gravel", color: "#c98a1e", tier: "like", km: 11.9 },
  { id: "soft", name: "Soft ground", color: "#8f5630", tier: "dislike", km: 3.1 },
  { id: "unknown", name: "Unknown", color: "#a3a3a3", tier: "fine", km: 1.8 },
];
