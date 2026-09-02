// Тонкая обёртка над ONNX Runtime Web.
// Бэкенд: WebGPU с откатом на wasm. Все файлы рантайма — локальные (public/ort/), MV3.

import * as ort from "onnxruntime-web/webgpu";
import { assetUrl } from "./assetUrl.js";

let configured = false;

/** Настроить ORT: локальные wasm-файлы, один поток. Идемпотентно. */
export function configureOrt() {
  if (configured) return;
  ort.env.wasm.wasmPaths = assetUrl("ort/");
  // Потоки требуют cross-origin isolation (SharedArrayBuffer) — в расширении её нет.
  ort.env.wasm.numThreads = 1;
  // Прячем info/warning ORT (напр. «Removing initializer 'initializer'» — ожидаемо:
  // emap читаем в обход графа).
  ort.env.logLevel = "error";
  configured = true;
}

const configure = configureOrt;

/**
 * @param {string} modelPath путь внутри пакета, напр. "models/inswapper_128_fp16.onnx"
 * @param {import("onnxruntime-web").InferenceSession.SessionOptions} [options]
 */
export async function createSession(modelPath, options = {}) {
  configure();
  return ort.InferenceSession.create(assetUrl(modelPath), {
    // WebGPU быстрее на порядок; при недоступности ORT сам откатится на wasm.
    executionProviders: ["webgpu", "wasm"],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3, // только ошибки; глушит warning из C++-графа ORT
    ...options,
  });
}

/** Доступен ли WebGPU в этом контексте. */
export function hasWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/** Краткая сводка по входам/выходам сессии — для отладки. */
export function describeSession(session) {
  const io = (names) =>
    names.map((name) => {
      const md = session.inputMetadata?.find?.((m) => m.name === name)
        ?? session.outputMetadata?.find?.((m) => m.name === name);
      return md
        ? { name, type: md.type, dims: md.shape ?? md.dimensions }
        : { name };
    });
  return {
    inputs: io(session.inputNames),
    outputs: io(session.outputNames),
  };
}

export { ort };
