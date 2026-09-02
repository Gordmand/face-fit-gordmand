// Вклейка заменённого лица обратно в исходное фото.
//   - маска по контуру лица (face-oval MediaPipe) с подъёмом в лоб/линию волос;
//   - растушёвка края;
//   - опциональный подгон тона кожи (mean/std по области стыка);
//   - опциональный эксперимент: сдвиг цвета волос цели к цвету волос источника.

import { invertAffine } from "./align.js";

// Точки контура лица MediaPipe по порядку обхода (сверху от центра лба до подбородка и обратно).
export const FACE_OVAL_IDX = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];

/** Применяет матрицу 2×3 [a,b,tx,c,d,ty] к точке. */
function applyM(M, x, y) {
  return [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]];
}

/**
 * Полигон контура лица в пространстве кропа size×size.
 * @param {Array<{x:number,y:number}>} landmarks нормализованные точки MediaPipe
 * @param {number} imgW ширина исходного изображения (пиксели)
 * @param {number} imgH высота
 * @param {number[]} M матрица «пиксели изображения → кроп» (та же, что делала кроп)
 * @param {{ foreheadLift?: number }} [opts] подъём верхних точек в лоб (доля высоты лица)
 * @returns {[number,number][]}
 */
export function faceOvalPolygon(landmarks, imgW, imgH, M, { foreheadLift = 0 } = {}) {
  const pts = FACE_OVAL_IDX.map((i) => applyM(M, landmarks[i].x * imgW, landmarks[i].y * imgH));

  if (foreheadLift > 0) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const faceH = maxY - minY || 1;
    const zone = faceH * 0.5; // верхняя половина лица
    for (const p of pts) {
      const t = Math.max(0, Math.min(1, (minY + zone - p[1]) / zone)); // 1 у самого верха → 0 к середине
      p[1] -= foreheadLift * faceH * t;
    }
  }
  return pts;
}

/**
 * Маска size×size: белый растушёванный полигон лица на ПРОЗРАЧНОМ фоне.
 * Форма — в alpha (0 вне овала → 255 внутри), чтобы `destination-in` в pasteBack
 * корректно отсекал и растушёвывал. RGB тоже белый→«ничего» — colorMatch читает
 * красный канал как «внутри/снаружи».
 */
export function featherMask(polygon, size, blurPx = 10) {
  const mask = document.createElement("canvas");
  mask.width = mask.height = size;
  const mctx = mask.getContext("2d", { willReadFrequently: true }); // читаем в colorMatch
  mctx.filter = `blur(${blurPx}px)`;
  mctx.fillStyle = "#fff";
  mctx.beginPath();
  mctx.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) mctx.lineTo(polygon[i][0], polygon[i][1]);
  mctx.closePath();
  mctx.fill();
  mctx.filter = "none";
  return mask;
}

/**
 * Подгон цвета: перекрашивает src так, чтобы mean/std по маске совпали с ref.
 * @returns {HTMLCanvasElement} новый кроп
 */
export function colorMatch(srcCanvas, refCanvas, maskCanvas, strength = 0.7) {
  const size = srcCanvas.width;
  const s = srcCanvas.getContext("2d").getImageData(0, 0, size, size);
  const r = refCanvas.getContext("2d").getImageData(0, 0, size, size);
  const m = maskCanvas.getContext("2d").getImageData(0, 0, size, size);

  const stat = (img) => {
    const sum = [0, 0, 0];
    const sq = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < size * size; i++) {
      if (m.data[i * 4] < 128) continue;
      n++;
      for (let ch = 0; ch < 3; ch++) {
        const v = img.data[i * 4 + ch];
        sum[ch] += v;
        sq[ch] += v * v;
      }
    }
    if (!n) return null;
    const mean = sum.map((x) => x / n);
    const std = sq.map((x, ch) => Math.sqrt(Math.max(1, x / n - mean[ch] * mean[ch])));
    return { mean, std };
  };

  const ss = stat(s);
  const rr = stat(r);
  if (!ss || !rr) return srcCanvas;

  const out = new ImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const p = s.data[i * 4 + ch];
      let q = rr.mean[ch] + (p - ss.mean[ch]) * (rr.std[ch] / ss.std[ch]);
      q = strength * q + (1 - strength) * p;
      out.data[i * 4 + ch] = q < 0 ? 0 : q > 255 ? 255 : q;
    }
    out.data[i * 4 + 3] = 255;
  }
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d").putImageData(out, 0, 0);
  return c;
}

/**
 * Вклейка кропа лица обратно в полное изображение через маску.
 * @param {CanvasImageSource} targetBitmap
 * @param {HTMLCanvasElement} swapCrop лицо size×size
 * @param {number[]} M матрица «пиксели изображения → кроп»
 * @param {HTMLCanvasElement} maskCrop маска size×size
 * @returns {HTMLCanvasElement} результат в размере targetBitmap
 */
export function pasteBack(targetBitmap, swapCrop, M, maskCrop) {
  const size = swapCrop.width;
  const w = targetBitmap.width;
  const h = targetBitmap.height;

  const masked = document.createElement("canvas");
  masked.width = masked.height = size;
  const mctx = masked.getContext("2d");
  mctx.drawImage(swapCrop, 0, 0);
  mctx.globalCompositeOperation = "destination-in";
  mctx.drawImage(maskCrop, 0, 0);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  // out потом читают (повторный кроп для превью)
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(targetBitmap, 0, 0);

  const inv = invertAffine(M); // кроп → пиксели изображения
  ctx.setTransform(inv[0], inv[3], inv[1], inv[4], inv[2], inv[5]);
  ctx.drawImage(masked, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}
