// Тестовый стенд этапа 2: детекция лица на статичном изображении.

import { createFaceLandmarker, fivePoints } from "../lib/faceLandmarker.js";
import { FaceLandmarker } from "@mediapipe/tasks-vision";

const statusEl = document.getElementById("status");
const fileInput = document.getElementById("file");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const optMesh = document.getElementById("mesh");
const optBox = document.getElementById("box");
const optFive = document.getElementById("five");

let landmarker = null;
let lastImage = null;
let lastResult = null;

function log(msg) {
  statusEl.textContent = msg;
}

async function init() {
  const t0 = performance.now();
  try {
    const created = await createFaceLandmarker({ numFaces: 5 });
    landmarker = created.landmarker;
    log(`Готово. Делегат: ${created.delegate}. Инициализация: ${(performance.now() - t0).toFixed(0)} мс.\nВыберите изображение.`);
    fileInput.disabled = false;
  } catch (err) {
    console.error(err);
    log(`Ошибка инициализации: ${err.message}`);
  }
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file || !landmarker) return;
  const bitmap = await createImageBitmap(file);
  lastImage = bitmap;

  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const t0 = performance.now();
  lastResult = landmarker.detect(bitmap);
  const ms = performance.now() - t0;

  const faces = lastResult.faceLandmarks?.length ?? 0;
  log(
    `Файл: ${file.name} (${bitmap.width}×${bitmap.height})\n` +
      `Найдено лиц: ${faces}\n` +
      `Время детекции: ${ms.toFixed(1)} мс`,
  );
  draw();
});

[optMesh, optBox, optFive].forEach((el) => el.addEventListener("change", draw));

function draw() {
  if (!lastImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(lastImage, 0, 0);

  const faceSets = lastResult?.faceLandmarks ?? [];
  for (const lm of faceSets) {
    if (optMesh.checked) drawMesh(lm);
    if (optBox.checked) drawBox(lm);
    if (optFive.checked) drawFive(lm);
  }
}

function drawMesh(lm) {
  // Тонкая сетка триангуляции (рёбра из константы MediaPipe).
  ctx.strokeStyle = "rgba(0, 200, 120, 0.35)";
  ctx.lineWidth = Math.max(1, canvas.width / 1200);
  ctx.beginPath();
  for (const conn of FaceLandmarker.FACE_LANDMARKS_TESSELATION) {
    const a = lm[conn.start];
    const b = lm[conn.end];
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
  }
  ctx.stroke();
}

function drawBox(lm) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  ctx.strokeStyle = "rgba(37, 99, 235, 0.9)";
  ctx.lineWidth = Math.max(2, canvas.width / 400);
  ctx.strokeRect(
    minX * canvas.width,
    minY * canvas.height,
    (maxX - minX) * canvas.width,
    (maxY - minY) * canvas.height,
  );
}

function drawFive(lm) {
  const pts = fivePoints(lm);
  ctx.fillStyle = "rgba(220, 30, 60, 0.95)";
  const r = Math.max(3, canvas.width / 200);
  for (const p of Object.values(pts)) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

fileInput.disabled = true;
init();
