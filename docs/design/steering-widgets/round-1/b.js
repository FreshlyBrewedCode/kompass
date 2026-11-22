// B · Matrix. Ways × tiers, one tap moves a way; the avoid column stands apart. The hills curve as an
// equalizer: one vertical slider per handle, evenly spaced (so every handle is a 47 px column), the
// route's kilometres per grade band behind.
/* global I, TIERS, WAYS, SURFS, HILLS, km, gLabel, mLabel, presets, stepper, looseRow, hillsTotal, frames */

/** Collapsed: one dot per row at the height of its tier (the matrix turned on its side). */
function bMini(rows) {
  const level = { avoid: 0, dislike: 1, fine: 2, like: 3, love: 4 };
  const h = 18;
  return `<svg width="${rows.length * 8 + 2}" height="${h}">${rows
    .map((r, i) => {
      const cy = h - 3 - level[r.tier] * 3;
      const cx = 5 + i * 8;
      return r.tier === "avoid"
        ? `<path d="M${cx - 2.5} ${cy - 2.5}l5 5m0 -5l-5 5" stroke="#161816" stroke-width="1.5" stroke-linecap="round"/>`
        : `<line x1="${cx}" x2="${cx}" y1="${h - 1}" y2="${cy}" stroke="rgb(22 24 22 / .15)" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="3" fill="${r.color}"/>`;
    })
    .join("")}</svg>`;
}

function bBoard(rows = WAYS, { note = true } = {}) {
  const head = `<div></div>${TIERS.map((t, i) => `${i === 1 ? "<div></div>" : ""}<div class="b-colh">${t.id === "avoid" ? "Avoid" : t.label}<small>${t.id === "avoid" ? `<span style="display:inline-flex;gap:2px;align-items:center">${I("lock", 9)}never</span>` : t.short}</small></div>`).join("")}`;
  const body = rows
    .map((w, r) => {
      const cells = TIERS.map(
        (t, i) =>
          `${i === 1 ? `<div style="position:relative;height:100%"></div>` : ""}<div class="b-cell ${w.tier === t.id ? "on" : ""}"><i>${w.tier === t.id && t.id === "avoid" ? I("lock", 13) : ""}</i></div>`,
      ).join("");
      return `${r ? '<div class="b-rowline"></div>' : ""}<div class="b-lab"><i class="sw" style="background:${w.color}"></i><div class="n">${w.name}${w.changed ? ' <i class="dot" style="display:inline-block;vertical-align:middle"></i>' : ""}${w.sub ? `<small>${w.sub}</small>` : ""}</div><span class="km">${w.km ? w.km.toFixed(1) : "–"}</span></div>${cells}`;
    })
    .join("");
  // the rails: a thin line through the four graded cells of each row, behind the dots
  return `<div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 0 4px 2px"><span class="x2s mut">km on this route</span><span class="x2s mut">a kilometre counts as</span></div>
  <div class="b-grid"><div class="b-never"></div>${head}${body}</div>
  ${note ? `<div class="note" style="margin-top:10px"><b>Path on like:</b> a kilometre of path counts as 1.15 km. To stay on ways you love, the route may be up to <b>1.35× longer</b> than on ways that are fine, <b>2×</b> than on ways you dislike. <b>Avoid</b> is never: the route goes around, whatever it costs.</div>` : ""}`;
}

/** The equalizer. `trackH`: the height of the slider travel (1 m … 8 m, log). */
function bEq({ w = 358, trackH = 168, sel = 10 } = {}) {
  const L = 28;
  const T = 44;
  const cw = (w - L) / HILLS.length;
  const cx = (i) => L + cw * (i + 0.5);
  const y = (v) => T + (1 - Math.log2(v) / 3) * trackH;
  const base = T + trackH;
  const kmMax = 7.1;
  const grid = [1, 2, 4, 8]
    .map(
      (v) =>
        `<line x1="${L}" x2="${w}" y1="${y(v)}" y2="${y(v)}" stroke="rgb(22 24 22 / ${v === 1 ? 0.3 : 0.1})"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#5f635f">${v} m</text>`,
    )
    .join("");
  const cols = HILLS.map((p, i) => {
    const x = cx(i);
    const bh = Math.min(p.km / kmMax, 1) * 70;
    const bar = `<rect x="${x - 15}" y="${base - bh}" width="30" height="${bh}" rx="3" fill="var(--route-tint)"/>${p.km > kmMax ? `<path d="M${x - 15} ${base - bh + 9}l7.5 -5l7.5 5l7.5 -5l7.5 5" stroke="#fff" stroke-width="2.5" fill="none"/>` : ""}`;
    const foot = `<text x="${x}" y="${base + 20}" text-anchor="middle" font-size="12" font-weight="700" fill="#161816">${gLabel(p.g)}</text>
      <text x="${x}" y="${base + 36}" text-anchor="middle" font-size="11" fill="#5f635f">${p.km.toFixed(1)}</text>`;
    if (p.pinned)
      return `${bar}<rect x="${x - 5}" y="${base - 5}" width="10" height="10" rx="2" fill="#161816"/><text x="${x}" y="${base - 12}" text-anchor="middle" font-size="10.5" fill="#5f635f">fixed</text>${foot}`;
    const on = p.g === sel;
    return `${on ? `<rect x="${x - cw / 2 + 2}" y="${T - 22}" width="${cw - 4}" height="${trackH + 64}" rx="12" fill="rgb(22 24 22 / .06)"/>` : ""}${bar}
      <line x1="${x}" x2="${x}" y1="${T}" y2="${base}" stroke="var(--track)" stroke-width="4" stroke-linecap="round"/>
      <line x1="${x}" x2="${x}" y1="${y(p.v)}" y2="${base}" stroke="#161816" stroke-width="4" stroke-linecap="round"/>
      <circle cx="${x}" cy="${y(p.v)}" r="11" fill="${on ? "#161816" : "#fff"}" stroke="${on ? "#fff" : "#161816"}" stroke-width="${on ? 2 : 2.5}"/>
      <text x="${x}" y="${y(p.v) - 17}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#161816" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">${mLabel(p.v)}</text>${foot}`;
  }).join("");
  const curveLine = HILLS.map((p, i) => `${i ? "L" : "M"}${cx(i)} ${y(p.v)}`).join("");
  const h = base + 44;
  return `<svg width="${w}" height="${h}" style="display:block">
    <text x="${L}" y="11" font-size="11" fill="#5f635f">← downhill</text><text x="${w}" y="11" text-anchor="end" font-size="11" fill="#5f635f">uphill →</text>
    <text x="${(L + w) / 2}" y="11" text-anchor="middle" font-size="11" fill="#5f635f">a metre counts as</text>
    ${grid}<path d="${curveLine}" fill="none" stroke="rgb(22 24 22 / .35)" stroke-width="1.5" stroke-dasharray="3 3"/>${cols}
    <text x="${L - 6}" y="${base + 36}" text-anchor="end" font-size="11" fill="#5f635f">km</text></svg>`;
}

function bHills(opts = {}) {
  const p = HILLS.find((h) => h.g === 10);
  if (opts.compact) return `${presets(1)}<div style="margin-top:10px">${bEq(opts)}</div><div class="hr"></div>${looseRow()}${hillsTotal()}`;
  return `${presets(1)}
  <div style="margin-top:12px">${bEq(opts)}</div>
  <div class="x2s mut" style="display:flex;align-items:center;gap:6px;margin:2px 0 8px 28px"><i class="sw" style="background:var(--route-tint)"></i>this route’s km at each grade</div>
  <div class="note"><b>At 10 % uphill a metre counts as 2.5 m.</b> On this route: ${km(p.km)} around 10 % count as ${km(p.km * p.v)}.</div>
  <div class="hr" style="margin-top:10px"></div>
  ${looseRow()}
  ${hillsTotal()}`;
}

frames("B", {
  surface: { right: bMini(SURFS), sum: "love fine gravel, like gravel · dislike soft ground" },
  ways: { right: bMini(WAYS), sum: "love tracks, cycle paths · never main roads" },
  terrain: {
    right: `<svg width="58" height="18">${HILLS.map((p, i) => `<rect x="${1 + i * 8}" y="${16 - 2 - (Math.log2(p.v) / 3) * 22}" width="5" height="${2 + (Math.log2(p.v) / 3) * 22}" rx="1.5" fill="${p.pinned ? "rgb(22 24 22 / .3)" : "#161816"}"/>`).join("")}</svg>`,
    sum: "Don’t mind · steep from 10 % · loose ground +20 %",
  },
  bodies: { ways: () => bBoard(), terrain: () => bHills() },
});
