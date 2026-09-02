// Чистая логика сканера страницы: отбор картинок-кандидатов и последовательная очередь.
// DOM/observers — в content.js; здесь только то, что можно протестировать без браузера.

const MIN_SIDE = 120; // px — меньше считаем иконкой/миниатюрой
const MAX_ASPECT = 3; // шире 3:1 или уже 1:3 — баннер, не карточка

/**
 * @param {{ width:number, height:number, src?:string }} img
 * @returns {boolean}
 */
export function isImageCandidate({ width, height, src }) {
  if (!width || !height) return false;
  if (width < MIN_SIDE || height < MIN_SIDE) return false;

  const aspect = width / height;
  if (aspect > MAX_ASPECT || aspect < 1 / MAX_ASPECT) return false;

  if (typeof src !== "string") return false;
  if (!/^https?:\/\//i.test(src)) return false; // не data:, не blob:, не пусто

  return true;
}

/**
 * Для картинок Lamoda CDN поднимает мелкий размер до img600x866 —
 * так надёжнее детекция лица и чётче результат. Прочие URL не трогает.
 * @param {string} url
 * @returns {string}
 */
export function upgradeLmcdnUrl(url) {
  return url.replace(
    /^(https?:\/\/[^/]*\.lmcdn\.ru\/)img\d+x\d+\//i,
    "$1img600x866/",
  );
}

/** Очередь async-задач: одна в моменте, в порядке добавления, ошибки не роняют. */
export class SerialQueue {
  #tail = Promise.resolve();

  /**
   * @param {() => Promise<any>} task
   * @returns {Promise<void>} резолвится, когда задача завершена (или упала)
   */
  push(task) {
    const run = this.#tail.then(() => task()).catch((err) => {
      console.warn("[face-fit] задача очереди упала:", err);
    });
    this.#tail = run;
    return run;
  }
}
