// D · Route first. The board is the route's own make-up, biggest share first: select one or more ways,
// then pick the tier in a bar docked at the thumb. Hills use the same rows: one per grade, with a stepper.
/* global I, TIERS, tier, TIER_INK, WAYS, SURFS, HILLS, ROUTE_KM, km, tierKm, gLabel, mLabel, presets, stepper, looseRow, hillsTotal, frames, spark, PTS */

/** The route by tier: full ink is love, the lightest is dislike. */
function dShare(rows, w = 90, h = 8) {
  const total = rows.reduce((s, r) => s + r.km, 0);
  return `<span style="display:flex;width:${w}px;height:${h}px;border-radius:9px;overflow:hidden;gap:1px">${["love", "like", "fine", "dislike"]
    .map((t) => {
      const k = rows.filter((r) => r.tier === t).reduce((s, r) => s + r.km, 0);
      return `<i style="width:${(k / total) * 100}%;background:${TIER_INK[t]}"></i>`;
    })
    .join("")}</span>`;
}

function dPips(t) {
  if (t === "avoid") return `<span style="display:flex;height:5px;align-items:center">${I("lock", 12)}</span>`;
  const n = { dislike: 1, fine: 2, like: 3, love: 4 }[t];
  return `<span class="pips">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
}

function dBoard() {
  const on = WAYS.filter((w) => w.km > 0).sort((a, b) => b.km - a.km);
  const off = WAYS.filter((w) => w.km === 0);
  const row = (w) => `
  <div class="d-row ${w.id === "country" ? "sel" : ""}"><i class="sw" style="background:${w.color}"></i>
    <div class="n"><b>${w.name}${w.sub ? `<small>${w.sub}</small>` : ""}${w.changed ? ' <i class="dot" style="display:inline-block;vertical-align:middle;margin-left:3px"></i>' : ""}</b>
      <div class="d-bar">${w.km ? `<i style="width:${(w.km / 19.4) * 130}px;background:${w.color}"></i>${km(w.km)}` : "not on this route"}</div></div>
    <div class="d-tier">${w.tier === "avoid" ? "never" : tier(w.tier).label.toLowerCase()}${dPips(w.tier)}</div></div>`;
  return `<div style="display:flex;align-items:center;gap:8px;margin:0 8px 6px">${dShare(WAYS, 150, 8)}<span class="x2s mut">${km(tierKm("love"))} loved · ${km(tierKm("dislike"))} disliked</span></div>
  ${on.map(row).join("")}
  <div class="caps" style="margin:8px 8px 2px">Not on this route</div>
  ${off.map(row).join("")}`;
}

function dDock() {
  return `<div class="d-dock">
    <div class="h"><b>Country road</b> · 8.0 km of this route count as 16 km. Tap more ways to move them together.</div>
    <div class="tierbar">${TIERS.map((t) => `<div class="${t.id === "dislike" ? "on" : ""} ${t.id === "avoid" ? "never" : ""}">${t.id === "avoid" ? `<span style="display:flex;gap:3px;align-items:center">${I("lock", 11)}Avoid</span>` : t.label}<small>${t.short}</small></div>`).join("")}</div>
  </div>`;
}

function dHills() {
  const rows = [...HILLS].reverse().map((p) => {
    const head = p.g > 0 && p.g === 15 ? '<div class="caps" style="margin:0 8px 2px">Uphill</div>' : p.g === -8 ? '<div class="caps" style="margin:6px 8px 2px">Downhill</div>' : "";
    return `${head}<div class="d-row d-hill ${p.g === 10 ? "sel" : ""}" style="${p.pinned ? "opacity:.6" : ""}">
      <div class="g"><b>${p.g === 0 ? "Flat" : gLabel(p.g)}</b><span>${p.word}</span></div>
      <div class="on-route"><i style="width:${Math.min(p.km / 7.1, 1) * 100}%"></i>${km(p.km)}${p.v > 1 ? ` → ${km(p.km * p.v)}` : ""}</div>
      ${p.pinned ? `<div class="step"><div class="btn"></div><div class="val">1 m</div><div class="btn"></div></div>` : stepper(mLabel(p.v))}</div>`;
  });
  return `${presets(1)}
  <div style="display:flex;justify-content:space-between;margin:10px 8px 4px" class="x2s mut"><span>grade</span><span>km on this route → count as</span><span>a metre counts as</span></div>
  ${rows.join("")}
  <div class="hr"></div>
  ${looseRow()}
  ${hillsTotal()}`;
}

frames("D", {
  surface: { right: dShare(SURFS), sum: "26.5 of 41.6 km on surfaces you love or like" },
  ways: { right: dShare(WAYS), sum: "23.5 of 41.6 km on ways you love · never main roads" },
  terrain: { right: spark(PTS), sum: "Don’t mind · the hills count as +7.8 km here" },
  bodies: { ways: dBoard, terrain: dHills },
  dock: { ways: dDock },
});
