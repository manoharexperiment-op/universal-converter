// Generate the source images that @capacitor/assets needs (assets/icon-only.png,
// icon-foreground.png, icon-background.png) from the MunnX Convertor brand art.
// Rasterized with sharp (bundled via @capacitor/assets). Run: node scripts/gen-icons.mjs
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('assets', { recursive: true });

const GRAD = `
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2563eb"/>
    <stop offset="0.55" stop-color="#3b82f6"/>
    <stop offset="1" stop-color="#f97316"/>
  </linearGradient>`;

// The two-arrow "convert" mark, authored in a 512 coordinate space.
const arrows = (s, tx, ty) => `
  <g fill="#ffffff" transform="translate(${tx},${ty}) scale(${s})">
    <path d="M256 132a124 124 0 0 1 110 67l-38 20a82 82 0 0 0-72-45z"/>
    <path d="M366 154l18 88-88-18z"/>
    <path d="M256 380a124 124 0 0 1-110-67l38-20a82 82 0 0 0 72 45z"/>
    <path d="M146 358l-18-88 88 18z"/>
  </g>`;

const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${GRAD}</defs>${inner}</svg>`;

// Full-bleed icon (gradient + arrows, art 512 -> 1024 == scale 2). For iOS / legacy.
const iconOnly = svg(`<rect width="1024" height="1024" fill="url(#g)"/>${arrows(2, 0, 0)}`);
// Adaptive background: just the gradient (system applies the mask shape).
const background = svg(`<rect width="1024" height="1024" fill="url(#g)"/>`);
// Adaptive foreground: white arrows centered in the safe zone (scaled, transparent bg).
const s = 1.7;
const foreground = svg(arrows(s, 512 - 256 * s, 512 - 256 * s));

const out = async (markup, file) => {
  await sharp(Buffer.from(markup)).png().toFile(`assets/${file}`);
  console.log('wrote assets/' + file);
};

await out(iconOnly, 'icon-only.png');
await out(background, 'icon-background.png');
await out(foreground, 'icon-foreground.png');
console.log('done');
