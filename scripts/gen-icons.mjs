// Иконки расширения из icons/icon.svg → PNG 16/48/128.
// Запуск: npm run icons

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const iconsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const svg = await readFile(resolve(iconsDir, "icon.svg"));

for (const size of [16, 48, 128]) {
  const out = resolve(iconsDir, `icon${size}.png`);
  // density повыше — рисуем SVG крупно и уменьшаем, край получается чётче
  await sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`✓ icon${size}.png`);
}
