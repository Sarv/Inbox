import { describe, expect, it, vi } from 'vitest';

import { installPermissionPolicy, isPermissionAllowed, type PermissionSessionLike } from '../../../../electron/utils/permission-policy';

/**
 * Web permissions in the app's session (CASA L-2). With no handler Electron
 * grants everything — measured on Electron 44: the microphone, clipboard READ
 * and notifications, to any frame. What breaks if this file fails: an
 * extension panel (or anything else that gets script into a frame) reads the
 * clipboard or the microphone; or the app's own copy buttons and video
 * fullscreen stop working. The allow/deny outcome below was also run against
 * real Electron 44 in a scratch harness.
 */

const APP_URL = 'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html';

describe('isPermissionAllowed', () => {
  it('grants the app window\'s top frame clipboard write and fullscreen', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', APP_URL, true, APP_URL)).toBe(true);
    expect(isPermissionAllowed('fullscreen', `${APP_URL}?t=1#x`, true, APP_URL)).toBe(true);
  });

  it.each(['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal', 'midi', 'pointerLock', 'automatic-fullscreen', 'unknown'])(
    'denies %s even to the app itself',
    (permission) => {
      expect(isPermissionAllowed(permission, APP_URL, true, APP_URL)).toBe(false);
    },
  );

  // Breaks: an extension panel or an email frame gets clipboard write or
  // fullscreen (a full-screen phishing page over the app).
  it.each([
    ['a subframe on the app URL', APP_URL, false],
    ['an extension panel', 'sarv-extension://ext/panel.html', false],
    ['the main frame on another file', 'file:///tmp/evil.html', true],
    ['the main frame on a remote page', 'https://evil.example/', true],
    ['an unknown frame position', APP_URL, undefined],
    ['no URL', undefined, true],
    ['an unparseable URL', 'not a url', true],
  ])('denies %s', (_label, url, isMainFrame) => {
    expect(isPermissionAllowed('clipboard-sanitized-write', url as string | undefined, isMainFrame as boolean | undefined, APP_URL)).toBe(false);
  });

  it('matches the dev server by origin', () => {
    expect(isPermissionAllowed('fullscreen', 'http://localhost:5173/?t=3', true, 'http://localhost:5173')).toBe(true);
    expect(isPermissionAllowed('fullscreen', 'http://localhost:5173.evil.example/', true, 'http://localhost:5173')).toBe(false);
  });
});

function fakeSession() {
  const s = {
    request: undefined as Parameters<PermissionSessionLike['setPermissionRequestHandler']>[0] | undefined,
    check: undefined as Parameters<PermissionSessionLike['setPermissionCheckHandler']>[0] | undefined,
    device: undefined as (() => boolean) | undefined,
  };
  const session: PermissionSessionLike = {
    setPermissionRequestHandler: (h) => { s.request = h; },
    setPermissionCheckHandler: (h) => { s.check = h; },
    setDevicePermissionHandler: (h) => { s.device = h; },
  };
  return { session, s };
}

describe('installPermissionPolicy', () => {
  // Breaks: a request handler that is never installed (or never answers) —
  // the default grants everything, or the page waits forever.
  it('answers every request from the policy, and reports a denial once per permission and origin', () => {
    const { session, s } = fakeSession();
    const onDenied = vi.fn();
    installPermissionPolicy(session, APP_URL, { onDenied });
    const answer = (permission: string, requestingUrl: string, isMainFrame: boolean) => {
      const callback = vi.fn();
      s.request!({}, permission, callback, { requestingUrl, isMainFrame });
      return callback.mock.calls[0][0];
    };
    expect(answer('clipboard-sanitized-write', APP_URL, true)).toBe(true);
    expect(answer('media', APP_URL, true)).toBe(false);
    expect(answer('media', `${APP_URL}?again`, true)).toBe(false);
    expect(answer('notifications', 'sarv-extension://ext/panel.html', false)).toBe(false);
    expect(onDenied.mock.calls).toEqual([['media', 'file://'], ['notifications', 'sarv-extension://ext']]);
  });

  // navigator.permissions.query and Chromium's own synchronous checks.
  // Breaks: a check reports "granted" for something the request would deny,
  // or the app's own clipboard check is denied (copy buttons fail).
  it('answers permission checks the same way, from the requesting URL or else the origin', () => {
    const { session, s } = fakeSession();
    installPermissionPolicy(session, APP_URL);
    expect(s.check!({}, 'clipboard-sanitized-write', 'file:///', { requestingUrl: APP_URL, isMainFrame: true })).toBe(true);
    expect(s.check!({}, 'media', 'file:///', { requestingUrl: APP_URL, isMainFrame: true })).toBe(false);
    expect(s.check!({}, 'clipboard-sanitized-write', 'file:///', { isMainFrame: true })).toBe(false);
  });

  it('refuses device access (HID/USB/serial), which nothing uses', () => {
    const { session, s } = fakeSession();
    installPermissionPolicy(session, APP_URL);
    expect(s.device!()).toBe(false);
  });
});
