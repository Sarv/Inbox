// @vitest-environment happy-dom
// The helper dispatches a real DOM CustomEvent — the "go to Mail first" half of
// its job — so this file needs a document.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Opening a message from a notification. Pinned behaviour, because three
 * surfaces share this one helper (the native-notification bridge, the in-app
 * toast, and an extension's notification card) and a click that half-works is
 * indistinguishable from a click that did nothing:
 *   - the Mail view is entered BEFORE the email is selected,
 *   - the account is switched before selecting when the mail is another one's,
 *   - the selection still happens if that switch rejects.
 */

const h = vi.hoisted(() => ({
  state: null as any,
}));

vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: { getState: () => h.state },
}));

import { openEmailFromNotification } from '../../../../src/utils/open-email-from-notification';

/** The switch/select handoff runs through a promise chain, so drain the loop. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let order: string[];

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    activeAccountId: 'account-1',
    selectEmail: vi.fn((id: string) => {
      order.push(`select:${id}`);
    }),
    selectAccount: vi.fn(async (id: string) => {
      order.push(`switch:${id}`);
    }),
    ...overrides,
  };
}

let openMailEvents: number;
const countOpenMail = () => {
  openMailEvents += 1;
  order.push('open-mail');
};

beforeEach(() => {
  order = [];
  openMailEvents = 0;
  h.state = makeState();
  document.addEventListener('sarvinbox:open-mail', countOpenMail);
});

afterEach(() => {
  document.removeEventListener('sarvinbox:open-mail', countOpenMail);
});

describe('openEmailFromNotification', () => {
  it('enters the Mail view before selecting the message', async () => {
    // Regression: clicking a notification from Contacts or Settings selects the
    // mail in a list that is not on screen, so nothing appears to happen.
    openEmailFromNotification('email-1');
    await flush();

    expect(openMailEvents).toBe(1);
    expect(order).toEqual(['open-mail', 'select:email-1']);
  });

  it('does nothing at all without an email id', async () => {
    // Regression: a malformed card navigates the user away from where they were
    // and selects nothing.
    openEmailFromNotification('');

    expect(openMailEvents).toBe(0);
    expect(h.state.selectEmail).not.toHaveBeenCalled();
  });

  it('switches account BEFORE selecting when the mail belongs to another one', async () => {
    // Regression: selecting first targets the wrong account's list, and the
    // switch then clears the selection.
    openEmailFromNotification('email-1', 'account-2');
    await flush();

    expect(h.state.selectAccount).toHaveBeenCalledWith('account-2');
    expect(order).toEqual(['open-mail', 'switch:account-2', 'select:email-1']);
  });

  it('does not switch when the mail is already in the active account', async () => {
    // Regression: every notification click reloads the account it is already on.
    openEmailFromNotification('email-1', 'account-1');
    await flush();

    expect(h.state.selectAccount).not.toHaveBeenCalled();
    expect(h.state.selectEmail).toHaveBeenCalledWith('email-1');
  });

  it('still selects the message when the account switch rejects', async () => {
    // Regression: an account that fails to load (offline, locked DB) swallows
    // the click entirely instead of leaving the user on the message.
    h.state = makeState({
      selectAccount: vi.fn(async () => {
        throw new Error('account is locked');
      }),
    });

    openEmailFromNotification('email-1', 'account-2');
    await flush();

    expect(h.state.selectEmail).toHaveBeenCalledWith('email-1');
  });

  it('survives a store that cannot select yet', async () => {
    // Regression: a notification arriving before the list mounts throws inside a
    // click handler, where nothing catches it.
    h.state = makeState({
      selectEmail: vi.fn(() => {
        throw new Error('list not mounted');
      }),
    });

    expect(() => openEmailFromNotification('email-1')).not.toThrow();
  });

  it('selects directly when the store has no account switcher', async () => {
    // Regression: a single-account build has no selectAccount, and the helper
    // calls it anyway.
    h.state = makeState({ selectAccount: undefined });

    openEmailFromNotification('email-1', 'account-2');
    await flush();

    expect(h.state.selectEmail).toHaveBeenCalledWith('email-1');
  });
});
