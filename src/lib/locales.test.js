// Проверка, что во всех локалях один и тот же набор ключей — иначе пользователь
// увидит имя ключа вместо перевода на языке, где забыли что-то добавить.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCALES = ["ru", "en"];

function loadKeys(locale) {
  const path = resolve(root, "_locales", locale, "messages.json");
  const json = JSON.parse(readFileSync(path, "utf8"));
  return Object.keys(json).sort();
}

describe("_locales/*/messages.json", () => {
  const keysByLocale = Object.fromEntries(LOCALES.map((l) => [l, loadKeys(l)]));

  it("не пустые", () => {
    for (const l of LOCALES) expect(keysByLocale[l].length).toBeGreaterThan(0);
  });

  it("одинаковый набор ключей во всех локалях", () => {
    const [first, ...rest] = LOCALES;
    for (const l of rest) {
      expect(keysByLocale[l]).toEqual(keysByLocale[first]);
    }
  });

  it("у каждого сообщения есть непустой message", () => {
    for (const l of LOCALES) {
      const path = resolve(root, "_locales", l, "messages.json");
      const json = JSON.parse(readFileSync(path, "utf8"));
      for (const [key, entry] of Object.entries(json)) {
        expect(entry.message, `${l}/${key}`).toBeTruthy();
      }
    }
  });
});
