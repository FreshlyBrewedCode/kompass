// Builds the engine for the browser: kompass-wasm → wasm32 → wasm-bindgen glue in web/src/engine/pkg
// (generated, gitignored). wasm-opt (binaryen) shrinks and speeds it up when it is installed (nix dev
// shell); without it the unoptimised module is used. Usage: bun scripts/build-wasm.ts [--dev]
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dirname, "..");
const dev = process.argv.includes("--dev");
const profile = dev ? "debug" : "release";
const out = join(root, "web/src/engine/pkg");
const wasm = join(root, "engine/target/wasm32-unknown-unknown", profile, "kompass_wasm.wasm");

await $`cargo build --locked -p kompass-wasm --target wasm32-unknown-unknown ${dev ? [] : ["--release"]}`.cwd(
  join(root, "engine"),
);
await $`wasm-bindgen --target web --out-dir ${out} ${wasm}`;

const bg = join(out, "kompass_wasm_bg.wasm");
if (!dev && Bun.which("wasm-opt") && existsSync(bg)) {
  // the features rustc enables by default for wasm32-unknown-unknown
  await $`wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-reference-types --enable-multivalue ${bg} -o ${bg}`;
} else if (!dev) {
  console.warn("build-wasm: wasm-opt not found, skipping the optimisation pass");
}
console.log(`build-wasm: ${profile} → ${out} (${Bun.file(bg).size} bytes)`);
