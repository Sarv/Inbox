// Entry point: the only module that touches `navigator`, `fetch`, `matchMedia`
// or the live document. Everything it calls is pure and tested on its own.
import './theme.css';
import './styles.css';

// Imported, not referenced from index.html: Vite resolves an import in dev and
// build alike, whereas a `../desktop/...` URL in the HTML became a broken image
// under the dev server. The desktop app's icon, not a second copy of it.
import appIconUrl from '../../desktop/public/icon.svg';

import { buildDownloadView } from './download-view.js';
import { fetchLatestRelease } from './latest-release.js';
import { detectPlatform } from './platform.js';
import { renderDownloadPage } from './render.js';

/** Points the header image at the app icon and adds it as the favicon. */
export const showAppIcon = (doc, iconUrl) => {
  doc.querySelectorAll('[data-app-icon]').forEach((image) => image.setAttribute('src', iconUrl));
  const favicon = doc.createElement('link');
  Object.entries({ rel: 'icon', type: 'image/svg+xml', href: iconUrl }).forEach(([name, value]) =>
    favicon.setAttribute(name, value)
  );
  doc.head.append(favicon);
};

// Chromium exposes the real CPU architecture only through high-entropy client
// hints; everywhere else there is none to read.
export const readClientHints = async (nav) => {
  try {
    return (await nav.userAgentData?.getHighEntropyValues(['architecture', 'bitness'])) ?? null;
  } catch {
    // The browser refused the hints; the user-agent string is the fallback.
    return null;
  }
};

export const start = async (win) => {
  showAppIcon(win.document, appIconUrl);
  const { navigator: nav } = win;
  const [hints, release] = await Promise.all([
    readClientHints(nav),
    fetchLatestRelease(win.fetch.bind(win)),
  ]);
  const platform = detectPlatform({
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    hints,
  });
  renderDownloadPage(
    win.document.getElementById('app'),
    buildDownloadView({ platform, release }),
    undefined
  );
};

if (typeof window !== 'undefined' && !import.meta.env?.VITEST) start(window);
