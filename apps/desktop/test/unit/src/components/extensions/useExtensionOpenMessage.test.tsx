// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useExtensionOpenMessage } from '../../../../../src/components/extensions/useExtensionOpenMessage';
import { act, render } from '../../../../helpers/render';

/**
 * `ctx.ui.openMessage(...)` reaching the mail view.
 *
 * What breaks if this file goes red: an extension can say "show them this one"
 * and nothing happens — the card's own "Open the message" link still works, so
 * the failure looks like a broken extension rather than a broken host. The
 * subscription also has to be torn down: a second listener means one request
 * navigates twice, which on a cross-account open races the account switch.
 */

const h = vi.hoisted(() => ({
  opened: [] as Array<{ emailId: string; accountId?: string }>,
}));

vi.mock('../../../../../src/utils/open-email-from-notification', () => ({
  openEmailFromNotification: (emailId: string, accountId?: string) => {
    h.opened.push({ emailId, accountId });
  },
}));

let send: ((payload: { emailId: string; accountId?: string }) => void) | null = null;
let unsubscribed = 0;
let mounted: ReturnType<typeof render> | null = null;

function Probe() {
  useExtensionOpenMessage();
  return null;
}

beforeEach(() => {
  h.opened.length = 0;
  send = null;
  unsubscribed = 0;
  (window as any).electronAPI = {
    extensions: {
      onOpenMessage: (callback: (payload: { emailId: string; accountId?: string }) => void) => {
        send = callback;
        return () => {
          unsubscribed += 1;
        };
      },
    },
  };
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  delete (window as any).electronAPI;
});

describe('useExtensionOpenMessage', () => {
  it('opens the message an extension names, in its own account', () => {
    mounted = render(<Probe />);

    act(() => {
      send?.({ emailId: 'email-1', accountId: 'account-2' });
    });

    expect(h.opened).toEqual([{ emailId: 'email-1', accountId: 'account-2' }]);
  });

  // The account is optional — an extension acting on a card it raised itself
  // only ever saw an email id.
  it('opens a message with no account named', () => {
    mounted = render(<Probe />);

    act(() => {
      send?.({ emailId: 'email-1' });
    });

    expect(h.opened).toEqual([{ emailId: 'email-1', accountId: undefined }]);
  });

  it('unsubscribes on unmount', () => {
    mounted = render(<Probe />);
    mounted.unmount();
    mounted = null;

    expect(unsubscribed).toBe(1);
  });

  // An older preload has no channel; the hook must be inert, not throw during
  // the first render of the whole app.
  it('does nothing when the host offers no open-message channel', () => {
    (window as any).electronAPI = { extensions: {} };

    expect(() => {
      mounted = render(<Probe />);
      mounted.unmount();
      mounted = null;
    }).not.toThrow();
  });

  it('does nothing when there is no electron API at all', () => {
    delete (window as any).electronAPI;

    expect(() => {
      mounted = render(<Probe />);
      mounted.unmount();
      mounted = null;
    }).not.toThrow();
  });
});
