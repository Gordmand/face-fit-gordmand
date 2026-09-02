// Драйвер теста offscreen: шлём целевое фото в service worker, получаем результат.

const fileInput = document.getElementById("file");
const origImg = document.getElementById("orig");
const resultImg = document.getElementById("result");
const logEl = document.getElementById("log");

const readAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  logEl.textContent = "Кодирую фото…";
  resultImg.removeAttribute("src");

  try {
    const dataUrl = await readAsDataURL(file);
    origImg.src = dataUrl;

    logEl.textContent = "Отправляю в offscreen…";
    const t0 = performance.now();
    const res = await chrome.runtime.sendMessage({ type: "facefit:swap", imageUrl: dataUrl });
    const roundtrip = Math.round(performance.now() - t0);

    if (!res?.ok) {
      logEl.textContent = `Не удалось: ${res?.reason ?? "нет ответа"}\n(полный путь ${roundtrip} мс)`;
      return;
    }
    resultImg.src = res.dataUrl;
    logEl.textContent =
      `Готово.\n` +
      `размер: ${res.width}×${res.height}, лиц найдено: ${res.faces}\n` +
      `обработка в offscreen: ${res.ms} мс\n` +
      `полный путь (со связью): ${roundtrip} мс`;
  } catch (err) {
    console.error(err);
    logEl.textContent = `Ошибка: ${err.message}`;
  }
});
