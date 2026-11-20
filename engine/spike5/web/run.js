// Spike #5 browser bench, shared by the worker and the main thread. cfg: { geometry, tracks: [id…],
// repeat, spin }. Loads the region graph from /data/manifest.json (+ geometry), builds the grid, matches
// the tracks served at /pts/<id>.bin (interleaved f64 lng, lat).
import init, { MatchEngine } from "/pkg/kompass_wasm.js";

const ms = (t) => Math.round((performance.now() - t) * 10) / 10;

export async function run(cfg, log) {
  const out = { cfg };
  let t = performance.now();
  await init({ module_or_path: "/pkg/kompass_wasm_bg.wasm" });
  out.init_ms = ms(t);
  if (cfg.spin) {
    out.spin_ms = MatchEngine.spin(cfg.spin);
    return out;
  }
  t = performance.now();
  const manifest = await (await fetch("/data/manifest.json")).json();
  const g = manifest.graph;
  const get = (f) => fetch(`/data/${f}`).then((r) => r.arrayBuffer());
  const eng = new MatchEngine(new Uint8Array(await get(g.index.file)));
  const tiles = g.tiles.map((x) => get(x.graph.file));
  const geos = cfg.geometry ? g.tiles.map((x) => get(x.geometry.file)) : [];
  let addMs = 0;
  for (const p of tiles) {
    const b = new Uint8Array(await p);
    const t2 = performance.now();
    eng.addTile(b);
    addMs += performance.now() - t2;
  }
  out.finish_ms = eng.finish();
  for (const p of geos) {
    const b = new Uint8Array(await p);
    const t2 = performance.now();
    eng.addGeometry(b);
    addMs += performance.now() - t2;
  }
  out.add_ms = Math.round(addMs);
  out.load_ms = ms(t);
  out.memory_after_load = MatchEngine.memoryBytes();
  out.prepare_ms = Math.round(eng.prepare(0, 0, 0, 0));
  out.memory_after_prepare = MatchEngine.memoryBytes();
  log(`loaded in ${out.load_ms} ms, grid+matcher ${out.prepare_ms} ms`);
  out.tracks = [];
  for (const id of cfg.tracks ?? []) {
    const pts = new Float64Array(await (await fetch(`/pts/${id}.bin`)).arrayBuffer());
    const runs = [];
    for (let i = 0; i < (cfg.repeat ?? 1); i++) runs.push(JSON.parse(eng.matchTrack(pts)));
    const best = runs.reduce((a, b) => (a.ms <= b.ms ? a : b));
    out.tracks.push({ ...best, first_ms: runs[0].ms });
  }
  const km = out.tracks.reduce((s, x) => s + x.track_m, 0) / 1e3;
  const total = out.tracks.reduce((s, x) => s + x.ms, 0);
  out.total_ms = Math.round(total);
  out.km = Math.round(km);
  out.ms_per_100km = Math.round((total / km) * 100 * 10) / 10;
  out.memory = MatchEngine.memoryBytes();
  log(`matched ${out.tracks.length} tracks, ${out.km} km in ${out.total_ms} ms`);
  return out;
}
