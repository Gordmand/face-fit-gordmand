// ArcFace (w600k_r50): выровненный кроп лица 112×112 → эмбеддинг длины 512.
// Предобработка как в InsightFace ArcFaceONNX: RGB, NCHW, (px − 127.5) / 127.5.

import { createSession, ort } from "./ort.js";

const MODEL_PATH = "models/w600k_r50.onnx";
const SIZE = 112;

let sessionPromise = null;

export function loadArcFace() {
  if (!sessionPromise) sessionPromise = createSession(MODEL_PATH);
  return sessionPromise;
}

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} crop112 выровненный кроп 112×112
 * @returns {Promise<Float32Array>} сырой эмбеддинг (512)
 */
export async function embed(crop112) {
  const session = await loadArcFace();
  const { data } = crop112.getContext("2d").getImageData(0, 0, SIZE, SIZE);

  const area = SIZE * SIZE;
  const chw = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    chw[i] = (data[i * 4] - 127.5) / 127.5; // R
    chw[area + i] = (data[i * 4 + 1] - 127.5) / 127.5; // G
    chw[2 * area + i] = (data[i * 4 + 2] - 127.5) / 127.5; // B
  }

  const input = new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
  const out = await session.run({ [session.inputNames[0]]: input });
  return out[session.outputNames[0]].data;
}

/** L2-нормализация вектора. */
export function l2normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Косинусная близость двух векторов. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
