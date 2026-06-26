// Process the user's supplied brand art (public/logo-src.jpg, public/icon-src.jpg):
//  - logo:  key out the white background -> transparent public/logo.png (trimmed)
//  - icon:  produce @capacitor/assets sources (assets/icon-only|foreground|background.png)
//           and a web favicon public/icon.png
// Run: node scripts/process-brand.mjs
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const PUB = 'public';
const ASSETS = 'assets';
const SRC = 'assets/brand';
mkdirSync(ASSETS, { recursive: true });

// --- Logo: remove white bg. The wordmark is blue/orange/black (no white parts),
// so keying near-white pixels to transparent is safe. Feather the 205-236 band
// so the edges against the dark header stay clean, then trim the empty margin. ---
{
  const { data, info } = await sharp(`${SRC}/logo-src.jpg`)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mn = Math.min(r, g, b);
    const sat = Math.max(r, g, b) - mn;
    if (mn >= 236 && sat <= 14) {
      data[i + 3] = 0;
    } else if (mn >= 205 && sat <= 26) {
      data[i + 3] = Math.max(0, Math.min(255, Math.round(((236 - mn) / 31) * 255)));
    }
  }
  const keyed = await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } })
    .png()
    .toBuffer();
  await sharp(keyed).trim().png().toFile(`${PUB}/logo.png`);
  console.log('wrote public/logo.png');
}

// --- App icon: the supplied Icon.jpg is already a finished square tile (blue
// rounded square + mX + MUNNX on white). Use it whole; white adaptive background
// matches its own white border. ---
await sharp(`${SRC}/icon-src.jpg`).resize(1024, 1024, { fit: 'cover' }).png().toFile(`${ASSETS}/icon-only.png`);
await sharp(`${SRC}/icon-src.jpg`).resize(1024, 1024, { fit: 'cover' }).png().toFile(`${ASSETS}/icon-foreground.png`);
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' } }).png().toFile(`${ASSETS}/icon-background.png`);
await sharp(`${SRC}/icon-src.jpg`).resize(512, 512, { fit: 'cover' }).png().toFile(`${PUB}/icon.png`);
console.log('wrote icon sources + public/icon.png');
