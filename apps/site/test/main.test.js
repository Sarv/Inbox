// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readClientHints, showAppIcon, start } from '../src/main.js';

import { UA, releaseV122 } from './fixtures.js';

const fakeWindow = ({ userAgent = UA.macSafari, userAgentData, fetchImpl } = {}) => ({
  document,
  navigator: { userAgent, maxTouchPoints: 0, userAgentData },
  fetch: fetchImpl ?? vi.fn(async () => ({ ok: true, json: async () => releaseV122() })),
});

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '<img data-app-icon alt="" /><div id="app"></div>';
});

describe('showAppIcon', () => {
  // Breaks if the header logo renders as a broken image, or the tab loses its favicon.
  it('sets the header image and the favicon to the icon', () => {
    showAppIcon(document, '/assets/icon.svg');
    expect(document.querySelector('[data-app-icon]').getAttribute('src')).toBe('/assets/icon.svg');
    const favicon = document.head.querySelector('link[rel="icon"]');
    expect(favicon.getAttribute('href')).toBe('/assets/icon.svg');
    expect(favicon.getAttribute('type')).toBe('image/svg+xml');
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
    expect(document.querySelector('[data-app-icon]').getAttribute('src')).toMatch(/icon\.svg/);
    expect(document.querySelector('h1').textContent).toBe('Download Sarv Inbox for Linux');
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
