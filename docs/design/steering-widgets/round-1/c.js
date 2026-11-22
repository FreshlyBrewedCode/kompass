// C · Ladder. One ordered list from love down to the "never" line; a row moves a tier up or down (the
// arrows, or its grip). Hills: a preset, tuned with two ordinary sliders; the curve is only a read-out.
/* global I, TIERS, WAYS, HILLS, PTS, km, spark, stepper, looseRow, hillsTotal, frames, aChart */

const C_RATE = {
  love: "the yardstick: 1 km is 1 km",
  like: "1 km counts as 1.15 km",
  fine: "1 km counts as 1.35 km",
  dislike: "1 km counts as 2 km",
};

function cRow(w, t, i, n) {
  const never = t === "avoid";
  const up = t !== "love";
  return `<div class="c-row"><div class="grip">${I("grip-vertical", 16)}</div>${never ? I("lock", 14) : `<i class="sw" style="background:${w.color}"></i>`}
    <div class="n">${w.name}${w.sub ? `<small>${w.sub}</small>` : ""}${w.changed ? ' <i class="dot" style="display:inline-block;vertical-align:middle;margin-left:4px"></i>' : ""}</div>
    <span class="km">${w.km ? km(w.km) : "not on this route"}</span>
    <div class="mv ${never ? "off" : ""}"><i>${I("arrow-down", 16)}</i></div><div class="mv ${up ? "" : "off"}"><i>${I("arrow-up", 16)}</i></div></div>`;
}

function cBoard() {
  const graded = [...TIERS]
    .reverse()
    .filter((t) => t.id !== "avoid")
    .map((t) => {
      const rows = WAYS.filter((w) => w.tier === t.id).sort((a, b) => b.km - a.km);
      return `<div class="c-div"><b class="caps" style="color:var(--foreground)">${t.label}</b><span>${C_RATE[t.id]}</span></div>${rows.map((w, i) => cRow(w, t.id, i, rows.length)).join("")}`;
    })
    .join("");
  const never = WAYS.filter((w) => w.tier === "avoid");
  return `${graded}
  <div class="c-never"><div class="c-div">${I("lock", 12, "align-self:center")}<b class="caps" style="color:var(--foreground)">Never</b><span>the route goes around, whatever it costs</span></div>
  ${never.map((w, i) => cRow(w, "avoid", i, never.length)).join("")}</div>
  <div class="note" style="margin-top:10px">To stay on ways you love, the route may be up to <b>1.35× longer</b> than on ways that are fine, <b>2×</b> than on ways you dislike.</div>`;
}

const C_PRESETS = [
  { n: "Flat please", s: "every climb costs", pts: [[-15, 2.5], [-8, 1.4], [0, 1], [3, 1.5], [6, 2.4], [10, 4.5], [15, 8]] },
  { n: "Don’t mind", s: "only ramps cost", pts: PTS },
  { n: "Climber", s: "climbs welcome", pts: [[-15, 1.3], [-8, 1], [0, 1], [3, 1], [6, 1], [10, 1.3], [15, 2.2]] },
  { n: "No walls", s: "never over 12 %", pts: [[-15, 1.6], [-8, 1], [0, 1], [3, 1], [6, 1.15], [10, 1.6], [15, 8]] },
];

const dial = (label, word, pos, lo, hi) => `
<div class="dial"><div class="top"><b>${label}</b><span class="w">${word}</span></div>
  <div class="bar"><div class="fill" style="width:${pos}%"></div><div class="knob" style="left:${pos}%"></div></div>
  <div class="ends"><span>${lo}</span><span>${hi}</span></div></div>`;

function cHills() {
  return `<div class="c-cards">${C_PRESETS.map((p, i) => `<div class="c-card ${i === 1 ? "on" : ""}">${spark(p.pts, 40, 26, i === 1 ? "#161816" : "#5f635f")}<div><div class="n">${p.n}</div><div class="s">${p.s}</div></div></div>`).join("")}</div>
  <div style="margin-top:10px">${dial("Climbing costs", "a metre at 6 % counts as 1.4 m", 34, "nothing", "a lot")}
  ${dial("Steep begins at", "8 % · a metre at 10 % counts as 2.5 m", 46, "4 %", "14 %")}</div>
  <div style="margin-top:12px">${aChart({ h: 136, interactive: false })}</div>
  <div class="x2s mut" style="margin:2px 0 8px">The curve these two make: read only. 3.6 km of this route are steeper than 6 %, 2.4 km steeper than 8 %.</div>
  <div class="hr"></div>
  ${looseRow()}
  ${hillsTotal()}`;
}

frames("C", {
  surface: { sum: "fine gravel › gravel › paved › soft ground, cobbles" },
  ways: { sum: "tracks › paths › streets › roads · never main roads" },
  terrain: { sum: "Don’t mind · climbing costs a little, steep from 8 %" },
  bodies: { ways: cBoard, terrain: cHills },
});
