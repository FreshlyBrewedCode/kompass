// A · Lanes. A tier list: one lane per tier, the ways as chips (drag, or tap and pick). The hills curve
// is a chart with handles to drag, the route's grade distribution behind it.
/* global I, TIERS, tier, WAYS, SURFS, HILLS, HIST, PTS, way, km, gLabel, mLabel, spark, presets, stepper, looseRow, hillsTotal, frames */

/** Collapsed: the lanes in miniature, avoid on the left, one dot per way. */
function aMini(rows) {
  return `<span style="display:flex;gap:2px">${TIERS.map((t) => {
    const dots = rows.filter((r) => r.tier === t.id);
    const never = t.id === "avoid";
    return `<span style="display:flex;gap:2px;align-items:center;justify-content:center;min-width:14px;height:14px;padding:0 3px;border-radius:4px;background:${never ? "var(--hatch)" : "var(--muted)"};${never ? "box-shadow:inset 0 0 0 1px var(--input)" : ""}">${dots.map((r) => `<i style="width:6px;height:6px;border-radius:9px;background:${r.color}"></i>`).join("")}</span>`;
  }).join("")}</span>`;
}

const A_RATE = { love: "1 km is 1 km", like: "1 km → 1.15 km", fine: "1 km → 1.35 km", dislike: "1 km → 2 km", avoid: "never" };

function aBoard() {
  const lanes = [...TIERS].reverse().map((t) => {
    const chips = WAYS.filter((w) => w.tier === t.id)
      .sort((a, b) => b.km - a.km)
      .map(
        (w) =>
          `<div class="chip ${w.id === "path" ? "sel" : ""}">${t.id === "avoid" ? I("lock", 14) : ""}<i class="sw" style="background:${w.color}"></i>${w.name}${w.sub ? ` ${w.sub}` : ""}<small>${w.km ? km(w.km) : "not on this route"}</small></div>`,
      )
      .join("");
    return `<div class="a-lane ${t.id === "avoid" ? "never" : ""}"><div class="a-lab"><b>${t.label}</b><span>${A_RATE[t.id]}</span></div><div class="a-chips">${chips}</div></div>`;
  });
  const p = way("path");
  return `${lanes.join("")}
  <div class="a-pick">
    <div class="h"><i class="sw" style="background:${p.color}"></i><b>Path</b><span class="mut xs">3.2 km of this route · drag it, or pick:</span></div>
    <div class="tierbar">${TIERS.map((t) => `<div class="${t.id === "like" ? "on" : ""} ${t.id === "avoid" ? "never" : ""}">${t.label}<small>${t.short}</small></div>`).join("")}</div>
  </div>
  <div class="note">To stay on ways you love, the route may be up to <b>1.35× longer</b> than on ways that are fine.</div>`;
}

/** The chart: signed grade against "a metre counts as", log scale; handles at the fixed grades. */
function aChart({ w = 358, h = 222, sel = 10, interactive = true } = {}) {
  const L = 36;
  const R = 10;
  const T = 22;
  const B = interactive ? 40 : 24;
  const pw = w - L - R;
  const ph = h - T - B;
  const x = (g) => L + ((g + 20) / 40) * pw;
  const y = (v) => T + (1 - Math.log2(v) / 3) * ph;
  const bw = pw / HIST.length;
  const hmax = Math.max(...HIST);
  const bars = HIST.map((k, i) => {
    const bh = (k / hmax) * ph * 0.72;
    return `<rect x="${(L + i * bw + 1).toFixed(1)}" y="${(T + ph - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="var(--route-tint)"/>`;
  }).join("");
  const grid = [1, 2, 4, 8]
    .map(
      (v) =>
        `<line x1="${L}" x2="${w - R}" y1="${y(v)}" y2="${y(v)}" stroke="rgb(22 24 22 / ${v === 1 ? 0.3 : 0.1})"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#5f635f">${v} m</text>`,
    )
    .join("");
  const line = [[-20, PTS[0][1]], ...PTS, [20, PTS[PTS.length - 1][1]]]
    .map(([g, v], i) => `${i ? "L" : "M"}${x(g).toFixed(1)} ${y(v).toFixed(1)}`)
    .join("");
  const ticks = HILLS.map(
    (p) =>
      `<text x="${x(p.g)}" y="${T + ph + 16}" text-anchor="middle" font-size="11" font-weight="${p.g === sel && interactive ? 800 : 500}" fill="${p.g === sel && interactive ? "#161816" : "#5f635f"}">${p.g > 0 ? "+" : ""}${p.g === 0 ? "0" : String(p.g).replace("-", "−")}</text>`,
  ).join("");
  const handles = HILLS.map((p) => {
    if (p.pinned) return `<rect x="${x(0) - 4.5}" y="${y(1) - 4.5}" width="9" height="9" rx="2" fill="#161816"/>`;
    if (!interactive) return `<circle cx="${x(p.g)}" cy="${y(p.v)}" r="2.5" fill="#161816"/>`;
    if (p.g === sel)
      return `<line x1="${x(p.g)}" x2="${x(p.g)}" y1="${T}" y2="${T + ph}" stroke="#161816" stroke-dasharray="2 3"/>
        <circle cx="${x(p.g)}" cy="${y(p.v)}" r="22" fill="rgb(22 24 22 / .08)"/><circle cx="${x(p.g)}" cy="${y(p.v)}" r="11" fill="#161816" stroke="#fff" stroke-width="2"/>
        <g transform="translate(${x(p.g) - 76} ${y(p.v) - 15})"><rect width="58" height="24" rx="12" fill="#161816"/><text x="29" y="16.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${mLabel(p.v)}</text></g>`;
    return `<circle cx="${x(p.g)}" cy="${y(p.v)}" r="9" fill="#fff" stroke="#161816" stroke-width="2.5"/>`;
  }).join("");
  const foot = interactive
    ? `<text x="${L}" y="${h - 4}" font-size="10.5" fill="#5f635f">← downhill</text><text x="${w - R}" y="${h - 4}" text-anchor="end" font-size="10.5" fill="#5f635f">uphill, grade in % →</text>`
    : "";
  return `<svg width="${w}" height="${h}" style="display:block">
    <text x="0" y="11" font-size="11" fill="#5f635f">a metre counts as</text>
    <rect x="${w - R - 96}" y="3" width="10" height="10" rx="2" fill="var(--route-tint)"/><text x="${w - R}" y="12" text-anchor="end" font-size="11" fill="#5f635f">this route’s km</text>
    ${bars}${grid}<path d="${line}" fill="none" stroke="#161816" stroke-width="2.25" stroke-linejoin="round"/>${handles}${ticks}${foot}</svg>`;
}

function aHills() {
  const p = HILLS.find((h) => h.g === 10);
  return `${presets(1)}
  <div style="margin-top:12px">${aChart()}</div>
  <div class="line" style="margin-top:2px">
    <div class="step"><div class="btn"><i>${I("chevron-down", 16, "transform:rotate(90deg)")}</i></div><div class="val" style="min-width:60px">${gLabel(10)}</div><div class="btn"><i>${I("chevron-down", 16, "transform:rotate(-90deg)")}</i></div></div>
    <div class="grow"></div>${stepper(mLabel(p.v))}
  </div>
  <div class="note"><b>At 10 % uphill a metre counts as 2.5 m.</b> On this route: ${km(p.km)} around 10 % count as ${km(p.km * p.v)}.</div>
  <div class="hr" style="margin-top:10px"></div>
  ${looseRow()}
  ${hillsTotal()}`;
}

frames("A", {
  surface: { right: aMini(SURFS), sum: "love fine gravel, like gravel · dislike soft ground" },
  ways: { right: aMini(WAYS), sum: "love tracks, cycle paths · never main roads" },
  terrain: { right: spark(PTS), sum: "Don’t mind · a metre at 10 % counts as 2.5 m" },
  bodies: { ways: aBoard, terrain: aHills },
});
