// Regenerates public/icon-dev.png — the icon the app shows when it runs in DEV.
//
//   pnpm --filter @sarvinbox/desktop gen:dev-icon
//
// Same mark as the release icon, on the "blueprint" background SarvTerminal
// uses for its debug build (see that repo's scripts/gen_icons.swift →
// drawDebug). The BACKGROUND is the build marker — no "DEV" badge — so a dev
// window and a release window are one glance apart in the Dock/taskbar, where
// two white squircles were indistinguishable.
//
// Rendered by Electron (already a dev dependency) rather than a new native
// image toolchain: Chromium rasterises public/icon.svg exactly as the app
// itself would, and the generated PNG is committed, so nobody needs to run
// this to build or run the app.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_MARK = join(DESKTOP_ROOT, 'public', 'icon.svg');
const OUTPUT = join(DESKTOP_ROOT, 'public', 'icon-dev.png');
const SIZE = 1024;

// The mark is drawn as a white schematic silhouette, the way SarvTerminal
// draws its debug logo. Full colour was tried first and fails the only test
// that matters: the mark's own blue (#2F5FAC) is invisible against a blue
// ground at Dock size. Set this to false to keep the brand colours.
const SCHEMATIC_MARK = true;

/** Apple's icon grid: an 824/1024 rounded square centred on the canvas. */
const INSET = (SIZE * 100) / 1024;
const RADIUS = (SIZE * 185) / 1024;

/** Drafting grid: 32 divisions, every 4th line heavier. */
const gridLines = () => {
  const step = SIZE / 32;
  const lines = [];
  for (let i = 1; i < 32; i += 1) {
    const at = (i * step).toFixed(2);
    const opacity = i % 4 === 0 ? 0.22 : 0.1;
    lines.push(`<path d="M${at} 0V${SIZE}" stroke="#fff" stroke-opacity="${opacity}" stroke-width="1"/>`);
    lines.push(`<path d="M0 ${at}H${SIZE}" stroke="#fff" stroke-opacity="${opacity}" stroke-width="1"/>`);
  }
  return lines.join('');
};

/** Construction ticks: a crosshair at the four cardinal points of the circle. */
const crosshair = (radius) => {
  const mid = SIZE / 2;
  const tick = SIZE * 0.045;
  return [
    `M${mid - radius - tick} ${mid}H${mid - radius + tick}`,
    `M${mid + radius - tick} ${mid}H${mid + radius + tick}`,
    `M${mid} ${mid - radius - tick}V${mid - radius + tick}`,
    `M${mid} ${mid + radius - tick}V${mid + radius + tick}`,
  ].join('');
};

const buildSvg = () => {
  const mark = readFileSync(SOURCE_MARK).toString('base64');
  const markBox = SIZE * 0.64;
  const markOrigin = (SIZE - markBox) / 2;
  const circleRadius = SIZE * 0.36;
  const frameInset = SIZE * 0.165;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="blueprint" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#427AF5"/>
      <stop offset="1" stop-color="#2454D9"/>
    </linearGradient>
    <clipPath id="squircle">
      <rect x="${INSET}" y="${INSET}" width="${SIZE - 2 * INSET}" height="${SIZE - 2 * INSET}" rx="${RADIUS}" ry="${RADIUS}"/>
    </clipPath>
    <!-- Flatten every colour to white, keeping the alpha silhouette. -->
    <filter id="schematic" x="0" y="0" width="100%" height="100%">
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0"/>
    </filter>
  </defs>
  <g clip-path="url(#squircle)">
    <rect width="${SIZE}" height="${SIZE}" fill="url(#blueprint)"/>
    <!-- No paper-grain layer: the speckle SarvTerminal draws is invisible at
         Dock size and costs ~600KB of incompressible noise in the PNG. -->
    ${gridLines()}
    <!-- Drafting frame. -->
    <rect x="${frameInset}" y="${frameInset}" width="${SIZE - 2 * frameInset}" height="${SIZE - 2 * frameInset}"
          rx="${SIZE * 0.09}" ry="${SIZE * 0.09}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="${SIZE / 340}"/>
    <!-- Construction lines: the dashed circle + crosshair of a part drawing. -->
    <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${circleRadius}" fill="none" stroke="#fff" stroke-opacity="0.45"
            stroke-width="${SIZE / 512}" stroke-dasharray="${SIZE / 64} ${SIZE / 96}"/>
    <path d="${crosshair(circleRadius)}" stroke="#fff" stroke-opacity="0.45" stroke-width="${SIZE / 512}"/>
    <!-- The product mark itself: same logo, different ground. -->
    <image x="${markOrigin}" y="${markOrigin}" width="${markBox}" height="${markBox}"
           ${SCHEMATIC_MARK ? 'filter="url(#schematic)"' : ''} href="data:image/svg+xml;base64,${mark}"/>
  </g>
</svg>`;
};

const render = async () => {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}</style>
<canvas id="out" width="${SIZE}" height="${SIZE}"></canvas>`;

  const window = new BrowserWindow({ width: SIZE, height: SIZE, show: false });
  try {
    await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    // Drawn into a canvas and exported with toDataURL rather than captured
    // with capturePage(): a page capture composites onto the window's opaque
    // background, which turns the squircle's transparent corners BLACK and
    // gives the Dock a black-cornered tile.
    const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(buildSvg()).toString('base64')}`;
    const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.getElementById('out');
        canvas.getContext('2d').drawImage(image, 0, 0, ${SIZE}, ${SIZE});
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('the icon SVG failed to decode'));
      image.src = ${JSON.stringify(svgDataUrl)};
    })`);
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (png.length === 0) throw new Error('the canvas exported an empty PNG');
    writeFileSync(OUTPUT, png);
    console.log(`wrote ${OUTPUT} (${SIZE}px, ${(png.length / 1024).toFixed(0)}KB)`);
  } finally {
    window.destroy();
  }
};

app.whenReady()
  .then(render)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('[gen-dev-icon] failed:', error);
    app.exit(1);
  });
