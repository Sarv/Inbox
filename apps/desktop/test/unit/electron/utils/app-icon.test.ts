import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect } from 'vitest';

import { resolveAppIconPath } from '../../../../electron/utils/app-icon';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('resolveAppIconPath', () => {
  // Breaks: the dock/taskbar falls back to the stock Electron atom in dev. The
  // main-process bundle runs from dist-electron/, so the icon sits one level up
  // in public/ — not beside __dirname.
  it('points at public/icon.png in dev', () => {
    expect(resolveAppIconPath('/app/dist-electron', true)).toBe(join('/app', 'public', 'icon.png'));
  });

  // Breaks: the packaged app shows no dock icon. Vite copies public/ into dist/,
  // and dist/** is all electron-builder packages, so production must read dist/.
  it('points at dist/icon.png when packaged', () => {
    expect(resolveAppIconPath('/app/dist-electron', false)).toBe(join('/app', 'dist', 'icon.png'));
  });

  // Breaks: the icon silently disappears in production. build/ is a SOURCE dir
  // consumed by electron-builder at pack time and is absent from `build.files`,
  // so anything resolved there exists in dev and vanishes once packaged — the
  // failure mode that made the non-darwin window icon dead on arrival.
  it.each([true, false])('never resolves into build/ (isDev=%s)', (isDev) => {
    expect(resolveAppIconPath('/app/dist-electron', isDev)).not.toContain(
      `${join('/app', 'build')}`
    );
  });
});

describe('branded icon assets', () => {
  // Breaks: `app.dock.setIcon()` throws on a missing file (swallowed by its
  // try/catch) and the app quietly keeps the Electron atom. The dev path is the
  // one resolveAppIconPath() returns for isDev, so assert the real file.
  it('ships the PNG the dock resolves in dev', () => {
    expect(existsSync(join(DESKTOP_ROOT, 'public', 'icon.png'))).toBe(true);
  });

  // Breaks: the square mark used as the window/favicon mark, and now as the app
  // rail's button, goes missing and the renderer requests a 404.
  it('ships the square mark as SVG', () => {
    expect(existsSync(join(DESKTOP_ROOT, 'public', 'icon.svg'))).toBe(true);
  });

  // Breaks: the sidebar header renders a broken image. Both chrome components
  // reference their asset as a bare './name.ext' relative to public/, so a
  // rename that updates one side only fails silently in the UI and nowhere
  // else — Vite copies public/ verbatim and never resolves these strings.
  it.each([
    ['AppSidebar.tsx', 'src/components/AppSidebar.tsx'],
    ['Sidebar.tsx', 'src/components/Sidebar.tsx'],
  ])('resolves every public/ asset %s references', (_name, rel) => {
    const source = readFileSync(join(DESKTOP_ROOT, rel), 'utf8');
    const referenced = [...source.matchAll(/'\.\/([\w.-]+\.(?:svg|png))'/g)].map((m) => m[1]);

    expect(referenced.length).toBeGreaterThan(0);
    for (const asset of referenced) {
      expect(existsSync(join(DESKTOP_ROOT, 'public', asset)), `public/${asset} is missing`).toBe(
        true
      );
    }
  });

  // Breaks: the medallion shows twice in a row — once in the app rail, once
  // inside the sidebar lockup — which reads as a rendering bug. The wordmark is
  // text only; #2F5FAC is the mark's blue and appears in no glyph.
  it.each(['wordmark.svg', 'wordmark-dark.svg'])('ships %s with no mark baked in', (file) => {
    const wordmark = readFileSync(join(DESKTOP_ROOT, 'public', file), 'utf8');

    expect(wordmark).not.toContain('#2F5FAC');
    expect(wordmark).not.toContain('<image');
  });

  // Breaks: the "Sarv" half of the wordmark goes invisible in one theme — solid
  // black on the dark card, or near-white on the light one. The two files must
  // stay byte-identical apart from that one fill, so a future edit to the
  // glyphs cannot land in one theme and silently skip the other.
  it('keeps the light and dark wordmarks identical but for the foreground fill', () => {
    const read = (file: string) => readFileSync(join(DESKTOP_ROOT, 'public', file), 'utf8');

    expect(read('wordmark.svg')).toContain('fill="#000"');
    expect(read('wordmark-dark.svg')).toContain('fill="#F8FAFC"');
    expect(read('wordmark-dark.svg').replace('fill="#F8FAFC"', 'fill="#000"')).toBe(
      read('wordmark.svg')
    );
  });

  // Breaks: a release builds with the stock Electron icon. electron-builder
  // resolves these three paths at pack time — mac from icon.icns, win and linux
  // from icon.png — and a missing file is NOT a build error, it silently falls
  // back. `build/icon.png` was absent for exactly this reason.
  it('ships every icon electron-builder declares', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8'));
    const declared = [pkg.build.mac.icon, pkg.build.win.icon, pkg.build.linux.icon];

    expect(declared).toEqual(['build/icon.icns', 'build/icon.png', 'build/icon.png']);
    for (const rel of declared) {
      expect(existsSync(join(DESKTOP_ROOT, rel)), `${rel} is missing`).toBe(true);
    }
  });
});
