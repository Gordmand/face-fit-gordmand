// После vite build: Vite сам подхватывает `new URL("ort-wasm-simd-threaded.asyncify.wasm", ...)`
// внутри onnxruntime-web и копирует его в dist/assets/ — но рантайм всегда берёт файл из
// dist/ort/ (см. ort.js: wasmPaths указывает туда), так что копия в assets/ никогда не
// запрашивается и просто занимает ~25 МБ впустую.

import { readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = resolve(root, "dist/assets");

const files = await readdir(assetsDir).catch(() => []);
const dead = files.filter((f) => /^ort-wasm-simd-threaded\.asyncify.*\.wasm$/.test(f));

for (const f of dead) {
  const full = resolve(assetsDir, f);
  const { size } = await stat(full);
  await rm(full);
  console.log(`✓ удалён неиспользуемый дубликат dist/assets/${f} (${(size / 1e6).toFixed(1)} МБ)`);
}

if (dead.length === 0) {
  console.log("postbuild: дубликат ort-wasm в dist/assets/ не найден (уже чисто).");
}
