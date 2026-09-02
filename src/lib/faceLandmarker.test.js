import { describe, it, expect } from "vitest";
import { remapCropLandmarks } from "./faceLandmarker.js";

describe("remapCropLandmarks", () => {
  it("пересчитывает y из кропа верхних 50% в полный кадр", () => {
    // точка в центре кропа (y=0.5) -> четверть полного кадра (y=0.25)
    const out = remapCropLandmarks([{ x: 0.4, y: 0.5, z: -0.1 }], { yScale: 0.5 });
    expect(out[0]).toEqual({ x: 0.4, y: 0.25, z: -0.1 });
  });

  it("x без смещения при кропе на всю ширину", () => {
    const out = remapCropLandmarks([{ x: 0.9, y: 0.2 }], { yScale: 0.5 });
    expect(out[0].x).toBe(0.9);
    expect(out[0].y).toBeCloseTo(0.1);
  });

  it("поддерживает смещение и по x (кроп не от левого края)", () => {
    const out = remapCropLandmarks([{ x: 0.5, y: 0.5 }], {
      xScale: 0.6,
      xOffset: 0.2,
      yScale: 0.4,
      yOffset: 0,
    });
    expect(out[0].x).toBeCloseTo(0.2 + 0.5 * 0.6); // 0.5
    expect(out[0].y).toBeCloseTo(0.2);
  });

  it("не мутирует вход", () => {
    const src = [{ x: 0.1, y: 0.1, z: 0 }];
    remapCropLandmarks(src, { yScale: 0.5 });
    expect(src[0].y).toBe(0.1);
  });
});
