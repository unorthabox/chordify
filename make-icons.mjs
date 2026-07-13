/* Regenerate the app icons.
 *
 * There is no image tooling on this box (no ImageMagick, no Pillow) — but there is
 * a headless Chromium, courtesy of Playwright, and it has a canvas. So the mark is
 * redrawn vectorially at each size rather than upscaled from the 180px original,
 * which would be soft at 512.
 *
 *   node make-icons.mjs        # writes icon-180/192/512 + icon-maskable-512
 *
 * Android's install prompt wants 192 and 512. `maskable` gets its own file because
 * Android crops it to a circle: the mark has to sit inside the middle ~80% safe
 * zone, so it is drawn smaller on a full-bleed background. Using one icon for both
 * gets you either a clipped mark or a tiny floating one.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const BG = '#050805', PHOS = '#4dff8f', DIM = '#1f7a45';

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

const draw = (size, scale) => page.evaluate(({ size, scale, BG, PHOS, DIM }) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const S = size, M = S / 2;

  x.fillStyle = BG;
  x.fillRect(0, 0, S, S);

  // phosphor bloom behind the mark — the CRT look the whole app is built around
  const g = x.createRadialGradient(M, M, S * 0.05, M, M, S * 0.55);
  g.addColorStop(0, 'rgba(77,255,143,0.22)');
  g.addColorStop(0.55, 'rgba(77,255,143,0.05)');
  g.addColorStop(1, 'rgba(5,8,5,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);

  const rr = (cx, cy, w, h, r) => {
    x.beginPath();
    x.moveTo(cx - w / 2 + r, cy - h / 2);
    x.arcTo(cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r);
    x.arcTo(cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2, r);
    x.arcTo(cx - w / 2, cy + h / 2, cx - w / 2, cy - h / 2, r);
    x.arcTo(cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, r);
    x.closePath();
  };

  // outer frame (dim) then the lit slab — a glowing terminal key
  const OW = S * 0.44 * scale, OH = S * 0.56 * scale;
  x.strokeStyle = DIM;
  x.lineWidth = S * 0.035 * scale;
  rr(M, M, OW, OH, S * 0.05 * scale);
  x.stroke();

  x.shadowColor = PHOS;
  x.shadowBlur = S * 0.09 * scale;
  x.fillStyle = PHOS;
  rr(M, M, OW - S * 0.13 * scale, OH - S * 0.15 * scale, S * 0.03 * scale);
  x.fill();

  return c.toDataURL('image/png');
}, { size, scale, BG, PHOS, DIM });

const save = async (name, size, scale) => {
  const url = await draw(size, scale);
  await writeFile(name, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`  wrote ${name} (${size}x${size})`);
};

await save('icon-180.png', 180, 1);            // iOS apple-touch-icon
await save('icon-192.png', 192, 1);            // Android install prompt
await save('icon-512.png', 512, 1);            // Android splash
await save('icon-maskable-512.png', 512, 0.7); // Android adaptive: mark inside the safe zone

await browser.close();
