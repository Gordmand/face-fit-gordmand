import { describe, it, expect } from "vitest";
import { readGenderAge, genderCropRect } from "./genderage.js";

describe("readGenderAge", () => {
  it("female-логит больше -> female, уверенно", () => {
    const r = readGenderAge([2, 0.5, 0.25]);
    expect(r.gender).toBe("female");
    expect(r.age).toBe(25);
    expect(r.genderConf).toBeGreaterThan(0.8);
  });

  it("male-логит больше -> male", () => {
    const r = readGenderAge([0.1, 3, 0.3]);
    expect(r.gender).toBe("male");
    expect(r.age).toBe(30);
  });

  it("близкие логиты -> низкая уверенность", () => {
    const r = readGenderAge([1.0, 1.05, 0.4]);
    expect(r.genderConf).toBeLessThan(0.6);
  });
});

describe("genderCropRect", () => {
  it("центрирует квадратный кроп на bbox с запасом ×1.5", () => {
    const { sx, sy, size } = genderCropRect({ x: 100, y: 50, w: 40, h: 60 });
    expect(size).toBeCloseTo(90); // max(40,60) * 1.5
    expect(sx).toBeCloseTo(120 - 45); // cx=120, size/2=45
    expect(sy).toBeCloseTo(80 - 45); // cy=80
  });

  it("квадратные bbox дают тот же центр без смещения по осям", () => {
    const { sx, sy, size } = genderCropRect({ x: 0, y: 0, w: 20, h: 20 });
    expect(size).toBeCloseTo(30);
    expect(sx).toBeCloseTo(-5);
    expect(sy).toBeCloseTo(-5);
  });
});
