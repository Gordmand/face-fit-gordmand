import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [crx({ manifest })],
  // ONNX Runtime сам подтягивает свой wasm по ort.env.wasm.wasmPaths — не даём Vite
  // пытаться его пре-бандлить.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: {
    // В расширении файлы локальные — предзагрузка модулей не нужна, а её <link>-хинты
    // MV3 всё равно игнорирует и сыплет предупреждениями в панель Errors.
    modulePreload: false,
    // Дополнительные HTML-страницы расширения, не объявленные в манифесте напрямую.
    rollupOptions: {
      input: {
        offscreen: "src/offscreen/offscreen.html",
        landmarkerTest: "src/test/landmarker.html",
        swapTest: "src/test/swap.html",
        offscreenTest: "src/test/offscreen-test.html",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
