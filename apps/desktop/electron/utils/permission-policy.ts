/**
 * Which web permissions anything in the app's session may have (CASA L-2).
 *
 * With no handler installed, Electron grants every request: measured on
 * Electron 44, a page in the window got the microphone, clipboard READ and
 * notifications, and a subframe got notifications, all without a prompt. The
 * email body cannot run script, but extension panels (sarv-extension: frames)
 * can, and so can whatever a future change lets in.
 *
 * The app itself needs two: writing to the clipboard (copy buttons) and
 * fullscreen (the attachment viewer's video player). Both are granted only to
 * the app's own top-level frame on the app URL; everything else is denied —
 * other permissions, other frames, other origins.
 */
import { isAppUrl } from './navigation-policy';

const APP_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);

/** Whether `permission` may be granted to the frame at `requestingUrl`. Fails closed. */
export function isPermissionAllowed(
  permission: string,
  requestingUrl: string | null | undefined,
  isMainFrame: boolean | null | undefined,
  appUrl: string,
): boolean {
  try {
    return APP_PERMISSIONS.has(permission)
      && isMainFrame === true
      && typeof requestingUrl === 'string'
      && isAppUrl(requestingUrl, appUrl);
  } catch {
    return false;
  }
}

/** The parts of an Electron session the policy installs on. */
export interface PermissionSessionLike {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void, details: { requestingUrl?: string; isMainFrame?: boolean }) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (webContents: unknown, permission: string, requestingOrigin: string, details: { requestingUrl?: string; isMainFrame?: boolean }) => boolean,
  ): void;
  setDevicePermissionHandler(handler: () => boolean): void;
}

/**
 * Install the policy on `session`: permission requests, synchronous permission
 * checks (navigator.permissions, Chromium's own checks) and device access
 * (HID/USB/serial — never used) all answer from it. A denied request is
 * reported once per permission and origin.
 */
export function installPermissionPolicy(
  session: PermissionSessionLike,
  appUrl: string,
  deps: { onDenied?(permission: string, url: string): void } = {},
): void {
  const reported = new Set<string>();
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const url = details?.requestingUrl;
    const granted = isPermissionAllowed(permission, url, details?.isMainFrame, appUrl);
    if (!granted) {
      let origin = '(unknown)';
      try {
        // file: and custom schemes have an opaque origin ("null"): say what they are.
        if (url) { const u = new URL(url); origin = u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`; }
      } catch { /* unparseable: keep unknown */ }
      const key = `${permission} ${origin}`;
      if (!reported.has(key)) {
        reported.add(key);
        deps.onDenied?.(permission, origin);
      }
    }
    callback(granted);
  });
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    isPermissionAllowed(permission, details?.requestingUrl ?? requestingOrigin, details?.isMainFrame, appUrl));
  session.setDevicePermissionHandler(() => false);
}
