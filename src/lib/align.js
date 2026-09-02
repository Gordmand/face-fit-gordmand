// Выравнивание лица по 5 опорным точкам к каноническому шаблону InsightFace.
// Используется преобразование подобия (масштаб + поворот + сдвиг, без отражения) —
// то же, что trans.SimilarityTransform в InsightFace face_align.py.

// Канонические 5 точек для 112×112 (arcface_dst).
// Порядок: [глаз слева на картинке, глаз справа, нос, угол рта слева, угол рта справа].
export const ARCFACE_DST_112 = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Шаблон 5 точек для нужного выходного размера.
 * Как в InsightFace: для размеров, кратных 112 — просто масштаб;
 * кратных 128 — масштаб + сдвиг по X на 8·ratio (режим 'arcface' у 128-кропа).
 */
export function alignTemplate(size) {
  if (size % 112 === 0) {
    const r = size / 112;
    return ARCFACE_DST_112.map(([x, y]) => [x * r, y * r]);
  }
  if (size % 128 === 0) {
    const r = size / 128;
    const dx = 8 * r;
    return ARCFACE_DST_112.map(([x, y]) => [x * r + dx, y * r]);
  }
  throw new Error(`alignTemplate: размер ${size} должен быть кратен 112 или 128`);
}

/**
 * Оценка преобразования подобия по методу наименьших квадратов (замкнутая форма).
 * Ищет a, b, tx, ty такие, что:  u = a·x − b·y + tx,   v = b·x + a·y + ty.
 * @param {[number,number][]} src исходные точки (пиксели изображения)
 * @param {[number,number][]} dst целевые точки (пиксели шаблона)
 * @returns {number[]} матрица 2×3 [a, −b, tx, b, a, ty]
 */
export function estimateSimilarity(src, dst) {
  const n = src.length;
  let Sx = 0, Sy = 0, Su = 0, Sv = 0, Sxx = 0, Sxu = 0, Sxv = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0], y = src[i][1];
    const u = dst[i][0], v = dst[i][1];
    Sx += x; Sy += y; Su += u; Sv += v;
    Sxx += x * x + y * y;
    Sxu += x * u + y * v;
    Sxv += x * v - y * u;
  }
  const mx = Sx / n, my = Sy / n, mu = Su / n, mv = Sv / n;
  const c = Sxx - Sx * mx - Sy * my; // Σ((x−mx)² + (y−my)²)
  if (Math.abs(c) < 1e-12) throw new Error("estimateSimilarity: вырожденный набор точек");

  const a = (Sxu - Sx * mu - Sy * mv) / c;
  const b = (Sxv + Sy * mu - Sx * mv) / c;
  const tx = mu - mx * a + my * b;
  const ty = mv - my * a - mx * b;
  return [a, -b, tx, b, a, ty];
}

/** Преобразование подобия «5 точек лица → шаблон size×size». */
export function estimateNorm(kps, size) {
  return estimateSimilarity(kps, alignTemplate(size));
}

/** Инверсия матрицы 2×3 [a,b,tx,c,d,ty]. */
export function invertAffine([a, b, tx, c, d, ty]) {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error("invertAffine: вырожденная матрица");
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

/**
 * Рисует source, применяя матрицу M (src → выход), в новый canvas outW×outH.
 * @param {CanvasImageSource} source
 * @param {number[]} M 2×3 [a,b,tx,c,d,ty]
 */
export function warpToCanvas(source, M, outW, outH) {
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  // кроп почти всегда потом читают через getImageData
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const [a, b, tx, c, d, ty] = M;
  // canvas.setTransform(m11, m12, m21, m22, dx, dy): x' = m11·x + m21·y + dx
  ctx.setTransform(a, c, b, d, tx, ty);
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
