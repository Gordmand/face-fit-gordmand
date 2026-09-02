// Абсолютный URL до файла внутри пакета расширения.
// Внутри расширения — chrome.runtime.getURL; вне (dev-сервер) — от origin.
export function assetUrl(path) {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL(`/${path}`, location.origin).href;
}
