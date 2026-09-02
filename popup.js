// Popup: загрузка и валидация фото пользователя + тумблер вкл/выкл.

import { createFaceLandmarker, fivePoints, landmarksBBox } from "./src/lib/faceLandmarker.js";
import {
  saveUserPhoto,
  getUserPhotoBlob,
  getUserPhotoMeta,
  clearUserPhoto,
} from "./src/lib/storage.js";

const el = (id) => document.getElementById(id);

/** Сообщить offscreen-документу, что фото сменилось (сбросить кэш эмбеддинга). */
function notifyPhotoChanged() {
  chrome.runtime.sendMessage({ type: "facefit:photo-changed" }).catch(() => {});
}

const toggle = el("enabled-toggle");
const fileInput = el("file");
const fileReplaceInput = el("file-replace");
const removeBtn = el("remove");
const preview = el("preview");
const metaText = el("meta-text");
const busyText = el("busy-text");
const errorEl = el("error");

const STATES = ["empty", "busy", "saved"];
const MIN_FACE_FRACTION = 0.12; // лицо должно занимать хотя бы ~12% меньшей стороны кадра

let landmarkerPromise = null;
let hasPhoto = false;
let previewUrl = null;

function showState(name) {
  for (const s of STATES) el(`state-${s}`).hidden = s !== name;
}

function showError(msg) {
  errorEl.textContent = msg || "";
  errorEl.hidden = !msg;
}

/** FaceLandmarker создаётся один раз при первой загрузке фото. */
function ensureLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = createFaceLandmarker({ numFaces: 5 }).then((r) => r.landmarker);
  }
  return landmarkerPromise;
}

async function handleFile(file) {
  if (!file) return;
  showError("");
  showState("busy");

  try {
    busyText.textContent = "Загружаю модель…";
    const landmarker = await ensureLandmarker();

    busyText.textContent = "Ищу лицо…";
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const result = landmarker.detect(bitmap);
    const faces = result.faceLandmarks ?? [];

    if (faces.length === 0) {
      finishWithError("На фото не найдено лицо. Нужен чёткий портрет анфас.");
      bitmap.close?.();
      return;
    }
    if (faces.length > 1) {
      finishWithError(`На фото несколько лиц (${faces.length}). Загрузите фото только со своим лицом.`);
      bitmap.close?.();
      return;
    }

    const lm = faces[0];
    const box = landmarksBBox(lm);
    if (Math.min(box.w, box.h) < MIN_FACE_FRACTION) {
      finishWithError("Лицо на фото слишком мелкое. Нужен более крупный портрет.");
      bitmap.close?.();
      return;
    }

    await saveUserPhoto(file, {
      width: bitmap.width,
      height: bitmap.height,
      type: file.type || "image/jpeg",
      size: file.size,
      fivePoints: fivePoints(lm),
    });
    bitmap.close?.();
    notifyPhotoChanged();

    await renderSaved();
  } catch (err) {
    console.error("[face-fit] обработка фото:", err);
    finishWithError(`Не удалось обработать фото: ${err.message}`);
  }
}

/** Показать ошибку и вернуться в подходящее состояние. */
function finishWithError(msg) {
  showError(msg);
  showState(hasPhoto ? "saved" : "empty");
}

async function renderSaved() {
  const [blob, meta] = await Promise.all([getUserPhotoBlob(), getUserPhotoMeta()]);
  if (!blob || !meta) {
    hasPhoto = false;
    showState("empty");
    return;
  }
  hasPhoto = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  preview.src = previewUrl;

  const when = new Date(meta.savedAt).toLocaleDateString("ru-RU");
  metaText.textContent = `${meta.width}×${meta.height} · сохранено ${when}`;
  showState("saved");
}

// --- Тумблеры ---

const foreheadToggle = el("forehead-toggle");

async function initToggles() {
  const { enabled, foreheadMask } = await chrome.storage.local.get({
    enabled: false,
    foreheadMask: true,
  });
  toggle.checked = enabled;
  foreheadToggle.checked = foreheadMask;
}

toggle.addEventListener("change", async () => {
  if (toggle.checked && !hasPhoto) {
    toggle.checked = false;
    showError("Сначала загрузите своё фото.");
    return;
  }
  showError("");
  await chrome.storage.local.set({ enabled: toggle.checked });
});

foreheadToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ foreheadMask: foreheadToggle.checked });
});

// --- События ---

fileInput.addEventListener("change", () => handleFile(fileInput.files?.[0]));
fileReplaceInput.addEventListener("change", () => handleFile(fileReplaceInput.files?.[0]));

removeBtn.addEventListener("click", async () => {
  await clearUserPhoto();
  notifyPhotoChanged();
  showError("");
  if (toggle.checked) {
    toggle.checked = false;
    await chrome.storage.local.set({ enabled: false });
  }
  await renderSaved();
});

el("open-test").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/test/landmarker.html") });
});

el("open-swap-test").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/test/swap.html") });
});

el("open-offscreen-test").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/test/offscreen-test.html") });
});

// --- Статус активной вкладки (счётчик замен / индикатор обработки) ---

const pageStatus = el("page-status");

function setPageStatus(s) {
  if (!s || !s.enabled) {
    pageStatus.hidden = true;
    return;
  }
  pageStatus.hidden = false;
  if (s.pending > 0) {
    pageStatus.innerHTML = `<span class="spinner"></span> Обрабатываю…`;
  } else if (s.applied > 0) {
    pageStatus.textContent = `Заменено лиц на странице: ${s.applied}`;
  } else {
    pageStatus.textContent = "Лиц для замены пока не найдено";
  }
}

async function pollPageStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return setPageStatus(null);
    setPageStatus(await chrome.tabs.sendMessage(tab.id, { type: "facefit:get-stats" }));
  } catch {
    setPageStatus(null); // на этой вкладке нет нашего content script
  }
}

// --- Старт ---

(async () => {
  await initToggles();
  await renderSaved();
  pollPageStatus();
  const timer = setInterval(pollPageStatus, 1000);
  window.addEventListener("unload", () => clearInterval(timer));
})();
