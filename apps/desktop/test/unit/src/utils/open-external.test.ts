// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMailtoLink, openExternalLink, opensExternally } from '../../../../src/utils/open-external';

/**
 * The one rule for which links from a message leave the app, and the one way
 * they leave — shared by the standard view's framed body, the chat's link
 * clicks and the chat's right-click "Open link".
 *
 * What breaks if this file goes red: a link from a message goes somewhere the
 * app never meant to send it (an in-page jump handed to the browser, a
 * `mailto:` treated as a web page), or the views disagree about the same link
 * again — which is how a sender's `MAILTO:` took the web-link path in one view
 * and not the other.
 */

const openExternal = vi.fn(async (_url: string) => ({ success: true }));

afterEach(() => {
  openExternal.mockClear();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('isMailtoLink', () => {
  // Regression: a scheme is case-insensitive; the old lower-case-only check
  // called `MAILTO:` a web link.
  it.each([
    ['mailto:bob@acme.example', true],
    ['MAILTO:bob@acme.example', true],
    ['Mailto:bob@acme.example', true],
    ['https://example.test/mailto:', false],
    ['', false],
  ])('%s → %s', (url, expected) => {
    expect(isMailtoLink(url)).toBe(expected);
  });
});

describe('opensExternally', () => {
  it.each([
    ['https://example.test', true],
    ['http://example.test', true],
    ['', false],
    ['#top', false],
    ['mailto:bob@acme.example', false],
    // Regression: the lower-case check let this through as a web link.
    ['MAILTO:bob@acme.example', false],
  ])('%s → %s', (url, expected) => {
    expect(opensExternally(url)).toBe(expected);
  });
});

describe('openExternalLink', () => {
  // The feature: a web link goes to the system browser through the app.
  it('opens a web link through the app in Electron', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { app: { openExternal } };
    expect(openExternalLink('https://example.test/plan')).toBe(true);
    expect(openExternal.mock.calls).toEqual([['https://example.test/plan']]);
  });

  // Outside Electron (the web build, a test page): a new browser tab.
  it('opens a new tab outside Electron', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(openExternalLink('https://example.test/plan')).toBe(true);
    expect(open.mock.calls).toEqual([['https://example.test/plan', '_blank']]);
  });

  // Regression guard: a refused link opens nothing on either path — no IPC
  // call, no tab — whatever case its scheme is written in.
  it.each(['MAILTO:bob@acme.example', 'mailto:bob@acme.example', '#section-2', ''])(
    'opens nothing for %s',
    (url) => {
      (window as unknown as { electronAPI: unknown }).electronAPI = { app: { openExternal } };
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      expect(openExternalLink(url)).toBe(false);
      expect(openExternal).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );
});
