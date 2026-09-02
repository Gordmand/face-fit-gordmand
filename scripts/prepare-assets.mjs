// Готовит статические ассеты, которые нельзя грузить с CDN в MV3.
// Запуск: npm run setup
//   1. WASM-рантайм MediaPipe        node_modules -> public/wasm/
//   2. Модель face_landmarker.task   скачивание   -> public/models/
//   3. WASM-рантайм ONNX Runtime     node_modules -> public/ort/
//   4. Модели ONNX (ArcFace, inswapper) скачивание -> public/models/
//   5. Матрица emap из inswapper     извлечение   -> public/models/inswapper_emap.bin
//
// Большие .onnx (сотни МБ) не коммитятся в git — только генерируются этим скриптом.

import { createWriteStream } from "node:fs";
import { mkdir, cp, stat, copyFile, readFile, writeFile, readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => resolve(root, ...s);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const mb = (n) => (n / 1e6).toFixed(1) + " МБ";

async function download(url, dest, label) {
  await mkdir(dirname(dest), { recursive: true });
  if (await exists(dest)) {
    const { size } = await stat(dest);
    console.log(`✓ ${label}: уже на месте (${mb(size)}), пропускаю`);
    return;
  }
  console.log(`… качаю ${label}: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании ${label}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const { size } = await stat(dest);
  console.log(`✓ ${label} → ${dest.replace(root + "\\", "").replace(/\\/g, "/")} (${mb(size)})`);
}

// --- 1. MediaPipe wasm ---
async function mediapipeWasm() {
  const src = p("node_modules/@mediapipe/tasks-vision/wasm");
  if (!(await exists(src))) throw new Error(`Не найден ${src}. Сначала: npm install`);
  await mkdir(p("public/wasm"), { recursive: true });
  await cp(src, p("public/wasm"), { recursive: true });
  console.log("✓ WASM-рантайм MediaPipe → public/wasm/");
}

// --- 3. ONNX Runtime wasm ---
async function ortWasm() {
  const dir = p("node_modules/onnxruntime-web/dist");
  if (!(await exists(dir))) throw new Error(`Не найден ${dir}. Сначала: npm install`);
  await mkdir(p("public/ort"), { recursive: true });
  // Все варианты рантайма ort-wasm-simd-threaded.* (base / jsep / jspi / asyncify).
  // Разные бэкенды подтягивают разные — на этапе 7 оставим только нужные.
  const files = (await readdir(dir)).filter(
    (f) => /^ort-wasm-simd-threaded(\.\w+)?\.(wasm|mjs)$/.test(f),
  );
  for (const f of files) {
    await copyFile(resolve(dir, f), p("public/ort", f));
  }
  console.log(`✓ WASM-рантайм ONNX Runtime → public/ort/ (${files.length} файлов)`);
}

// --- модели ---
const MODELS = {
  faceLandmarker: {
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    dest: p("public/models/face_landmarker.task"),
    label: "модель face_landmarker.task",
  },
  arcface: {
    url: "https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx",
    dest: p("public/models/w600k_r50.onnx"),
    label: "модель ArcFace (w600k_r50, ~166 МБ)",
  },
  inswapper: {
    url: "https://huggingface.co/hacksider/deep-live-cam/resolve/main/inswapper_128_fp16.onnx",
    dest: p("public/models/inswapper_128_fp16.onnx"),
    label: "модель inswapper (fp16, ~265 МБ)",
  },
};

// --- 5. Извлечение матрицы emap из inswapper ---
//
// inswapper_128 не принимает эмбеддинг ArcFace напрямую: сначала его нужно умножить
// на матрицу emap (512×512), зашитую в onnx как инициализатор с именем "emap"
// (см. INSwapper.get в InsightFace). ORT Web не отдаёт инициализаторы, поэтому
// достаём emap здесь — минимальным разбором protobuf — и кладём рядом сырым Float32.

const EMAP_DEST = p("public/models/inswapper_emap.bin");

// Итератор полей protobuf в диапазоне [start, end).
function* pbFields(buf, start, end) {
  let i = start;
  while (i < end) {
    let tag = 0;
    let shift = 0;
    while (true) {
      const b = buf[i++];
      tag += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let v = 0;
      let s = 0;
      while (true) {
        const b = buf[i++];
        v += (b & 0x7f) * 2 ** s;
        if ((b & 0x80) === 0) break;
        s += 7;
      }
      yield { field, wire, value: v };
    } else if (wire === 2) {
      let len = 0;
      let s = 0;
      while (true) {
        const b = buf[i++];
        len += (b & 0x7f) * 2 ** s;
        if ((b & 0x80) === 0) break;
        s += 7;
      }
      yield { field, wire, start: i, end: i + len };
      i += len;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error(`protobuf: неизвестный wire-тип ${wire}`);
    }
  }
}

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

async function extractEmap() {
  if (await exists(EMAP_DEST)) {
    const { size } = await stat(EMAP_DEST);
    console.log(`✓ emap: уже на месте (${(size / 1024).toFixed(0)} КБ), пропускаю`);
    return;
  }
  console.log("… извлекаю emap из inswapper …");
  const buf = await readFile(MODELS.inswapper.dest);

  // ModelProto.graph (поле 7) -> GraphProto.initializer (поле 5) -> TensorProto
  let graph = null;
  for (const f of pbFields(buf, 0, buf.length)) {
    if (f.field === 7 && f.wire === 2) graph = f;
  }
  if (!graph) throw new Error("emap: не найден graph в onnx");

  for (const init of pbFields(buf, graph.start, graph.end)) {
    if (init.field !== 5 || init.wire !== 2) continue;
    let name = null;
    let dataType = null;
    let rawData = null;
    let floatData = null;
    const dims = [];
    for (const t of pbFields(buf, init.start, init.end)) {
      if (t.field === 1 && t.wire === 0) dims.push(t.value);
      else if (t.field === 2 && t.wire === 0) dataType = t.value;
      else if (t.field === 4 && t.wire === 2) floatData = t; // packed float
      else if (t.field === 8 && t.wire === 2) name = buf.toString("utf8", t.start, t.end);
      else if (t.field === 9 && t.wire === 2) rawData = t; // bytes
    }
    // emap: в fp32-модели зовётся "emap", в fp16-конвертации — "initializer".
    // Надёжный признак — единственный инициализатор формы 512×512.
    const isEmap = name === "emap" || (dims.length === 2 && dims[0] === 512 && dims[1] === 512);
    if (!isEmap) continue;

    const count = dims.reduce((a, b) => a * b, 1) || 512 * 512;
    const out = new Float32Array(count);
    if (rawData) {
      const dv = new DataView(buf.buffer, buf.byteOffset + rawData.start, rawData.end - rawData.start);
      if (dataType === 10) {
        for (let k = 0; k < count; k++) out[k] = halfToFloat(dv.getUint16(k * 2, true));
      } else {
        for (let k = 0; k < count; k++) out[k] = dv.getFloat32(k * 4, true);
      }
    } else if (floatData) {
      const dv = new DataView(buf.buffer, buf.byteOffset + floatData.start, floatData.end - floatData.start);
      for (let k = 0; k < count; k++) out[k] = dv.getFloat32(k * 4, true);
    } else {
      throw new Error("emap: у тензора нет ни raw_data, ни float_data");
    }

    let sum = 0;
    for (const v of out) sum += v;
    await writeFile(EMAP_DEST, Buffer.from(out.buffer));
    console.log(
      `✓ emap → public/models/inswapper_emap.bin  [${dims.join("×")}], ` +
        `dtype ${dataType}, сумма ${sum.toFixed(3)}`,
    );
    return;
  }
  throw new Error('emap: инициализатор с именем "emap" не найден');
}

await mediapipeWasm();
await ortWasm();
for (const m of Object.values(MODELS)) {
  await download(m.url, m.dest, m.label);
}
await extractEmap();
console.log("Готово.");
