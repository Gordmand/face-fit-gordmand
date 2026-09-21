import { describe, it, expect } from "vitest";
import { isImageCandidate, SerialQueue, upgradeLmcdnUrl, isNearViewport } from "./scanner.js";

describe("isImageCandidate", () => {
  const ok = { width: 300, height: 400, src: "https://a.lmcdn.ru/img600x866/x.jpg" };

  it("принимает крупное видимое фото с http(s) src", () => {
    expect(isImageCandidate(ok)).toBe(true);
    expect(isImageCandidate({ ...ok, src: "http://example.com/x.jpg" })).toBe(true);
  });

  it("отсекает мелкие картинки (иконки/миниатюры)", () => {
    expect(isImageCandidate({ ...ok, width: 119 })).toBe(false);
    expect(isImageCandidate({ ...ok, height: 80 })).toBe(false);
  });

  it("отсекает баннеры по соотношению сторон", () => {
    expect(isImageCandidate({ ...ok, width: 1200, height: 300 })).toBe(false); // 4:1
    expect(isImageCandidate({ ...ok, width: 200, height: 800 })).toBe(false); // 1:4
    expect(isImageCandidate({ ...ok, width: 900, height: 300 })).toBe(true); // ровно 3:1 — граница
  });

  it("отсекает не-http(s) источники", () => {
    expect(isImageCandidate({ ...ok, src: "data:image/png;base64,AAAA" })).toBe(false);
    expect(isImageCandidate({ ...ok, src: "blob:https://x/abc" })).toBe(false);
    expect(isImageCandidate({ ...ok, src: "" })).toBe(false);
    expect(isImageCandidate({ ...ok, src: undefined })).toBe(false);
  });
});

describe("upgradeLmcdnUrl", () => {
  it("поднимает мелкий размер lmcdn до img600x866", () => {
    expect(upgradeLmcdnUrl("https://a.lmcdn.ru/img236x341/M/P/X_1_v2_2x.jpg")).toBe(
      "https://a.lmcdn.ru/img600x866/M/P/X_1_v2_2x.jpg",
    );
    expect(upgradeLmcdnUrl("https://a.lmcdn.ru/img46x66/R/T/Y.jpg")).toBe(
      "https://a.lmcdn.ru/img600x866/R/T/Y.jpg",
    );
  });

  it("работает на любом поддомене lmcdn", () => {
    expect(upgradeLmcdnUrl("https://i1.lmcdn.ru/img236x341/a/b/z.jpg")).toBe(
      "https://i1.lmcdn.ru/img600x866/a/b/z.jpg",
    );
  });

  it("не трогает уже крупный размер", () => {
    const u = "https://a.lmcdn.ru/img600x866/M/P/X.jpg";
    expect(upgradeLmcdnUrl(u)).toBe(u);
  });

  it("не трогает не-lmcdn и URL без сегмента размера", () => {
    expect(upgradeLmcdnUrl("https://example.com/img236x341/x.jpg")).toBe(
      "https://example.com/img236x341/x.jpg",
    );
    expect(upgradeLmcdnUrl("https://a.lmcdn.ru/product/x.jpg")).toBe(
      "https://a.lmcdn.ru/product/x.jpg",
    );
  });
});

describe("isNearViewport", () => {
  const viewportHeight = 800;
  const margin = 1600; // 2 экрана

  it("картинка внутри вьюпорта — рядом", () => {
    expect(isNearViewport({ top: 100, bottom: 500 }, viewportHeight, margin)).toBe(true);
  });

  it("картинка чуть выше или ниже экрана — всё ещё рядом", () => {
    expect(isNearViewport({ top: -900, bottom: -700 }, viewportHeight, margin)).toBe(true);
    expect(isNearViewport({ top: 1700, bottom: 1900 }, viewportHeight, margin)).toBe(true);
  });

  it("картинка укатилась на несколько экранов вверх — не рядом", () => {
    expect(isNearViewport({ top: -3000, bottom: -2800 }, viewportHeight, margin)).toBe(false);
  });

  it("картинка далеко ниже (ещё не проскроллили) — не рядом", () => {
    expect(isNearViewport({ top: 3000, bottom: 3200 }, viewportHeight, margin)).toBe(false);
  });

  it("граница — ровно на краю запаса всё ещё считается рядом", () => {
    expect(isNearViewport({ top: -1600, bottom: -1600 }, viewportHeight, margin)).toBe(true);
    expect(isNearViewport({ top: 2400, bottom: 2400 }, viewportHeight, margin)).toBe(true);
  });
});

describe("SerialQueue", () => {
  it("выполняет задачи по одной, без наложения, в порядке добавления", async () => {
    const q = new SerialQueue();
    const events = [];
    const task = (id) => async () => {
      events.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${id}`);
    };
    q.push(task("a"));
    q.push(task("b"));
    await q.push(task("c"));

    expect(events).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("ошибка одной задачи не роняет очередь", async () => {
    const q = new SerialQueue();
    const done = [];
    q.push(async () => {
      throw new Error("boom");
    });
    await q.push(async () => {
      done.push("после ошибки");
    });
    expect(done).toEqual(["после ошибки"]);
  });
});
