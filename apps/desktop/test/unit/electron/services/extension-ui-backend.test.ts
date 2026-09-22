import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Extension UI backend. Pinned behaviour:
 *   - a card an extension asks to show reaches the renderer on the notify
 *     channel, sanitised and with its id namespaced by extension,
 *   - a card that cannot be rendered is dropped with a warning instead of being
 *     forwarded raw,
 *   - a dismiss carries the SAME namespaced id the notify used, so an extension
 *     can take its own card away and cannot take away anyone else's,
 *   - nothing is sent for a dismiss whose id is unusable,
 *   - a panel request and a message-open request reach their own channels and
 *     carry the extension's id, so the renderer can tell whose request it is.
 */

const h = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>,
  warnings: [] as string[],
}));

// The real sanitiser, imported straight from core SRC: it is pure (no imports of
// its own), and a stub here would let the backend forward something the renderer
// cannot render while the test still passed.
vi.mock('@sarvinbox/core', async () => {
  const uiNotification = await import(
    '../../../../../../packages/core/src/extensions/ui-notification'
  );
  return {
    createLogger: () => ({
      info: () => {},
      warn: (...args: unknown[]) => {
        h.warnings.push(args.join(' '));
      },
      error: () => {},
      debug: () => {},
    }),
    sanitizeExtensionNotification: uiNotification.sanitizeExtensionNotification,
    namespaceNotificationId: uiNotification.namespaceNotificationId,
  };
});

// `sendToWindow` is the only thing this module touches from the Electron side.
vi.mock('../../../../electron/shared', () => ({
  sendToWindow: (channel: string, payload: unknown) => {
    h.sent.push({ channel, payload });
    return true;
  },
}));

import {
  EXTENSION_DISMISS_CHANNEL,
  EXTENSION_NOTIFY_CHANNEL,
  EXTENSION_OPEN_MESSAGE_CHANNEL,
  EXTENSION_OPEN_PANEL_CHANNEL,
  createExtensionUIBackend,
} from '../../../../electron/services/extension-ui-backend';

function makeBackend() {
  const sent: Array<{ channel: string; payload: any }> = [];
  const backend = createExtensionUIBackend((channel, payload) => {
    sent.push({ channel, payload });
    return true;
  });
  return { backend, sent };
}

beforeEach(() => {
  h.sent.length = 0;
  h.warnings.length = 0;
});

describe('createExtensionUIBackend - notify', () => {
  it('sends a sanitised card on the notify channel', () => {
    // Regression: the card never reaches the renderer, so every extension
    // notification silently does nothing.
    const { backend, sent } = makeBackend();

    backend.notify('otp-code', { id: 'code-1', title: 'Verification code' });

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(EXTENSION_NOTIFY_CHANNEL);
    expect(sent[0].payload.title).toBe('Verification code');
  });

  it('namespaces the card id by extension and records the extension', () => {
    // Regression: two extensions that both call their card 'code' replace and
    // dismiss each other's notifications.
    const { backend, sent } = makeBackend();

    backend.notify('otp-code', { id: 'code', title: 'A' });
    backend.notify('vip-scoring', { id: 'code', title: 'B' });

    expect(sent.map((entry) => entry.payload.id)).toEqual(['otp-code:code', 'vip-scoring:code']);
    expect(sent[0].payload.extensionId).toBe('otp-code');
  });

  it('drops an unrenderable card with a warning instead of forwarding it', () => {
    // Regression: a malformed object reaches the renderer raw, where it renders
    // as an untitled card that cannot be dismissed.
    const { backend, sent } = makeBackend();

    // Cast away the type: the point is what an extension written in plain
    // JavaScript can actually hand the backend at runtime.
    const send = backend.notify as (extensionId: string, notification: unknown) => void;
    send('otp-code', { id: 'code-1' }); // no title
    send('otp-code', { title: 'No id' });
    send('otp-code', null);
    send('otp-code', 'not an object');

    expect(sent).toHaveLength(0);
    expect(h.warnings).toHaveLength(4);
    expect(h.warnings[0]).toContain('otp-code');
  });

  it('caps the strings an extension supplies', () => {
    // Regression: an extension with a runaway string occupies the whole window.
    const { backend, sent } = makeBackend();

    backend.notify('otp-code', { id: 'c', title: 'T'.repeat(5_000), body: 'B'.repeat(5_000) });

    expect(sent[0].payload.title.length).toBeLessThanOrEqual(120);
    expect(sent[0].payload.body.length).toBeLessThanOrEqual(240);
  });

  it('defaults to sending through the shared window sender', () => {
    // Regression: the default sender is wired to something that no longer
    // exists, so the app ships a backend that only works in tests.
    const backend = createExtensionUIBackend();

    backend.notify('otp-code', { id: 'code-1', title: 'Verification code' });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].channel).toBe(EXTENSION_NOTIFY_CHANNEL);
  });
});

describe('createExtensionUIBackend - dismiss', () => {
  it('sends the same namespaced id the notify used', () => {
    // Regression: dismiss sends the raw id, so the renderer never finds the card
    // and it stays on screen until the app is restarted.
    const { backend, sent } = makeBackend();

    backend.notify('otp-code', { id: 'code-1', title: 'Verification code' });
    backend.dismiss('otp-code', 'code-1');

    expect(sent[1].channel).toBe(EXTENSION_DISMISS_CHANNEL);
    expect(sent[1].payload).toEqual({ id: 'otp-code:code-1', extensionId: 'otp-code' });
    expect(sent[1].payload.id).toBe(sent[0].payload.id);
  });

  it('sends nothing when the id is unusable', () => {
    // Regression: an empty id namespaces to a prefix that matches nothing, or
    // worse, to something the renderer treats as a wildcard.
    const { backend, sent } = makeBackend();

    backend.dismiss('otp-code', '');
    backend.dismiss('otp-code', '   ');
    backend.dismiss('', 'code-1');
    backend.dismiss('otp-code', undefined as unknown as string);

    expect(sent).toHaveLength(0);
  });
});

describe('openPanel', () => {
  // Regression: the renderer matches the request against the panels that
  // extension contributes. Dropping the extension id would let any panel id
  // raise any extension's panel.
  it('names the extension alongside the panel', () => {
    const { backend, sent } = makeBackend();

    backend.openPanel!('otp-code', 'codes');

    expect(sent).toEqual([
      { channel: EXTENSION_OPEN_PANEL_CHANNEL, payload: { extensionId: 'otp-code', panelId: 'codes' } },
    ]);
  });

  it('sends nothing without both ids', () => {
    const { backend, sent } = makeBackend();

    backend.openPanel!('otp-code', '');
    backend.openPanel!('', 'codes');

    expect(sent).toHaveLength(0);
  });
});

describe('openMessage', () => {
  // Regression: this is an extension moving the reader somewhere they did not
  // ask to go, so it is logged by extension id — the log is the only record of
  // which extension took over the view.
  it('carries the message and its account, and logs who asked', () => {
    const { backend, sent } = makeBackend();

    backend.openMessage!('otp-code', 'email-1', 'account-1');

    expect(sent).toEqual([
      {
        channel: EXTENSION_OPEN_MESSAGE_CHANNEL,
        payload: { extensionId: 'otp-code', emailId: 'email-1', accountId: 'account-1' },
      },
    ]);
  });

  // The account is optional: an extension that only ever saw an email id from a
  // notification card should not have to invent one.
  it('works without an account id', () => {
    const { backend, sent } = makeBackend();

    backend.openMessage!('otp-code', 'email-1');

    expect(sent[0].payload).toEqual({
      extensionId: 'otp-code',
      emailId: 'email-1',
      accountId: undefined,
    });
  });

  it('sends nothing without a message id', () => {
    const { backend, sent } = makeBackend();

    backend.openMessage!('otp-code', '');

    expect(sent).toHaveLength(0);
  });
});
