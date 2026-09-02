// Offscreen-документ: весь тяжёлый конвейер face swap.
// Слушатель регистрируется сразу; MediaPipe + ONNX грузятся лениво при первом запросе,
// чтобы ошибки загрузки возвращались текстом, а не как «нет получателя».

console.log("[face-fit/offscreen] загружен");

let pipelinePromise = null;

function loadPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const [
        { createFaceLandmarker, insightFaceKps, landmarksBBox, detectFace },
        { estimateNorm, warpToCanvas },
        { embed },
        { swapFace },
        { faceOvalPolygon, featherMask, colorMatch, pasteBack },
        { getUserPhotoBlob },
      ] = await Promise.all([
        import("../lib/faceLandmarker.js"),
        import("../lib/align.js"),
        import("../lib/arcface.js"),
        import("../lib/inswapper.js"),
        import("../lib/blend.js"),
        import("../lib/storage.js"),
      ]);

      let landmarkerPromise = null;
      const getLandmarker = () => {
        if (!landmarkerPromise) {
          landmarkerPromise = createFaceLandmarker({ numFaces: 1 }).then((r) => r.landmarker);
        }
        return landmarkerPromise;
      };

      // Эмбеддинг лица пользователя считаем один раз.
      let sourceEmbeddingPromise = null;
      const resetSource = () => {
        sourceEmbeddingPromise = null;
      };
      const getSourceEmbedding = () => {
        if (!sourceEmbeddingPromise) {
          sourceEmbeddingPromise = (async () => {
            const blob = await getUserPhotoBlob();
            if (!blob) throw new Error("фото пользователя не задано");
            const landmarker = await getLandmarker();
            const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
            const faces = landmarker.detect(bmp).faceLandmarks ?? [];
            if (faces.length !== 1) {
              bmp.close?.();
              throw new Error(`в фото пользователя лиц: ${faces.length}`);
            }
            const kps = insightFaceKps(faces[0], bmp.width, bmp.height);
            const crop = warpToCanvas(bmp, estimateNorm(kps, 112), 112, 112);
            bmp.close?.();
            return embed(crop);
          })();
        }
        return sourceEmbeddingPromise;
      };

      async function fetchImage(imageUrl, fallbackUrl) {
        let resp = await fetch(imageUrl);
        if (!resp.ok && fallbackUrl && fallbackUrl !== imageUrl) {
          resp = await fetch(fallbackUrl); // напр. img600x866 у товара нет → исходный URL
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.blob();
      }

      async function processImage(imageUrl, { fallbackUrl, foreheadMask = true } = {}) {
        const t0 = performance.now();
        const [landmarker, sourceEmbedding] = await Promise.all([
          getLandmarker(),
          getSourceEmbedding(),
        ]);

        const blob = await fetchImage(imageUrl, fallbackUrl);
        const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
        const imgW = bmp.width; // фиксируем до bmp.close() — после закрытия обнуляются
        const imgH = bmp.height;

        const lm = detectFace(landmarker, bmp, { topFraction: 0.5 });
        if (!lm) {
          bmp.close?.();
          return { ok: false, reason: "no-face", imgW, imgH };
        }

        const bb = landmarksBBox(lm);
        const faceW = Math.round(bb.w * imgW);
        const faceH = Math.round(bb.h * imgH);
        const kps = insightFaceKps(lm, imgW, imgH);
        const M = estimateNorm(kps, 128);
        const crop = warpToCanvas(bmp, M, 128, 128);

        const swapped = await swapFace(crop, sourceEmbedding);
        const polygon = faceOvalPolygon(lm, imgW, imgH, M, {
          foreheadLift: foreheadMask ? 0.28 : 0,
        });
        const mask = featherMask(polygon, 128, 10);
        const face = colorMatch(swapped, crop, mask, 0.7);
        const out = pasteBack(bmp, face, M, mask);
        bmp.close?.();

        return {
          ok: true,
          dataUrl: out.toDataURL("image/png"),
          width: out.width,
          height: out.height,
          faceW,
          faceH,
          ms: Math.round(performance.now() - t0),
        };
      }

      return { processImage, resetSource };
    })();
  }
  return pipelinePromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Пользователь сменил/удалил фото — сбросить кэш эмбеддинга (если конвейер уже поднят).
  if (msg?.type === "facefit:photo-changed") {
    if (pipelinePromise) pipelinePromise.then((p) => p.resetSource()).catch(() => {});
    return;
  }
  if (msg?.type !== "facefit:offscreen:swap") return;
  loadPipeline()
    .then(({ processImage }) =>
      processImage(msg.imageUrl, {
        fallbackUrl: msg.fallbackUrl,
        foreheadMask: msg.foreheadMask,
      }),
    )
    .then(sendResponse)
    .catch((err) => {
      console.error("[face-fit/offscreen]", err);
      sendResponse({ ok: false, reason: err.message });
    });
  return true; // ответим асинхронно
});
