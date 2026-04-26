#!/usr/bin/env node
/**
 * Pad icon-source.png to a square 1024x1024 PNG, since `tauri icon` only
 * accepts square sources. Output goes to a temp file consumed by the icon
 * step in package.json. Idempotent: safe to re-run.
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const SRC       = path.resolve(ROOT, 'icon-source.png');
const OUT       = path.resolve(ROOT, '.icon-square.png');

if (!existsSync(SRC)) {
  console.error(`[icons] source not found: ${SRC}`);
  process.exit(1);
}

const SIZE = 1024;

const meta = await sharp(SRC).metadata();
const w = meta.width ?? SIZE;
const h = meta.height ?? SIZE;

console.log(`[icons] source ${w}×${h} → padding to ${SIZE}×${SIZE}`);

// 1) Resize source so its longest edge ≤ SIZE while preserving aspect ratio.
// 2) Place onto a transparent SIZE×SIZE canvas, centered.
const resized = await sharp(SRC)
  .resize({
    width:           SIZE,
    height:          SIZE,
    fit:             'contain',
    background:      { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

await sharp({
  create: {
    width:      SIZE,
    height:     SIZE,
    channels:   4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([{ input: resized }])
  .png()
  .toFile(OUT);

console.log(`[icons] wrote ${path.relative(ROOT, OUT)}`);
