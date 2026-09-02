# Face Fit Extension

Браузерное расширение (Manifest V3) для виртуальной примерки одежды на маркетплейсах:
подставляет лицо пользователя моделям на карточках товаров. **Вся обработка — локально в браузере.**

Учебный проект. Подробности архитектуры и плана — во внутренней заметке проекта.

## Сборка и установка (режим разработчика)

```bash
npm install
npm run setup   # копирует wasm MediaPipe + качает модель в public/
npm run build   # собирает dist/
```

1. Chrome → `chrome://extensions/`
2. Включить **Developer mode** (правый верхний угол).
3. **Load unpacked** → выбрать папку `dist/`.

`npm run dev` — сборка с hot-reload (тоже грузится как unpacked из `dist/`).

## Статус

**Этап 4 завершён** — полный конвейер face swap: детекция → выравнивание →
ArcFace-эмбеддинг → inswapper → вклейка обратно (маска по контуру лица с подъёмом в лоб,
растушёвка, подгон тона кожи). Стенд «Тест face swap».

**Этап 5a** — ONNX Runtime на **WebGPU** (откат на wasm). inswapper: ~10 с → ~110 мс на
«прогретой» модели.

**Этап 5b** — весь тяжёлый конвейер вынесен в **offscreen-документ**
(`src/offscreen/`): страница → service worker → offscreen (MediaPipe + ONNX + WebGPU) → назад.

**Этап 5c** — content script сканирует страницы Lamoda, находит фото моделей и подменяет
лица «на лету» (`content.js` + `src/content/scanner.js`). Детекция с запасным проходом по
верху кадра для фото в полный рост. Тесты — `npm test` (Vitest).

**Этап 5d** — откат замен при выключении тумблера, кэш `URL → результат`, переприменение
после перерисовки страницы, запрос `img600x866` для чёткости, тумблер «Маска в лоб» в popup
с мгновенной перерисовкой. Дальше 5e.

`npm run setup` скачивает ~450 МБ моделей в `public/models/` (в git не коммитятся).

## Структура

| Путь                       | Назначение                                                |
| -------------------------- | -------------------------------------------------------- |
| `manifest.json`            | Манифест MV3 (+ CSP с `wasm-unsafe-eval`)                |
| `vite.config.js`           | Сборка расширения через CRXJS                            |
| `scripts/prepare-assets.mjs` | Копирует wasm MediaPipe и качает модель (`npm run setup`) |
| `popup.html/css/js`        | UI popup: загрузка/замена/удаление фото, тумблер          |
| `background.js`            | Service worker — управляет offscreen-документом, роутинг |
| `src/offscreen/`          | Скрытый документ: весь face-swap конвейер (WebGPU)       |
| `content.js`              | Инжектится в страницы, будет искать и заменять лица      |
| `src/lib/faceLandmarker.js` | Обёртка MediaPipe (GPU→CPU fallback, 5 точек, bbox)    |
| `src/lib/ort.js`          | Обёртка ONNX Runtime Web (WebGPU → wasm, createSession)  |
| `src/lib/align.js`        | Выравнивание лица по 5 точкам, кроп через canvas         |
| `src/lib/arcface.js`      | ArcFace: кроп 112 → эмбеддинг 512, косинусная близость   |
| `src/lib/inswapper.js`    | inswapper: кроп 128 + эмбеддинг → лицо с новой личностью  |
| `src/lib/blend.js`        | Вклейка лица обратно: маска по контуру, растушёвка, цвет |
| `src/lib/assetUrl.js`     | URL до файла внутри пакета (chrome.runtime.getURL / dev) |
| `src/lib/storage.js`       | Фото → IndexedDB, метаданные → chrome.storage.local      |
| `src/test/landmarker.html/js` | Стенд: изображение → сетка 468 точек + рамка + 5 точек |
| `src/test/swap.html/js`   | Стенд face swap                                          |
| `public/wasm`, `public/ort`, `public/models` | Локальные ассеты (`npm run setup`)   |
| `icons/`                   | Иконки расширения (пока плейсхолдеры)                    |
