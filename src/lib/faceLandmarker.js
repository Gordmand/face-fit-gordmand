// Обёртка над MediaPipe Face Landmarker.
// Все ассеты (wasm + модель) — локальные, внутри пакета расширения (требование MV3).

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import { assetUrl } from "./assetUrl.js";

const WASM_DIR = "wasm"; // public/wasm/ -> корень пакета
const MODEL_PATH = "models/face_landmarker.task"; // public/models/

/**
 * Создаёт FaceLandmarker. Пытается на GPU, при неудаче — на CPU.
 * @param {{ numFaces?: number }} [opts]
 * @returns {Promise<{ landmarker: FaceLandmarker, delegate: "GPU" | "CPU" }>}
 */
export async function createFaceLandmarker({ numFaces = 5 } = {}) {
  const fileset = await FilesetResolver.forVisionTasks(assetUrl(WASM_DIR));

  const baseOptions = {
    modelAssetPath: assetUrl(MODEL_PATH),
    delegate: "GPU",
  };
  const options = {
    baseOptions,
    runningMode: "IMAGE",
    numFaces,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  };

  try {
    const landmarker = await FaceLandmarker.createFromOptions(fileset, options);
    return { landmarker, delegate: "GPU" };
  } catch (err) {
    console.warn("[face-fit] GPU-делегат недоступен, откат на CPU:", err);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...baseOptions, delegate: "CPU" },
    });
    return { landmarker, delegate: "CPU" };
  }
}

/**
 * Пять опорных точек лица (внешние углы глаз, кончик носа, углы рта)
 * из 468-точечной сетки MediaPipe — понадобятся для выравнивания на этапе 4.
 */
export const FIVE_POINT_INDICES = {
  rightEye: 33,
  leftEye: 263,
  nose: 1,
  mouthRight: 61,
  mouthLeft: 291,
};

/** Достаёт 5 опорных точек (в нормализованных координатах 0..1) из одного набора landmarks. */
export function fivePoints(faceLandmarks) {
  return Object.fromEntries(
    Object.entries(FIVE_POINT_INDICES).map(([name, i]) => [
      name,
      { x: faceLandmarks[i].x, y: faceLandmarks[i].y },
    ]),
  );
}

// Группы точек контура глаза в сетке MediaPipe (внешний/внутренний угол, верх, низ).
const RIGHT_EYE_RING = [33, 133, 159, 145];
const LEFT_EYE_RING = [263, 362, 386, 374];
const RIGHT_IRIS_CENTER = 468;
const LEFT_IRIS_CENTER = 473;
const NOSE_TIP = 1;
const MOUTH_CORNER_A = 61;
const MOUTH_CORNER_B = 291;

function meanPoint(lm, indices) {
  let x = 0;
  let y = 0;
  for (const i of indices) {
    x += lm[i].x;
    y += lm[i].y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

/**
 * 5 опорных точек в порядке и семантике InsightFace:
 * [глаз слева на картинке, глаз справа, нос, угол рта слева, угол рта справа].
 * Центры глаз берём из зрачка (радужки), если модель их отдаёт (478 точек),
 * иначе усредняем контур глаза. Лево/право определяем по координате X —
 * это устойчиво к развороту лица.
 * @returns {[number,number][]} 5 точек [x, y] в ПИКСЕЛЯХ (масштаб width×height)
 */
export function insightFaceKps(faceLandmarks, width, height) {
  const hasIris = faceLandmarks.length > LEFT_IRIS_CENTER;
  const eyeA = hasIris
    ? { x: faceLandmarks[RIGHT_IRIS_CENTER].x, y: faceLandmarks[RIGHT_IRIS_CENTER].y }
    : meanPoint(faceLandmarks, RIGHT_EYE_RING);
  const eyeB = hasIris
    ? { x: faceLandmarks[LEFT_IRIS_CENTER].x, y: faceLandmarks[LEFT_IRIS_CENTER].y }
    : meanPoint(faceLandmarks, LEFT_EYE_RING);
  const nose = faceLandmarks[NOSE_TIP];
  const mA = faceLandmarks[MOUTH_CORNER_A];
  const mB = faceLandmarks[MOUTH_CORNER_B];

  const [eyeL, eyeR] = eyeA.x <= eyeB.x ? [eyeA, eyeB] : [eyeB, eyeA];
  const [mouthL, mouthR] = mA.x <= mB.x ? [mA, mB] : [mB, mA];

  return [eyeL, eyeR, nose, mouthL, mouthR].map((p) => [p.x * width, p.y * height]);
}

/**
 * Пересчёт нормализованных landmarks из кропа обратно в координаты полного кадра.
 * @param {Array<{x:number,y:number,z?:number}>} faceLandmarks
 * @param {{ xScale?:number, xOffset?:number, yScale?:number, yOffset?:number }} t
 */
export function remapCropLandmarks(faceLandmarks, { xScale = 1, xOffset = 0, yScale = 1, yOffset = 0 }) {
  return faceLandmarks.map((p) => ({
    x: p.x * xScale + xOffset,
    y: p.y * yScale + yOffset,
    z: p.z,
  }));
}

// Полосы кадра, пробуемые по очереди, когда детекция по всему кадру не нашла лицо.
// Верх — типовые full-body карточки (голова у верхнего края). Средняя полоса —
// сидящие модели / кроп по пояс, где голова заметно ниже верхних 50%.
const DEFAULT_FALLBACKS = [
  { yStart: 0, yEnd: 0.5 },
  { yStart: 0.25, yEnd: 0.75 },
];

/**
 * Детекция одного лица с запасными проходами по частям кадра.
 * MediaPipe FaceLandmarker не находит лица, занимающие малую долю кадра
 * (фото в полный рост на карточках) — тогда детектим по кропу нужной полосы
 * и пересчитываем точки обратно в полный кадр.
 * @param {import("@mediapipe/tasks-vision").FaceLandmarker} landmarker
 * @param {CanvasImageSource & { width:number, height:number }} image
 * @param {{ fallbacks?: Array<{yStart:number,yEnd:number}> }} [opts]
 * @returns {Array|null} нормализованные landmarks в координатах ПОЛНОГО кадра, либо null
 */
export function detectFace(landmarker, image, { fallbacks = DEFAULT_FALLBACKS } = {}) {
  const first = landmarker.detect(image).faceLandmarks ?? [];
  if (first.length > 0) return first[0];

  for (const { yStart, yEnd } of fallbacks) {
    const y0 = Math.round(image.height * yStart);
    const cropH = Math.max(1, Math.round(image.height * yEnd) - y0);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = cropH;
    canvas
      .getContext("2d")
      .drawImage(image, 0, y0, image.width, cropH, 0, 0, image.width, cropH);

    const found = landmarker.detect(canvas).faceLandmarks ?? [];
    if (found.length > 0) {
      return remapCropLandmarks(found[0], { yScale: cropH / image.height, yOffset: yStart });
    }
  }
  return null;
}

/** Прямоугольник вокруг всех точек лица в нормализованных координатах 0..1. */
export function landmarksBBox(faceLandmarks) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of faceLandmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
