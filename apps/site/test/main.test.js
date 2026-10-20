// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import iconSvg from '../../desktop/public/icon.svg?raw';
import { readClientHints, showAppIcon, start } from '../src/main.js';

import { UA, releaseV122 } from './fixtures.js';

const fakeWindow = ({ userAgent = UA.macSafari, userAgentData, fetchImpl } = {}) => ({
  document,
  navigator: { userAgent, maxTouchPoints: 0, userAgentData },
  fetch: fetchImpl ?? vi.fn(async () => ({ ok: true, json: async () => releaseV122() })),
});

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML =
    '<img data-app-icon alt="" /><img data-product-image alt="" /><div id="app"></div>';
});

const DATA_SVG = 'data:image/svg+xml,';
const parseDataSvg = (url) =>
  new DOMParser().parseFromString(decodeURIComponent(url.slice(DATA_SVG.length)), 'image/svg+xml')
    .documentElement;

describe('showAppIcon', () => {
  // Breaks if the header logo renders as a broken image, or the tab loses its favicon.
  it('sets the header image to the plain icon and adds an SVG favicon', () => {
    showAppIcon(document, iconSvg);
    const headerSrc = document.querySelector('[data-app-icon]').getAttribute('src');
    expect(headerSrc.startsWith(DATA_SVG)).toBe(true);
    const header = parseDataSvg(headerSrc);
    expect(header.getAttribute('viewBox')).toBe('0 0 551.21 551.21');
    expect(header.querySelectorAll('path').length).toBeGreaterThan(1);
    // The provenance blob is dropped: it is most of the file and draws nothing.
    expect(header.querySelector('metadata')).toBeNull();
    const favicon = document.head.querySelector('link[rel="icon"]');
    expect(favicon.getAttribute('type')).toBe('image/svg+xml');
    expect(favicon.getAttribute('href').startsWith(DATA_SVG)).toBe(true);
  });

  // Breaks if the tab icon loses its white disc and the logo vanishes on a dark tab bar.
  it('puts the real logo on a white disc for the favicon', () => {
    showAppIcon(document, iconSvg);
    const favicon = parseDataSvg(
      document.head.querySelector('link[rel="icon"]').getAttribute('href')
    );
    expect(favicon.getAttribute('viewBox')).toBe('0 0 64 64');
    const [disc, logo] = favicon.children;
    expect(disc.tagName).toBe('circle');
    expect(disc.getAttribute('fill')).toBe('white');
    expect(disc.getAttribute('r')).toBe('32');
    // The logo sits inside the disc, centred, with its paths intact.
    expect(logo.tagName).toBe('svg');
    expect(Number(logo.getAttribute('x')) + Number(logo.getAttribute('width'))).toBeLessThan(64);
    expect(Number(logo.getAttribute('x'))).toBe(Number(logo.getAttribute('y')));
    expect(logo.querySelectorAll('path').length).toBeGreaterThan(1);
    expect(logo.querySelector('metadata')).toBeNull();
  });
});

describe('readClientHints', () => {
  // Breaks if Chromium's architecture hint is no longer requested.
  it('asks for architecture and bitness', async () => {
    const getHighEntropyValues = vi.fn(async () => ({ architecture: 'arm', bitness: '64' }));
    expect(await readClientHints({ userAgentData: { getHighEntropyValues } })).toEqual({
      architecture: 'arm',
      bitness: '64',
    });
    expect(getHighEntropyValues).toHaveBeenCalledWith(['architecture', 'bitness']);
  });

  // Breaks if Safari/Firefox (no userAgentData) or a refused request throws.
  it('null when unsupported or refused', async () => {
    expect(await readClientHints({})).toBeNull();
    const refused = {
      userAgentData: { getHighEntropyValues: vi.fn().mockRejectedValue(new Error('NotAllowed')) },
    };
    expect(await readClientHints(refused)).toBeNull();
  });
});

describe('start', () => {
  // Breaks if the wiring between detection, the latest release and rendering comes apart.
  it('renders the latest release for the detected device', async () => {
    const win = fakeWindow({ userAgent: UA.linuxArmFirefox });
    await start(win);
    expect(win.fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-app-icon]').getAttribute('src')).toMatch(
      /^data:image\/svg\+xml,/
    );
    expect(document.querySelector('[data-product-image]').getAttribute('src')).toMatch(
      /screenshot-inbox\.png/
    );
    expect(document.querySelector('.download-choice h3').textContent).toBe('Linux download');
    expect(document.querySelector('a.btn-primary').getAttribute('href')).toContain(
      'sarv-inbox-1.2.2-arm64.AppImage'
    );
  });

  // Breaks if client hints stop overriding the frozen Windows user agent end to end.
  it('uses client hints when the browser has them', async () => {
    const userAgentData = {
      getHighEntropyValues: async () => ({ architecture: 'arm', bitness: '64' }),
    };
    await start(fakeWindow({ userAgent: UA.linuxNoArch, userAgentData }));
    expect(document.querySelector('a.btn-primary').getAttribute('href')).toContain(
      'arm64.AppImage'
    );
  });

  // Breaks if a failed fetch leaves the page blank.
  it('falls back to the latest release link when GitHub fails', async () => {
    await start(fakeWindow({ fetchImpl: vi.fn().mockRejectedValue(new TypeError('offline')) }));
    expect(document.querySelector('.banner').textContent).toContain("Couldn't reach GitHub");
  });
});
