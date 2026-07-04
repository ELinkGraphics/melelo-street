// Build-time image optimizer: converts the bundled PNG art to right-sized WebP.
// Originals are kept — old order snapshots still reference the .png paths.
//
//   npm run images        (re-runs are cheap; skips up-to-date outputs)
//
// Garment art keeps alpha at q82 capped to 1000px; the background drops to
// q60 at 1600w (it sits behind a dark gradient, quality is invisible).
import sharp from 'sharp';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'public');

/** @type {{src: string, width?: number, height?: number, quality: number}[]} */
const JOBS = [];

// All model/product art: cap the long edge at 1000px, keep transparency.
for (const f of await readdir(path.join(ROOT, 'models'))) {
  if (f.endsWith('.png')) {
    JOBS.push({ src: path.join('models', f), height: 1000, quality: 82 });
  }
}
// Fullscreen background + logo.
JOBS.push({ src: 'bg.png', width: 1600, quality: 60 });
JOBS.push({ src: 'logo.png', quality: 85 });

let total = 0, saved = 0;
for (const job of JOBS) {
  const input = path.join(ROOT, job.src);
  const output = input.replace(/\.png$/i, '.webp');

  // Skip when the webp is newer than its source.
  try {
    const [s, o] = [await stat(input), await stat(output)];
    if (o.mtimeMs > s.mtimeMs) { total += o.size; continue; }
  } catch { /* output missing — generate */ }

  const img = sharp(input);
  const meta = await img.metadata();
  const resize = {};
  if (job.height && (meta.height ?? 0) > job.height) resize.height = job.height;
  if (job.width && (meta.width ?? 0) > job.width) resize.width = job.width;

  const buf = await (Object.keys(resize).length ? img.resize(resize) : img)
    .webp({ quality: job.quality, effort: 5 })
    .toBuffer();
  await sharp(buf).toFile(output);

  const before = (await stat(input)).size;
  total += buf.length;
  saved += before - buf.length;
  console.log(
    `${job.src.padEnd(48)} ${(before / 1024).toFixed(0).padStart(6)} KB → ${(buf.length / 1024).toFixed(0).padStart(5)} KB`
  );
}
console.log(`\nWebP total: ${(total / 1024 / 1024).toFixed(2)} MB (saved ${(saved / 1024 / 1024).toFixed(2)} MB)`);
