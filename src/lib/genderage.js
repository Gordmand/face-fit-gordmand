// genderage (InsightFace buffalo_l): классификация пола/возраста по кропу лица.
// Предобработка как в InsightFace Attribute: квадратный кроп вокруг bbox лица
// (сторона = max(w,h) × 1.5, центр = центр bbox), 96×96, RGB, NCHW, без нормализации
// (scale=1.0, mean=0 — сырые значения пикселя 0..255).

import { createSession, ort } from "./ort.js";

const MODEL_PATH = "models/genderage.onnx";
const SIZE = 96;
const MARGIN = 1.5;

let sessionPromise = null;

export function loadGenderAge() {
  if (!sessionPromise) sessionPromise = createSession(MODEL_PATH);
  return sessionPromise;
}

/**
 * Квадратный кроп вокруг bbox лица (в пикселях кадра), центрированный, с запасом.
 * @param {{x:number,y:number,w:number,h:number}} bboxPx
 */
export function genderCropRect({ x, y, w, h }, margin = MARGIN) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const size = Math.max(w, h) * margin;
  return { sx: cx - size / 2, sy: cy - size / 2, size };
}

/**
 * Разбор выхода модели (3 числа: female-логит, male-логит, возраст/100).
 * Уверенность — softmax по двум логитам пола (сама модель argmax не калибрует).
 */
export function readGenderAge(pred) {
  const [f, m, a] = pred;
  const maxV = Math.max(f, m);
  const ef = Math.exp(f - maxV);
  const em = Math.exp(m - maxV);
  const pf = ef / (ef + em);
  const pm = em / (ef + em);
  return {
    gender: f > m ? "female" : "male",
    genderConf: Math.max(pf, pm),
    age: Math.round(a * 100),
  };
}

/**
 * @param {CanvasImageSource} bitmap полный кадр
 * @param {{x:number,y:number,w:number,h:number}} bboxPx bbox лица в пикселях кадра
 * @returns {Promise<{gender:"female"|"male", genderConf:number, age:number}>}
 */
export async function classifyGender(bitmap, bboxPx) {
  const session = await loadGenderAge();
  const { sx, sy, size } = genderCropRect(bboxPx);

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  const area = SIZE * SIZE;
  const chw = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    chw[i] = data[i * 4]; // R
    chw[area + i] = data[i * 4 + 1]; // G
    chw[2 * area + i] = data[i * 4 + 2]; // B
  }

  const input = new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
  const out = await session.run({ [session.inputNames[0]]: input });
  return readGenderAge(out[session.outputNames[0]].data);
}
