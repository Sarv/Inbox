/**
 * Extension UI backend — the bridge between `context.ui.notify()` inside an
 * extension and a card on screen.
 *
 * Everything an extension passes is untrusted input: an extension is third-party
 * code that a user installed, and nothing about being confined makes what it says
 * any more honest. So nothing here forwards a raw object to the renderer. Every card goes through
 * `sanitizeExtensionNotification`, which caps each string, drops malformed
 * fields, namespaces the id by extension, and returns null for a card that
 * cannot be rendered meaningfully — one bad extension can then waste its own
 * notification, but it cannot inject markup, occupy the screen with a megabyte
 * of title text, or dismiss another extension's card.
 *
 * Sends are fire-and-forget by design: `notify` is synchronous in the extension
 * API, and a card that arrives when no window is open is simply lost — the
 * information it carries (a code, a countdown) is worthless later anyway.
 */

import {
  createLogger,
  namespaceNotificationId,
  sanitizeExtensionNotification,
  type ExtensionUIBackend,
  type SanitizedExtensionNotification,
} from '@sarvinbox/core';

import { sendToWindow } from '../shared';

const logger = createLogger('extension-ui-backend');

/** Problem cards waiting for a window, by card id, so the same one is not told twice. */
const heldProblems = new Map<string, SanitizedExtensionNotification>();

/** Whether a card stack has asked yet, which is what says a push will reach one. */
let windowListening = false;

/**
 * Problem cards the window has not asked for yet.
 *
 * Extensions start before the window exists, and the card stack mounts later still,
 * so a push at that moment reaches nobody. An extension that stopped working at
 * launch is exactly what must not be lost that way. The window asks for these once
 * it is listening, which also empties them: a card shown once is not shown again.
 */
export function takeHeldProblems(): SanitizedExtensionNotification[] {
  windowListening = true;
  const held = Array.from(heldProblems.values());
  heldProblems.clear();
  return held;
}

/** The window went away, so until the next one asks, a push reaches nobody. */
export function noteWindowGone(): void {
  windowListening = false;
}

/** Renderer channel carrying a card to show (or replace, by id). */
export const EXTENSION_NOTIFY_CHANNEL = 'extensions:notify';

/** Renderer channel carrying the namespaced id of a card to take away. */
export const EXTENSION_DISMISS_CHANNEL = 'extensions:dismiss';

/** Renderer channel asking for one of an extension's own panels to be shown. */
export const EXTENSION_OPEN_PANEL_CHANNEL = 'extensions:openPanel';

/** Renderer channel asking for a message to be opened in the mail view. */
export const EXTENSION_OPEN_MESSAGE_CHANNEL = 'extensions:openMessage';

/**
 * Build the UI backend handed to `ExtensionManager`.
 *
 * `send` is injectable so the behaviour can be tested without an Electron
 * window; it defaults to the shared `sendToWindow`, which resolves the live
 * window on every call rather than holding a reference that goes stale across a
 * reload.
 */
export function createExtensionUIBackend(
  send: (channel: string, payload: unknown) => boolean = sendToWindow
): ExtensionUIBackend {
  return {
    notify(extensionId: string, notification: unknown): void {
      const card = sanitizeExtensionNotification(extensionId, notification);
      if (!card) {
        logger.warn(`Dropped an unrenderable notification from ${extensionId}`);
        return;
      }
      send(EXTENSION_NOTIFY_CHANNEL, card);
    },

    dismiss(extensionId: string, notificationId: string): void {
      const id = namespaceNotificationId(extensionId, notificationId);
      if (!id) return;
      send(EXTENSION_DISMISS_CHANNEL, { id, extensionId });
    },

    /**
     * Show one of the extension's own panels.
     *
     * The panel is checked against the extension's manifest before this is
     * reached, so an extension cannot raise another's panel. The renderer still
     * decides whether it CAN honour the request — a sidebar panel needs a
     * message open — because the alternative is an extension yanking the reader
     * out of whatever they were doing.
     */
    openPanel(extensionId: string, panelId: string): void {
      if (!extensionId || !panelId) return;
      send(EXTENSION_OPEN_PANEL_CHANNEL, { extensionId, panelId });
    },

    /**
     * Open a message in the mail view — the same navigation a notification
     * click performs, so an extension's "show me this one" behaves exactly like
     * the app's own.
     */
    openMessage(extensionId: string, emailId: string, accountId?: string): void {
      if (!emailId) return;
      logger.info(`Extension '${extensionId}' opened message ${emailId}`);
      send(EXTENSION_OPEN_MESSAGE_CHANNEL, { extensionId, emailId, accountId });
    },

    reportProblem(extensionId: string, notification: unknown): void {
      const card = sanitizeExtensionNotification(extensionId, notification);
      if (!card) return;
      // Held only if it has nowhere to go: one a live window has shown would otherwise
      // come back on its next reload, after the reader had dismissed it.
      const delivered = send(EXTENSION_NOTIFY_CHANNEL, card);
      if (!delivered || !windowListening) heldProblems.set(card.id, card);
    },
  };
}
