import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The slice reaches `../helpers`, and through it the category badge cache and
// the IPC bridge. Nothing under test here needs any of it.
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
  applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []),
  warmCategoryDefs: vi.fn(),
}));

import { createComposeSlice } from '../../../../../src/store/slices/compose-slice';

// What breaks if this suite goes red: "send later". A scheduled mail that takes
// the immediate path goes out NOW (the thing the user deliberately delayed); a
// failed schedule that still deletes the draft loses the message outright. Both
// are silent — the composer closes either way.

const SEND_AT = 1_800_000_000; // a fixed UTC epoch in seconds

const makeSlice = () => {
  let state: Record<string, any> = {
    imapConfig: { username: 'me@example.com' },
    smtpConnected: true,
    threadEmails: [],
    emails: [],
    accounts: [],
    activeAccountId: 'acct-1',
    pendingSend: null,
    sendingStatus: 'idle',
  };
  const set = vi.fn((patch: Record<string, any>) => {
    state = { ...state, ...patch };
  });
  const get = vi.fn(() => ({
    ...state,
    connectSmtp: vi.fn(async () => {}),
    syncEmails: vi.fn(async () => {}),
  }));
  const slice = createComposeSlice(set as any, get as any, {} as any);
  return { slice, set, getState: () => state };
};

const smtp = {
  // Parameters are named (and unused) so `mock.calls[0][1]` is a typed
  // element rather than an index into an empty tuple.
  scheduleSend: vi.fn(async (_options: Record<string, unknown>, _sendAt: number) => ({ success: true, id: 7 })),
  sendWithUndo: vi.fn(async (_options: Record<string, unknown>, _undoDelayMs: number) => ({ success: true, id: 8 })),
  commitSend: vi.fn(async () => ({ success: true })),
  cancelSend: vi.fn(async () => ({ success: true, cancelled: true })),
  connectFor: vi.fn(async () => ({ success: true })),
};
const drafts = { delete: vi.fn(async () => ({ success: true })) };

const OPTIONS = {
  to: ['friend@example.com'],
  subject: 'Later',
  body: 'text',
  htmlBody: '<p>text</p>',
  draftCleanup: { threadId: 't1', messageId: 'd1', subject: 'Later', to: 'friend@example.com' },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    electronAPI: { smtp, drafts, emails: { get: vi.fn() } },
    // The immediate path arms its commit timer through window.setTimeout.
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as never),
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendEmail with a delivery time', () => {
  it('schedules through the outbox instead of taking the undo path', async () => {
    const { slice } = makeSlice();
    await slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT });

    expect(smtp.scheduleSend).toHaveBeenCalledTimes(1);
    expect(smtp.scheduleSend.mock.calls[0][1]).toBe(SEND_AT);
    expect(smtp.sendWithUndo).not.toHaveBeenCalled();
  });

  // Regression: an optimistic Sent row claims a delivery that is hours away,
  // and an undo toast counts down to a commit that will never happen.
  it('adds no optimistic sent row and arms no undo toast', async () => {
    const { slice, getState } = makeSlice();
    await slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT });

    expect(getState().threadEmails).toHaveLength(0);
    expect(getState().pendingSend).toBeNull();
  });

  it('drops the draft once the mail is durable in the outbox', async () => {
    const { slice } = makeSlice();
    await slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT });
    expect(drafts.delete).toHaveBeenCalledWith(OPTIONS.draftCleanup);
  });

  // Regression, and the one that loses mail: nothing was persisted, so the
  // draft is the only copy left. Deleting it here destroys the message.
  it('keeps the draft and surfaces the error when the schedule cannot be persisted', async () => {
    smtp.scheduleSend.mockResolvedValueOnce({ success: false, error: 'db locked' } as any);
    const { slice, getState } = makeSlice();

    await expect(slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT })).rejects.toThrow('db locked');
    expect(drafts.delete).not.toHaveBeenCalled();
    expect(getState().sendingStatus).toBe('idle');
  });

  it('keeps the draft when the IPC call itself throws', async () => {
    smtp.scheduleSend.mockRejectedValueOnce(new Error('bridge gone'));
    const { slice } = makeSlice();

    await expect(slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT })).rejects.toThrow('bridge gone');
    expect(drafts.delete).not.toHaveBeenCalled();
  });

  // Multi-account: a scheduled reply to another account's mail must go out
  // from THAT account, not whichever one happens to be active.
  it('schedules onto the owning account when sending as another account', async () => {
    const { slice } = makeSlice();
    await slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT, accountId: 'acct-2' });
    expect(smtp.scheduleSend.mock.calls[0][0]).toMatchObject({ accountId: 'acct-2' });
  });

  it('rounds a fractional time down to whole seconds', async () => {
    const { slice } = makeSlice();
    await slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT + 0.9 });
    expect(smtp.scheduleSend.mock.calls[0][1]).toBe(SEND_AT);
  });
});

describe('sendEmail without a delivery time', () => {
  // Regression: the immediate path must be untouched by the schedule branch —
  // persist-first hold, optimistic row, undo toast.
  it('still takes the persist-first undo path', async () => {
    const { slice, getState } = makeSlice();
    await slice.sendEmail(OPTIONS);

    expect(smtp.sendWithUndo).toHaveBeenCalledTimes(1);
    expect(smtp.scheduleSend).not.toHaveBeenCalled();
    expect(getState().threadEmails).toHaveLength(1);
    expect(getState().pendingSend).toMatchObject({ sendId: 8 });

    // Leave no live commit timer behind for the next test.
    clearTimeout(getState().pendingSend.timeoutId);
  });
});

describe('sendEmail with an OpenPGP request', () => {
  // Breaks: the lock in the composer is on, but the payload whitelist drops the
  // request and the mail goes out in the clear — with nothing on screen to say so.
  it('carries the encrypt/sign request to main on both the scheduled and the immediate path', async () => {
    const { slice } = makeSlice();
    await slice.sendEmail({ ...OPTIONS, sendAt: SEND_AT, pgp: { encrypt: true, sign: false } });
    expect(smtp.scheduleSend.mock.calls[0][0]).toMatchObject({ pgp: { encrypt: true, sign: false } });

    await slice.sendEmail({ ...OPTIONS, pgp: { encrypt: false, sign: true } });
    expect(smtp.sendWithUndo.mock.calls[0][0]).toMatchObject({ pgp: { encrypt: false, sign: true } });
  });
});
