// Popup: загрузка и валидация фото пользователя + тумблер вкл/выкл.

import { createFaceLandmarker, fivePoints, landmarksBBox } from "./src/lib/faceLandmarker.js";
import {
  saveUserPhoto,
  getUserPhotoBlob,
  getUserPhotoMeta,
  clearUserPhoto,
} from "./src/lib/storage.js";

const el = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

/** Сообщить offscreen-документу, что фото сменилось (сбросить кэш эмбеддинга). */
function notifyPhotoChanged() {
  chrome.runtime.sendMessage({ type: "facefit:photo-changed" }).catch(() => {});
}

/** Подставить переводы в статичную разметку popup.html. */
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((elem) => {
    elem.textContent = t(elem.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((elem) => {
    elem.title = t(elem.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((elem) => {
    elem.alt = t(elem.dataset.i18nAlt);
  });
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
    busyText.textContent = t("busyLoadingModel");
    const landmarker = await ensureLandmarker();

    busyText.textContent = t("busySearchingFace");
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const result = landmarker.detect(bitmap);
    const faces = result.faceLandmarks ?? [];

    if (faces.length === 0) {
      finishWithError(t("errNoFace"));
      bitmap.close?.();
      return;
    }
    if (faces.length > 1) {
      finishWithError(t("errMultiFace", String(faces.length)));
      bitmap.close?.();
      return;
    }

    const lm = faces[0];
    const box = landmarksBBox(lm);
    if (Math.min(box.w, box.h) < MIN_FACE_FRACTION) {
      finishWithError(t("errFaceTooSmall"));
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
    finishWithError(t("errProcessFailed", err.message));
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

  const when = new Date(meta.savedAt).toLocaleDateString(chrome.i18n.getUILanguage());
  metaText.textContent = t("photoMeta", [String(meta.width), String(meta.height), when]);
  showState("saved");
}

// --- Тумблеры ---

const foreheadToggle = el("forehead-toggle");
const matchGenderToggle = el("match-gender-toggle");
const genderButtons = document.querySelectorAll("#gender-segmented .segmented-btn");

function setGenderButtons(gender) {
  for (const btn of genderButtons) {
    btn.setAttribute("aria-pressed", String(btn.dataset.gender === gender));
  }
}

async function initToggles() {
  const { enabled, foreheadMask, matchGender, userGender } = await chrome.storage.local.get({
    enabled: false,
    foreheadMask: true,
    matchGender: true,
    userGender: null,
  });
  toggle.checked = enabled;
  foreheadToggle.checked = foreheadMask;
  matchGenderToggle.checked = matchGender;
  setGenderButtons(userGender);
}

toggle.addEventListener("change", async () => {
  if (toggle.checked && !hasPhoto) {
    toggle.checked = false;
    showError(t("errNeedPhotoFirst"));
    return;
  }
  showError("");
  await chrome.storage.local.set({ enabled: toggle.checked });
});

foreheadToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ foreheadMask: foreheadToggle.checked });
});

matchGenderToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ matchGender: matchGenderToggle.checked });
});

for (const btn of genderButtons) {
  btn.addEventListener("click", async () => {
    setGenderButtons(btn.dataset.gender);
    await chrome.storage.local.set({ userGender: btn.dataset.gender });
  });
}

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

// --- Статус активной вкладки (счётчик замен / индикатор обработки) ---

const pageStatus = el("page-status");

function setPageStatus(s) {
  if (!s || !s.enabled) {
    pageStatus.hidden = true;
    pageStatus.classList.remove("warn");
    return;
  }
  pageStatus.hidden = false;
  pageStatus.classList.toggle("warn", !!s.pipelineError);
  if (s.pipelineError) {
    pageStatus.textContent = t("statusPipelineError");
  } else if (s.noPhoto) {
    pageStatus.textContent = t("statusNoPhoto");
  } else if (s.pending > 0) {
    pageStatus.innerHTML = `<span class="spinner"></span> ${t("statusProcessing")}`;
  } else if (s.applied > 0) {
    pageStatus.textContent = t("statusApplied", String(s.applied));
  } else {
    pageStatus.textContent = t("statusNoneFound");
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
  applyI18n();
  await initToggles();
  await renderSaved();
  pollPageStatus();
  const timer = setInterval(pollPageStatus, 1000);
  window.addEventListener("unload", () => clearInterval(timer));
})();
