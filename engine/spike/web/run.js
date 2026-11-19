// The browser benchmark, shared by the worker and the main thread. cfg: { source: "blob" | "tiles-z10"
// | …, pairs, limit, cells: [[profile, bucket, algo]], spin }
import init, { SpikeEngine } from "/pkg/kompass_wasm.js";

const ms = (t) => Math.round((performance.now() - t) * 10) / 10;

export async function run(cfg, log) {
  const out = { cfg };
  let t = performance.now();
  await init({ module_or_path: "/pkg/kompass_wasm_bg.wasm" });
  out.init_ms = ms(t);
  if (cfg.spin) {
    out.spin_ms = SpikeEngine.spin(cfg.spin);
    return out;
  }
  const eng = new SpikeEngine();
  t = performance.now();
  let bytes = 0;
  if (cfg.source === "blob") {
    const buf = new Uint8Array(await (await fetch("/data/graph.kmpg")).arrayBuffer());
    out.fetch_ms = ms(t);
    bytes = buf.length;
    const t2 = performance.now();
    eng.append(buf);
    out.append_ms = ms(t2);
  } else {
    const dir = `/data/${cfg.source}`;
    const index = await (await fetch(`${dir}/index.json`)).json();
    // fetch all in parallel, append in order as they arrive (one tile copy in wasm memory at a time)
    const pending = index.map((e) => fetch(`${dir}/${e.file}`).then((r) => r.arrayBuffer()));
    out.tiles = pending.length;
    let appendMs = 0;
    for (const p of pending) {
      const b = new Uint8Array(await p);
      bytes += b.length;
      const t3 = performance.now();
      eng.append(b);
      appendMs += performance.now() - t3;
    }
    out.fetch_ms = ms(t);
    out.append_ms = Math.round(appendMs * 10) / 10;
  }
  out.finish_ms = eng.finish();
  out.load_ms = ms(t);
  out.bytes = bytes;
  out.nodes = eng.nodeCount();
  out.memory_after_load = SpikeEngine.memoryBytes();
  log(`loaded ${cfg.source} in ${out.load_ms} ms`);
  out.compile_ms = [0, 0];
  for (const p of [0, 1]) {
    const runs = [0, 1, 2].map(() => eng.compile(p));
    runs.sort((a, b) => a - b);
    out.compile_ms[p] = Math.round(runs[1] * 10) / 10;
  }
  out.memory_after_compile = SpikeEngine.memoryBytes();
  if (cfg.cells?.length) {
    t = performance.now();
    const lm = new Uint8Array(await (await fetch("/data/landmarks8.u16")).arrayBuffer());
    eng.setLandmarks(lm, 8);
    out.landmarks_ms = ms(t);
    out.pairs_ms = Math.round(eng.makePairs(cfg.pairs ?? 100));
    out.cells = [];
    for (const [profile, bucket, algo] of cfg.cells) {
      const stats = JSON.parse(eng.bench(profile, bucket, algo, cfg.limit ?? 0));
      out.cells.push({ profile, bucket, algo, ...stats });
      log(`${profile} ${bucket} ${algo}: p50 ${stats.ms_p50} ms`);
    }
  }
  out.memory = SpikeEngine.memoryBytes();
  return out;
}
