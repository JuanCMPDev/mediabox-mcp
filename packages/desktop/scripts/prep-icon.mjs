#!/usr/bin/env node
/**
 * Trim transparent edges from icon-source.png, then center the trimmed art on
 * a 1024×1024 transparent canvas with a small breathing margin. Without the
 * trim, sharp's `fit: contain` preserves the original aspect ratio's empty
 * padding — the hexagon ends up at ~40% of the canvas, which is why the
 * desktop shortcut renders a tiny icon in a sea of transparency.
 *
 * Idempotent: safe to re-run.
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

const SIZE      = 1024;
// Inner area for the artwork. ~6% margin on each side gives the icon enough
// room to render as a proper Windows app icon at small sizes (16×16, 32×32)
// without bleeding into the edges, while still filling the canvas.
const PADDING   = 64;
const INNER     = SIZE - 2 * PADDING;

// Trim fully-transparent edges. Sharp uses the top-left pixel as the trim
// reference by default; if the source has a transparent corner that's what
// we want. The threshold absorbs near-zero alpha noise from antialiasing.
const trimmed = await sharp(SRC)
  .trim({ threshold: 10 })
  .toBuffer();

const trimmedMeta = await sharp(trimmed).metadata();
console.log(`[icons] trimmed to ${trimmedMeta.width}×${trimmedMeta.height}`);

// Scale the trimmed art to fit INNER×INNER while preserving aspect ratio,
// then composite onto a SIZE×SIZE transparent canvas.
const resized = await sharp(trimmed)
  .resize({
    width:      INNER,
    height:     INNER,
    fit:        'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
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
  .composite([{ input: resized, gravity: 'center' }])
  .png()
  .toFile(OUT);

console.log(`[icons] wrote ${path.relative(ROOT, OUT)} (${SIZE}×${SIZE} with ${PADDING}px margin)`);
