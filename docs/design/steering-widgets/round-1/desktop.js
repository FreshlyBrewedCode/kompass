// The favourite (B · Matrix) on the desk: the same parts in the profile card, with pointer-sized rows.
/* global I, mapSvg, topbar, group, panel, bBoard, bHills, bMini, WAYS, SURFS, HILLS */
window.FRAMES["fav-desktop"] = () => {
  const dir = {
    surface: { right: bMini(SURFS), sum: "love fine gravel, like gravel · dislike soft ground" },
    ways: { right: bMini(WAYS), sum: "love tracks, cycle paths · never main roads" },
    terrain: { sum: "Don’t mind · steep from 10 % · loose ground +20 %" },
    bodies: { ways: () => bBoard(WAYS, { note: false }), terrain: () => bHills({ w: 372, trackH: 90, compact: true }) },
  };
  const two = ["ways", "terrain"];
  const widgets = {
    surface: { icon: "grid-3x3", label: "Surface", ...dir.surface },
    ways: { icon: "route", label: "Way type", changed: true, ...dir.ways },
    traffic: { icon: "car", label: "Traffic", count: 1, sum: "loves quiet" },
    terrain: { icon: "mountain", label: "Terrain", ...dir.terrain },
  };
  const list = ["surface", "ways", "terrain"]
    .map((id) => group({ ...widgets[id], open: two.includes(id), body: two.includes(id) ? dir.bodies[id]() : "" }))
    .join("");
  const lane = (parts) => `<div class="lane">${parts.map(([c, k]) => `<i style="width:${(k / 41.6) * 100}%;background:${c}"></i>`).join("")}</div>`;
  return `<div class="desk">${mapSvg(1440, 900, "-60 20 600 375")}
  <div class="topbar" style="right:436px"><div class="pill round">${I("compass", 20)}</div><div class="pill later">Ride mode</div><div class="pill" style="margin-left:auto">${I("eye", 18)}${I("layers", 18)}</div></div>
  <div class="card left">
    <div class="caps">Route</div>
    <div class="stats" style="height:44px"><span><b style="font-size:24px">41.6</b><small>km</small></span><span><b style="font-size:24px">620</b><small>m ↑</small></span><span><b style="font-size:24px">2:48</b><small>h</small></span></div>
    <div class="x2s mut" style="margin-top:8px">Surface</div>${lane(SURFS.map((s) => [s.color, s.km]))}
    <div class="x2s mut">Way type</div>${lane(WAYS.filter((w) => w.km).map((w) => [w.color, w.km]))}
  </div>
  <div class="card right">
    <div class="base" style="margin-top:0"><div class="l1">Gravel explorer ${I("chevron-down", 16)} <i class="dot"></i><span>1 change</span></div><div class="xs mut">Tracks, forest edges, something new · but paths a tier up</div></div>
    ${list}
  </div></div>`;
};
