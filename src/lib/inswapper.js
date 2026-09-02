// inswapper_128: выровненный кроп цели 128×128 + латент лица-источника → лицо 128×128.
// Предобработка как в InsightFace INSwapper: RGB, NCHW, px/255.

import { createSession, ort } from "./ort.js";
import { assetUrl } from "./assetUrl.js";
import { l2normalize } from "./arcface.js";

const MODEL_PATH = "models/inswapper_128_fp16.onnx";
const EMAP_PATH = "models/inswapper_emap.bin";
const SIZE = 128;
const DIM = 512;

let sessionPromise = null;
let emapPromise = null;

export function loadInswapper() {
  if (!sessionPromise) sessionPromise = createSession(MODEL_PATH);
  return sessionPromise;
}

function loadEmap() {
  if (!emapPromise) {
    emapPromise = fetch(assetUrl(EMAP_PATH))
      .then((r) => {
        if (!r.ok) throw new Error(`emap: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => new Float32Array(buf)); // 512×512, row-major
  }
  return emapPromise;
}

/**
 * Латент для входа "source": normed_embedding · emap, затем L2-норма.
 * @param {Float32Array} embedding сырой эмбеддинг ArcFace (512)
 * @param {Float32Array} emap 512×512 row-major
 * @returns {Float32Array} (512)
 */
export function computeLatent(embedding, emap) {
  const normed = l2normalize(embedding);
  const latent = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    const e = normed[i];
    if (e === 0) continue;
    const row = i * DIM;
    for (let j = 0; j < DIM; j++) latent[j] += e * emap[row + j];
  }
  return l2normalize(latent);
}

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} targetCrop128 выровненный кроп цели 128×128
 * @param {Float32Array} sourceEmbedding сырой эмбеддинг ArcFace лица-источника (512)
 * @returns {Promise<HTMLCanvasElement>} лицо 128×128 (RGB)
 */
export async function swapFace(targetCrop128, sourceEmbedding) {
  const [session, emap] = await Promise.all([loadInswapper(), loadEmap()]);

  const { data } = targetCrop128.getContext("2d").getImageData(0, 0, SIZE, SIZE);
  const area = SIZE * SIZE;
  const chw = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    chw[i] = data[i * 4] / 255; // R
    chw[area + i] = data[i * 4 + 1] / 255; // G
    chw[2 * area + i] = data[i * 4 + 2] / 255; // B
  }

  const target = new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
  const source = new ort.Tensor("float32", computeLatent(sourceEmbedding, emap), [1, DIM]);

  const feeds = {};
  for (const name of session.inputNames) {
    feeds[name] = name.toLowerCase().includes("target") ? target : source;
  }
  const out = await session.run(feeds);
  const pred = out[session.outputNames[0]].data; // [1,3,128,128], ~[0,1]

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const outCtx = canvas.getContext("2d", { willReadFrequently: true }); // читаем в colorMatch
  const img = new ImageData(SIZE, SIZE);
  for (let i = 0; i < area; i++) {
    img.data[i * 4] = clamp255(pred[i] * 255);
    img.data[i * 4 + 1] = clamp255(pred[area + i] * 255);
    img.data[i * 4 + 2] = clamp255(pred[2 * area + i] * 255);
    img.data[i * 4 + 3] = 255;
  }
  outCtx.putImageData(img, 0, 0);
  return canvas;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
