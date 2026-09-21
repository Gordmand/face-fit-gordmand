// Стенд face swap. Этап 4e: вклейка лица обратно + маска в лоб + подгон цвета кожи.

import { createFaceLandmarker, insightFaceKps, detectFace } from "../lib/faceLandmarker.js";
import { estimateNorm, warpToCanvas } from "../lib/align.js";
import { embed } from "../lib/arcface.js";
import { swapFace } from "../lib/inswapper.js";
import { faceOvalPolygon, featherMask, colorMatch, pasteBack } from "../lib/blend.js";
import { hasWebGPU } from "../lib/ort.js";

const el = (id) => document.getElementById(id);
const logEl = el("log");
let logLines = [];
const log = (m) => {
  logLines.push(m);
  logEl.textContent = logLines.join("\n");
};

const optForehead = el("opt-forehead");
const optSkin = el("opt-skin");

const S = {
  sourceEmbedding: null,
  tgtBitmap: null,
  tgtLm: null,
  tgtCrop128: null,
  M128: null,
  swap128: null, // кешированный результат inswapper
};

let landmarkerPromise = null;
const getLandmarker = () => {
  if (!landmarkerPromise) {
    landmarkerPromise = createFaceLandmarker({ numFaces: 1 }).then((r) => r.landmarker);
  }
  return landmarkerPromise;
};

// Источник — строго одно лицо (портрет пользователя).
async function detectSource(file) {
  const landmarker = await getLandmarker();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const faces = landmarker.detect(bitmap).faceLandmarks ?? [];
  if (faces.length !== 1) {
    bitmap.close?.();
    throw new Error(`ожидалось 1 лицо, найдено ${faces.length}`);
  }
  return { bitmap, landmarks: faces[0] };
}

// Цель — как в проде: с запасными проходами по частям кадра (полный рост / сидя).
async function detectTarget(file) {
  const landmarker = await getLandmarker();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const lm = detectFace(landmarker, bitmap);
  if (!lm) {
    bitmap.close?.();
    throw new Error("лицо не найдено");
  }
  return { bitmap, landmarks: lm };
}

el("src").addEventListener("change", async () => {
  const file = el("src").files?.[0];
  if (!file) return;
  logLines = [];
  log("Источник: детекция + эмбеддинг…");
  try {
    const { bitmap, landmarks } = await detectSource(file);
    drawScaled(el("srcThumb"), bitmap);
    const kps = insightFaceKps(landmarks, bitmap.width, bitmap.height);
    const crop = warpToCanvas(bitmap, estimateNorm(kps, 112), 112, 112);
    bitmap.close?.();
    const t0 = performance.now();
    S.sourceEmbedding = await embed(crop);
    log(`Источник готов (эмбеддинг ${(performance.now() - t0).toFixed(0)} мс).`);
    await runSwap();
  } catch (err) {
    console.error(err);
    log(`Источник — ошибка: ${err.message}`);
  }
});

el("tgt").addEventListener("change", async () => {
  const file = el("tgt").files?.[0];
  if (!file) return;
  log("Цель: детекция + выравнивание…");
  try {
    const { bitmap, landmarks } = await detectTarget(file);
    S.tgtBitmap = bitmap;
    S.tgtLm = landmarks;
    const kps = insightFaceKps(landmarks, bitmap.width, bitmap.height);
    S.M128 = estimateNorm(kps, 128);
    S.tgtCrop128 = warpToCanvas(bitmap, S.M128, 128, 128);
    drawScaled(el("orig"), bitmap);
    await runSwap();
  } catch (err) {
    console.error(err);
    log(`Цель — ошибка: ${err.message}`);
  }
});

for (const cb of [optForehead, optSkin]) {
  cb.addEventListener("change", render);
}

let backendLogged = false;

async function runSwap() {
  if (!S.sourceEmbedding || !S.tgtCrop128) return;
  if (!backendLogged) {
    log(`Бэкенд: WebGPU ${hasWebGPU() ? "доступен" : "недоступен → wasm"}`);
    backendLogged = true;
  }
  log("Своп (inswapper)…");
  try {
    const t0 = performance.now();
    S.swap128 = await swapFace(S.tgtCrop128, S.sourceEmbedding);
    log(`Своп готов за ${(performance.now() - t0).toFixed(0)} мс.`);
    render();
  } catch (err) {
    console.error(err);
    log(`Своп — ошибка: ${err.message}`);
  }
}

function render() {
  if (!S.swap128 || !S.tgtBitmap) return;

  const polygon = faceOvalPolygon(S.tgtLm, S.tgtBitmap.width, S.tgtBitmap.height, S.M128, {
    foreheadLift: optForehead.checked ? 0.28 : 0,
  });
  const mask = featherMask(polygon, 128, 10);

  let face = S.swap128;
  if (optSkin.checked) face = colorMatch(S.swap128, S.tgtCrop128, mask, 0.7);

  const out = pasteBack(S.tgtBitmap, face, S.M128, mask);

  drawScaled(el("result"), out);
  const crop = warpToCanvas(out, S.M128, 128, 128);
  el("resultCrop").getContext("2d").drawImage(crop, 0, 0);
}

function drawScaled(canvas, source) {
  const max = 240;
  const s = Math.min(max / source.width, max / source.height, 1);
  canvas.width = Math.round(source.width * s);
  canvas.height = Math.round(source.height * s);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
}
