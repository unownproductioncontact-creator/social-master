#!/usr/bin/env node
// Génère src/app/favicon.ico (16/32/48 px) à partir de src/app/icon.svg, la source unique de l'icône.
// Le même dessin doit apparaître partout : logo du site (BrandMark), favicon et icône de l'app dans le
// portail TikTok. La revue Production TikTok l'exige (rejet du 06/10/2026, CLAUDE.md §33).
//
// Usage : node scripts/build-icons.mjs [chemin.png]   → écrit aussi l'icône 1024×1024 pour le portail TikTok.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(path.join(root, "src/app/icon.svg"));

const render = (size) => sharp(svg, { density: (72 * size) / 24 }).resize(size, size).png().toBuffer();

/** Conteneur ICO avec des images PNG (accepté par tous les navigateurs actuels). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(async (size) => ({ size, png: await render(size) })));
writeFileSync(path.join(root, "src/app/favicon.ico"), ico(images));
console.log(`src/app/favicon.ico (${sizes.join(", ")} px)`);

const output = process.argv[2];
if (output) {
  writeFileSync(path.resolve(output), await render(1024));
  console.log(`${path.resolve(output)} (1024×1024)`);
}
