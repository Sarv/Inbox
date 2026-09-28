import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isTrustedSender,
  reloadTrustedSenders,
  resetTrustedSenders,
  trustSender,
  untrustSender,
} from '../../../../src/utils/trusted-senders';

/**
 * The renderer's copy of the trusted-sender list. The shield reads it
 * synchronously while a message renders, so it must hold the ACTIVE account's
 * list — and only that account's. A list left over from the previous account
 * would lift the warning off a sender this account never trusted.
 */

let lists: Record<string, Array<{ email: string; createdAt: number }>>;
let active: string;

beforeEach(() => {
  lists = { a: [{ email: 'alerts@axis.bank.in', createdAt: 1 }], b: [] };
  active = 'a';
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      spam: {
        listTrustedSenders: vi.fn(async () => ({ success: true, data: lists[active] })),
        trustSender: vi.fn(async (address: string) => {
          lists[active] = [{ email: address, createdAt: 2 }, ...lists[active]];
          return { success: true };
        }),
        untrustSender: vi.fn(async (address: string) => {
          lists[active] = lists[active].filter((s) => s.email !== address);
          return { success: true };
        }),
      },
    },
  };
});

afterEach(() => resetTrustedSenders());

describe('trusted-senders (renderer cache)', () => {
  it('answers from the loaded list, matching "Name <addr>" and case', async () => {
    await reloadTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(true);
    expect(isTrustedSender('Axis Bank <ALERTS@axis.bank.in>')).toBe(true);
    expect(isTrustedSender('offers@axis.bank.in')).toBe(false);
    expect(isTrustedSender(null)).toBe(false);
  });

  // Multi-account regression: switching accounts must drop the old list.
  it('forgets the previous account\'s list on reset', async () => {
    await reloadTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(true);
    active = 'b';
    resetTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(false);
    await reloadTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(false);
  });

  it('trusts and untrusts through the main process, and reflects both', async () => {
    await reloadTrustedSenders();
    expect(await trustSender('Bank <new@bank.example>')).toEqual({ success: true, error: undefined });
    expect(window.electronAPI.spam.trustSender).toHaveBeenCalledWith('new@bank.example', undefined);
    expect(isTrustedSender('new@bank.example')).toBe(true);

    await untrustSender('new@bank.example');
    expect(isTrustedSender('new@bank.example')).toBe(false);
  });

  // A blank address is refused before any IPC — nothing to trust.
  it('refuses a blank address', async () => {
    expect(await trustSender('  ')).toEqual({ success: false, error: 'No sender address to trust' });
    expect(window.electronAPI.spam.trustSender).not.toHaveBeenCalled();
  });

  // Transient failure: a thrown IPC comes back as a failure the banner can
  // show, and the list re-reads the truth (the sender was NOT stored).
  it('reports a thrown IPC as a failure and re-reads the truth', async () => {
    (window.electronAPI.spam.trustSender as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ipc gone'));
    const res = await trustSender('new@bank.example');
    expect(res).toEqual({ success: false, error: 'ipc gone' });
    expect(isTrustedSender('new@bank.example')).toBe(false);
  });
});
