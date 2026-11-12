/**
 * Installs the window's two navigation guards over the one decision in
 * navigation-policy.ts, so the wiring itself can be tested (main.ts cannot be).
 *
 * `will-navigate` asks for the top-level frame; `will-frame-navigate` asks for
 * EVERY frame, the top-level one included (Electron sets `isMainFrame`). The
 * frame guard therefore applies the top-level rules when the main frame is the
 * one navigating — otherwise its frame-only allowances (the attachment scheme,
 * the PDF plugin, extension panels) would be offered to the whole window.
 *
 * Both read the URL from the event object, as Electron documents it. The
 * positional `url` argument is deprecated for `will-navigate` and not typed at
 * all for `will-frame-navigate`; if it ever stopped arriving, the policy fails
 * closed and blocks.
 *
 * For a subframe the frame guard also passes where the navigation comes from:
 * the frame's current URL and the URL of the frame that started it. Only the
 * extension-panel rule reads them (see isPanelNavigationAllowed).
 */

import {
  classifyNavigation,
  type NavigationScope,
  type NavigationSource,
} from './navigation-policy';

/** The slice of a WebContents the guards need. */
export interface NavigationGuardTarget {
  on(event: 'will-navigate', listener: (event: GuardedNavigation) => void): unknown;
  on(event: 'will-frame-navigate', listener: (event: GuardedNavigation) => void): unknown;
}

/** The fields the guards read from Electron's navigation event. */
export interface GuardedNavigation {
  url: string;
  isMainFrame?: boolean;
  /** The frame being navigated (`will-frame-navigate` only). */
  frame?: { readonly url: string } | null;
  /** The frame that started the navigation, if one did (`will-frame-navigate` only). */
  initiator?: { readonly url: string } | null;
  preventDefault(): void;
}

export interface NavigationGuardDeps {
  openExternal: (url: string) => Promise<void>;
  warn: (message: string, ...args: unknown[]) => void;
}

/**
 * A WebFrameMain's URL, or undefined when there is none to read. Electron's
 * WebFrameMain getters throw once the frame is disposed, and a throw here would
 * escape the guard before preventDefault — the navigation would go ahead.
 */
function frameUrlOf(read: () => { readonly url: string } | null | undefined): string | undefined {
  try {
    const url = read()?.url;
    return typeof url === 'string' ? url : undefined;
  } catch {
    return undefined;
  }
}

function sourceOf(event: GuardedNavigation): NavigationSource {
  return {
    frameUrl: frameUrlOf(() => event.frame),
    initiatorUrl: frameUrlOf(() => event.initiator),
  };
}

/**
 * @param appUrl the dev server URL in development; in production the file URL
 *               of the bundled entry (see classifyNavigation)
 */
export function installNavigationGuards(
  contents: NavigationGuardTarget,
  appUrl: string,
  deps: NavigationGuardDeps,
): void {
  const apply = (event: GuardedNavigation, scope: NavigationScope) => {
    const url = event.url;
    const verdict = classifyNavigation(url, appUrl, scope, scope === 'frame' ? sourceOf(event) : {});
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external') {
      deps.openExternal(url).catch((err) => deps.warn('[Main] openExternal failed:', err));
    } else {
      deps.warn(`[Main] Blocked ${scope}-level navigation:`, url);
    }
  };

  contents.on('will-navigate', (event) => apply(event, 'top'));

  // Same rule for a navigation started INSIDE a frame. An email body's iframe
  // could otherwise navigate itself to a remote page, or — with an image-map
  // link the renderer's link rewriting does not cover — to a local HTML file,
  // and render it inside the inbox. The sandbox (`allow-same-origin
  // allow-popups`, no `allow-top-navigation`) stops it taking over the window
  // but not from replacing its own content. This is the backstop that markup
  // the renderer did not anticipate cannot get past.
  contents.on('will-frame-navigate', (event) => apply(event, event.isMainFrame ? 'top' : 'frame'));
}
