import { defineConfig } from "vitest/config";

// Отдельный конфиг без CRXJS-плагина — он не нужен для юнит-тестов чистой логики.
export default defineConfig({
  test: {
    include: ["src/**/*.test.js"],
    environment: "node",
  },
});
