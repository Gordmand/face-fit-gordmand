// Content script (только Lamoda): сканирует страницу, находит фото моделей,
// отдаёт их URL в offscreen-конвейер, подменяет результат.
// Тяжёлого тут нет — только DOM и chrome.runtime.

import {
  isImageCandidate,
  SerialQueue,
  upgradeLmcdnUrl,
  isNearViewport,
} from "./src/content/scanner.js";
import { initBadge, hideBadge } from "./src/content/badge.js";

const MARK = "facefitDone"; // img.dataset.facefitDone === "1" — уже подменено
const queue = new SerialQueue();
const seen = new WeakSet(); // картинки, уже поставленные в очередь
const cache = new Map(); // key (upgraded URL) -> dataUrl | null (null = лица нет)

let enabled = false;
let foreheadMask = true;
let matchGender = true;
let userGender = null;
let started = false;
let io = null;
let mo = null;
let noPhoto = false; // хоть раз пришло "фото пользователя не задано"
let pipelineError = null; // офscreen сломался (не no-face/gender-mismatch/no-photo) — не пробуем дальше
let inFlight = 0; // сколько картинок сейчас в очереди/обработке — для индикатора в popup

async function main() {
  ({ enabled, foreheadMask, matchGender, userGender } = await chrome.storage.local.get({
    enabled: false,
    foreheadMask: true,
    matchGender: true,
    userGender: null,
  }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled && !started) start();
      else if (!enabled && started) stop();
    }
    if (changes.foreheadMask) {
      foreheadMask = changes.foreheadMask.newValue;
      if (started) reprocessAll();
    }
    if (changes.matchGender) {
      matchGender = changes.matchGender.newValue;
      console.info("[face-fit] настройки:", { foreheadMask, matchGender, userGender });
      if (started) reprocessAll();
    }
    if (changes.userGender) {
      userGender = changes.userGender.newValue;
      console.info("[face-fit] настройки:", { foreheadMask, matchGender, userGender });
      if (started) reprocessAll();
    }
  });

  if (enabled) start();
}

function start() {
  if (started) return;
  started = true;
  noPhoto = false;
  pipelineError = null;
  console.info("[face-fit] сканер запущен на", location.host);
  console.info("[face-fit] настройки:", { foreheadMask, matchGender, userGender });

  initBadge(toggleImage);
  io = new IntersectionObserver(onIntersect, { rootMargin: "200px" });
  mo = new MutationObserver(onMutations);
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });

  for (const img of document.images) observe(img);
}

function stop() {
  started = false;
  io?.disconnect();
  mo?.disconnect();
  io = mo = null;
  hideBadge();
  for (const img of document.querySelectorAll(`img[data-facefit-done]`)) revert(img);
  cache.clear();
}

/** Сброс всех замен и повторная обработка — при смене настройки «маска в лоб». */
function reprocessAll() {
  hideBadge();
  cache.clear();
  for (const img of document.querySelectorAll(`img[data-facefit-done]`)) {
    delete img.dataset[MARK];
    delete img.dataset.facefitKey;
    delete img.dataset.facefitShown;
    seen.delete(img);
    io?.observe(img); // старый своп остаётся виден, пока не придёт новый
  }
}

// --- сканирование ---

function observe(img) {
  if (!io || seen.has(img) || img.dataset[MARK]) return;
  io.observe(img);
}

function onIntersect(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    consider(e.target);
  }
}

/** Истинный URL картинки, устойчивый к тому, что мы уже подставили свой data:. */
function originalUrl(img) {
  return img.dataset.facefitOrig || img.currentSrc || img.src;
}

const VIEWPORT_MARGIN_SCREENS = 2; // запас в экранах — картинка дальше этого считается неактуальной

/** Не укатилась ли картинка далеко за пределы экрана, пока ждала очереди. */
function stillRelevant(img) {
  const vh = window.innerHeight;
  return isNearViewport(img.getBoundingClientRect(), vh, vh * VIEWPORT_MARGIN_SCREENS);
}

function consider(img) {
  if (!enabled || seen.has(img) || img.dataset[MARK]) return;

  const src = originalUrl(img);
  const rect = img.getBoundingClientRect();

  if (!isImageCandidate({ width: rect.width, height: rect.height, src })) {
    if (src && (!img.complete || !img.naturalWidth)) {
      img.addEventListener("load", () => consider(img), { once: true });
    }
    return;
  }

  seen.add(img);
  inFlight++;
  queue.push(() => process(img, src).finally(() => { inFlight--; }));
}

// --- обработка ---

async function process(img, origUrl) {
  if (!enabled || !img.isConnected || pipelineError) return;

  const key = upgradeLmcdnUrl(origUrl);

  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached) applyResult(img, origUrl, key, cached);
    return; // null -> лица нет, повторно не дёргаем
  }

  if (!stillRelevant(img)) {
    // Пока ждала очереди, картинку укатило далеко от экрана — не тратим на неё
    // дорогой инференс. Вернём в наблюдение: если пользователь проскроллит назад,
    // обработаем заново.
    seen.delete(img);
    io?.observe(img);
    return;
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "facefit:swap",
      imageUrl: key,
      fallbackUrl: origUrl,
      foreheadMask,
      matchGender,
      userGender,
    });
  } catch (err) {
    console.warn("[face-fit] запрос свопа не прошёл:", err.message);
    return; // транзиентная ошибка — не кэшируем, можно повторить
  }

  if (!res?.ok) {
    if (res?.reason === "фото пользователя не задано") {
      if (!noPhoto) {
        noPhoto = true;
        console.info("[face-fit] загрузите своё фото в popup — замена не работает без него");
      }
    } else if (res?.reason === "no-face" || res?.reason === "gender-mismatch") {
      cache.set(key, null); // лица нет или не подходит пол — повторно не дёргаем
      clearSwap(img); // если картинка уже показывала старый своп (до смены настроек) — снять его
    } else {
      // Неопознанная причина — офscreen-конвейер сломан (не загрузилась модель и т.п.).
      // Дальше пытаться бессмысленно, пока страницу не перезагрузят.
      pipelineError = res?.reason || "неизвестная ошибка";
      console.error("[face-fit] конвейер сломан:", pipelineError);
    }
    return;
  }

  cache.set(key, res.dataUrl);
  if (!enabled || !img.isConnected) return;
  applyResult(img, origUrl, key, res.dataUrl);
}

function applyResult(img, origUrl, key, dataUrl) {
  requestAnimationFrame(() => {
    if (!img.dataset.facefitOrig) {
      img.dataset.facefitOrig = origUrl;
      img.dataset.facefitSrcset = img.getAttribute("srcset") || "";
    }
    img.dataset.facefitKey = key;
    img.dataset[MARK] = "1"; // до src — иначе мутация src уйдёт на повторную обработку
    img.removeAttribute("srcset");
    img.src = dataUrl;
  });
}

/** Убрать уже показанный своп с картинки, не трогая её отметку «просмотрено». */
function clearSwap(img) {
  if (!img.dataset.facefitOrig) return; // свопа и не было — нечего снимать
  img.src = img.dataset.facefitOrig;
  const srcset = img.dataset.facefitSrcset;
  if (srcset) img.setAttribute("srcset", srcset);
  else img.removeAttribute("srcset");
  delete img.dataset.facefitOrig;
  delete img.dataset.facefitSrcset;
  delete img.dataset.facefitKey;
  delete img.dataset.facefitShown;
}

function revert(img) {
  if (img.dataset.facefitOrig) img.src = img.dataset.facefitOrig;
  const srcset = img.dataset.facefitSrcset;
  if (srcset) img.setAttribute("srcset", srcset);
  else img.removeAttribute("srcset");
  delete img.dataset[MARK];
  delete img.dataset.facefitOrig;
  delete img.dataset.facefitSrcset;
  delete img.dataset.facefitKey;
  delete img.dataset.facefitShown;
  seen.delete(img);
}

// --- переключение одной картинки (бейдж) ---

/** @returns {"orig" | "swap"} новое состояние показа */
function toggleImage(img) {
  if (img.dataset.facefitShown === "orig") {
    showSwap(img);
    return "swap";
  }
  showOriginal(img);
  return "orig";
}

function showOriginal(img) {
  if (img.dataset.facefitOrig) img.src = img.dataset.facefitOrig;
  const ss = img.dataset.facefitSrcset;
  if (ss) img.setAttribute("srcset", ss);
  else img.removeAttribute("srcset");
  img.dataset.facefitShown = "orig";
}

function showSwap(img) {
  const dataUrl = cache.get(img.dataset.facefitKey);
  if (!dataUrl) return;
  img.removeAttribute("srcset");
  img.src = dataUrl;
  delete img.dataset.facefitShown;
}

// --- мутации DOM ---

function onMutations(muts) {
  for (const m of muts) {
    if (m.type === "attributes") {
      const img = m.target;
      if (img.tagName !== "IMG") continue;

      if (img.dataset[MARK]) {
        if (img.dataset.facefitShown === "orig") continue; // пользователь сам вернул оригинал
        // Наш своп — это data:. Если src снова http(s), значит SPA перерисовала карточку.
        if (!img.src.startsWith("data:")) {
          const cached = cache.get(img.dataset.facefitKey);
          if (cached) {
            applyResult(img, img.dataset.facefitOrig, img.dataset.facefitKey, cached);
          } else {
            delete img.dataset[MARK];
            seen.delete(img);
            io?.observe(img);
          }
        }
      } else if (!seen.has(img)) {
        io?.unobserve(img);
        io?.observe(img); // src подставился лениво — перепроверить
      }
      continue;
    }

    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === "IMG") observe(node);
      else node.querySelectorAll?.("img").forEach(observe);
    }
  }
}

// --- статистика для popup ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "facefit:get-stats") return;
  sendResponse({
    applied: document.querySelectorAll(`img[data-facefit-done]`).length,
    pending: inFlight,
    enabled,
    noPhoto,
    pipelineError,
  });
});

main();
