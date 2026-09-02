// Content script (только Lamoda): сканирует страницу, находит фото моделей,
// отдаёт их URL в offscreen-конвейер, подменяет результат.
// Тяжёлого тут нет — только DOM и chrome.runtime.

import { isImageCandidate, SerialQueue, upgradeLmcdnUrl } from "./src/content/scanner.js";

const MARK = "facefitDone"; // img.dataset.facefitDone === "1" — уже подменено
const queue = new SerialQueue();
const seen = new WeakSet(); // картинки, уже поставленные в очередь
const cache = new Map(); // key (upgraded URL) -> dataUrl | null (null = лица нет)

let enabled = false;
let foreheadMask = true;
let started = false;
let io = null;
let mo = null;
let noPhotoLogged = false;

async function main() {
  ({ enabled, foreheadMask } = await chrome.storage.local.get({
    enabled: false,
    foreheadMask: true,
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
  });

  if (enabled) start();
}

function start() {
  if (started) return;
  started = true;
  console.info("[face-fit] сканер запущен на", location.host);

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
  for (const img of document.querySelectorAll(`img[data-facefit-done]`)) revert(img);
  cache.clear();
}

/** Сброс всех замен и повторная обработка — при смене настройки «маска в лоб». */
function reprocessAll() {
  cache.clear();
  for (const img of document.querySelectorAll(`img[data-facefit-done]`)) {
    delete img.dataset[MARK];
    delete img.dataset.facefitKey;
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
  queue.push(() => process(img, src));
}

// --- обработка ---

async function process(img, origUrl) {
  if (!enabled || !img.isConnected) return;

  const key = upgradeLmcdnUrl(origUrl);

  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached) applyResult(img, origUrl, key, cached);
    return; // null -> лица нет, повторно не дёргаем
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "facefit:swap",
      imageUrl: key,
      fallbackUrl: origUrl,
      foreheadMask,
    });
  } catch (err) {
    console.warn("[face-fit] запрос свопа не прошёл:", err.message);
    return; // транзиентная ошибка — не кэшируем, можно повторить
  }

  if (!res?.ok) {
    if (res?.reason === "фото пользователя не задано" && !noPhotoLogged) {
      noPhotoLogged = true;
      console.info("[face-fit] загрузите своё фото в popup — замена не работает без него");
    } else if (res?.reason === "no-face") {
      cache.set(key, null); // лица нет — повторно не дёргаем
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

function revert(img) {
  if (img.dataset.facefitOrig) img.src = img.dataset.facefitOrig;
  const srcset = img.dataset.facefitSrcset;
  if (srcset) img.setAttribute("srcset", srcset);
  else img.removeAttribute("srcset");
  delete img.dataset[MARK];
  delete img.dataset.facefitOrig;
  delete img.dataset.facefitSrcset;
  delete img.dataset.facefitKey;
  seen.delete(img);
}

// --- мутации DOM ---

function onMutations(muts) {
  for (const m of muts) {
    if (m.type === "attributes") {
      const img = m.target;
      if (img.tagName !== "IMG") continue;

      if (img.dataset[MARK]) {
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

main();
