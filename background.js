// Service worker (Manifest V3) — оркестрация.
// SW засыпает через ~30 сек простоя, поэтому состояния тут не держим.
// Тяжёлая обработка (MediaPipe + ONNX + WebGPU) живёт в offscreen-документе.

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log("[face-fit] installed:", reason);
  chrome.storage.local.get({ enabled: false }).then(({ enabled }) => {
    chrome.storage.local.set({ enabled });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let creating = null;

async function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_SCRAPING"],
        justification:
          "Локальная обработка изображений (детекция и замена лица) на canvas и WebGPU.",
      });
      console.log("[face-fit] offscreen создан");
    } catch (err) {
      if (/single offscreen document|already (exists|created)/i.test(err.message)) {
        console.log("[face-fit] offscreen уже есть");
      } else {
        console.error("[face-fit] createDocument упал:", err);
        throw err;
      }
    }
  })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}

// offscreen мог ещё догружать модули — пару раз повторяем.
async function sendToOffscreen(payload, tries = 15) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      if (i === tries - 1 || !/Receiving end does not exist/.test(err.message)) throw err;
      await sleep(200);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "facefit:swap") {
    (async () => {
      await ensureOffscreen();
      const res = await sendToOffscreen({
        type: "facefit:offscreen:swap",
        imageUrl: msg.imageUrl,
        fallbackUrl: msg.fallbackUrl,
        foreheadMask: msg.foreheadMask,
      });
      sendResponse(res);
    })().catch((err) => {
      console.error("[face-fit] swap error:", err);
      sendResponse({ ok: false, reason: err.message });
    });
    return true; // ответим асинхронно
  }
});
