import type { AvailablePanel } from '@sarvinbox/core';
import { PANEL_BRIDGE_CHANNEL, parsePanelRequest } from '@sarvinbox/core/panel-bridge';
import { useCallback, useEffect, useRef } from 'react';

/**
 * One extension panel, in a sandboxed iframe.
 *
 * The page comes from `sarv-extension://<extension-id>/...`, which gives every
 * extension its own origin — same-origin policy is what keeps one extension's
 * panel out of another's storage and out of the app's. The page is served under
 * a CSP with `default-src 'none'` and no outbound `connect-src`, so a panel
 * cannot send the message it was shown anywhere.
 *
 * This component relays and nothing more. It does NOT decide what a panel is
 * allowed to do: every request goes to main, is re-validated there, and is
 * checked against the permissions the user actually granted. The renderer holds
 * the open message and the frame itself, so treating it as the arbiter would
 * mean a panel that could talk its own host into an answer had bypassed the
 * permission model entirely.
 *
 * `allow-same-origin` is present and is deliberate: without it the frame gets
 * an opaque origin, its own `'self'` matches nothing, and the CSP would block
 * the panel's own script. With it, "same origin" means the extension's own
 * folder — not the app's.
 */

interface ExtensionPanelFrameProps {
  available: AvailablePanel;
  /** Id of the message the reader has open, or undefined when none is. */
  currentMessageId?: string;
  /** The panel asked to close itself. */
  onRequestClose?: () => void;
  className?: string;
}

export function ExtensionPanelFrame({
  available,
  currentMessageId,
  onRequestClose,
  className,
}: ExtensionPanelFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Read inside the listener rather than captured, so a reply always describes
  // the message that is open NOW, not the one that was open when the listener
  // was attached.
  const messageIdRef = useRef(currentMessageId);
  messageIdRef.current = currentMessageId;

  const post = useCallback((payload: unknown) => {
    // '*' because a sandboxed frame's origin is not something the parent can
    // name; the frame is addressed directly, so nothing else receives this.
    frameRef.current?.contentWindow?.postMessage(payload, '*');
  }, []);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      // The ONLY identity check that means anything here: the message came from
      // this panel's own frame. Origin cannot be compared — a sandboxed frame
      // sends "null" — so the window reference is what ties a request to the
      // extension it will be attributed to.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;

      const request = parsePanelRequest(event.data);
      if (!request) return;

      // The two the app owns outright. Neither reaches main: there is nothing
      // there to ask, and the frame belongs to the renderer.
      if (request.method === 'panel.close') {
        onRequestClose?.();
        post({ channel: PANEL_BRIDGE_CHANNEL, requestId: request.requestId, ok: true });
        return;
      }
      if (request.method === 'panel.resize') {
        // Sidebar and modal panels are both sized by the app, so this is
        // acknowledged and ignored rather than silently dropped — a panel that
        // waits on the reply would otherwise hang.
        post({ channel: PANEL_BRIDGE_CHANNEL, requestId: request.requestId, ok: true });
        return;
      }

      const response = await window.electronAPI.extensions.panelRequest(
        available.extensionId,
        event.data,
        { currentMessageId: messageIdRef.current }
      );
      post({ channel: PANEL_BRIDGE_CHANNEL, ...response });
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [available.extensionId, onRequestClose, post]);

  // Tell the panel the reader moved to a different message, so it can refresh
  // without polling.
  useEffect(() => {
    post({
      channel: PANEL_BRIDGE_CHANNEL,
      event: 'message-changed',
      payload: { id: currentMessageId ?? null },
    });
  }, [currentMessageId, post]);

  return (
    <iframe
      ref={frameRef}
      src={available.url}
      title={available.panel.title}
      // No `allow-popups`, no `allow-top-navigation`, no `allow-modals`: a panel
      // cannot open a window, move the app off its own page, or block the UI
      // with a native dialog.
      sandbox="allow-scripts allow-same-origin allow-forms"
      referrerPolicy="no-referrer"
      className={className ?? 'w-full h-full border-0 bg-background'}
    />
  );
}
