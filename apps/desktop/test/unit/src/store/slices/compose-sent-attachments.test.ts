import type { EmailRecord, SendAttachment, SendEmailOptions } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(), applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []), warmCategoryDefs: vi.fn(),
}));

import { attachmentsOf, mailsFromEmails } from '../../../../../src/components/email-detail/chat-message-adapter';
import { parseAttachments } from '../../../../../src/components/email-detail/utils';
import { createComposeSlice } from '../../../../../src/store/slices/compose-slice';
import { needsAttachmentMetadata } from '../../../../../src/utils/attachment-metadata';

const smtp = {
  sendWithUndo: vi.fn(async (_payload: SendEmailOptions, _delay: number) => ({ success: true, id: 42 })),
  commitSend: vi.fn(async () => ({ success: true })),
  cancelSend: vi.fn(async () => ({ success: true, cancelled: true })),
};

const makeStore = () => createStore<any>((set, get, api) => ({
  ...createComposeSlice(set, get, api),
  imapConfig: { username: 'me@example.test' }, smtpConnected: true,
  emails: [], threadEmails: [], accounts: [], activeAccountId: 'account-a',
  connectSmtp: vi.fn(async () => {}), syncEmails: vi.fn(async () => {}),
}));

const options = (extra: Partial<SendEmailOptions> = {}): SendEmailOptions => ({
  to: ['recipient@example.test'], subject: 'Forwarded document',
  body: 'Please see the attached document.', htmlBody: '<p>Please see the attached document.</p>',
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ undoSendDelay: 30 }) });
  vi.stubGlobal('window', {
    electronAPI: { smtp },
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('optimistic Sent attachments during the undo-send window', () => {
  it('gives both readers filenames and decoded sizes immediately while retaining the held send', async () => {
    const store = makeStore();
    const files: SendAttachment[] = [
      { filename: 'proposal, final.docx', content: 'AQIDBAU=', encoding: 'base64' },
      { filename: 'notes.txt', content: 'café 😀', encoding: 'utf-8' },
      { filename: 'binary.dat', content: new Uint8Array(new ArrayBuffer(10), 2, 3) as unknown as SendAttachment['content'] },
      { filename: 'empty.txt', content: '', encoding: 'base64' },
    ];

    await store.getState().sendEmail(options({ attachments: files }));

    const state = store.getState();
    const sent: EmailRecord = state.threadEmails[0];
    expect(sent.hasAttachments).toBe(true);
    expect(sent.attachmentCount).toBe(4);
    // The classic card and thread accordion use this parser; chat consumes the
    // same row through its adapter rather than waiting for a later Sent sync.
    expect(parseAttachments(sent.attachmentNames, sent.attachmentSizes)).toEqual([
      { name: 'proposal, final.docx', size: 5 },
      { name: 'notes.txt', size: 10 },
      { name: 'binary.dat', size: 3 },
      { name: 'empty.txt', size: null },
    ]);
    expect(attachmentsOf(sent)).toEqual([
      { filename: 'proposal, final.docx', sizeBytes: 5 },
      { filename: 'notes.txt', sizeBytes: 10 },
      { filename: 'binary.dat', sizeBytes: 3 },
      { filename: 'empty.txt' },
    ]);
    expect(mailsFromEmails([sent])[0].attachments).toEqual(attachmentsOf(sent));
    expect(sent.attachmentSizes).toBe('[5,10,3,0]');
    expect(needsAttachmentMetadata(sent)).toBe(false);
    expect(state.pendingSend).toMatchObject({ optimisticEmailId: sent.id, sendId: 42, undoDelayMs: 30_000 });
    expect(state.pendingSend.options.attachments).toBe(files);
    expect(smtp.sendWithUndo).toHaveBeenCalledWith(expect.objectContaining({ attachments: files }), 30_000);
    expect(smtp.commitSend).not.toHaveBeenCalled();
  });

  it.each([
    { content: 'AQ==', bytes: 1 },
    { content: 'AQI=', bytes: 2 },
    { content: 'AQID', bytes: 3 },
    { content: '\nAQIDBA==\r\n', bytes: 4 },
    { content: 'AQIDBA', bytes: 4 },
  ])('counts $bytes decoded bytes for base64 content with padding or whitespace', async ({ content, bytes }) => {
    const store = makeStore();
    await store.getState().sendEmail(options({ attachments: [{ filename: 'file.docx', content, encoding: 'base64' }] }));
    expect(store.getState().threadEmails[0].attachmentSizes).toBe(JSON.stringify([bytes]));
    expect(smtp.commitSend).not.toHaveBeenCalled();
  });

  it('records a known attachment-free row without requesting metadata later', async () => {
    const store = makeStore();
    await store.getState().sendEmail(options());
    const sent = store.getState().threadEmails[0];
    expect(sent).toMatchObject({ hasAttachments: false, attachmentCount: 0, attachmentNames: '', attachmentSizes: '[]' });
    expect(parseAttachments(sent.attachmentNames, sent.attachmentSizes)).toEqual([]);
    expect(attachmentsOf(sent)).toEqual([]);
    expect(needsAttachmentMetadata(sent)).toBe(false);
  });

  it('omits encrypted plaintext file metadata while keeping the encryption payload for main', async () => {
    const store = makeStore();
    const files: SendAttachment[] = [{ filename: 'private.docx', content: 'AQID', encoding: 'base64' }];
    const pgp = { encrypt: true, sign: true };
    await store.getState().sendEmail(options({ attachments: files, pgp }));
    const state = store.getState();
    expect(state.threadEmails[0]).toMatchObject({ hasAttachments: false, attachmentCount: 0, attachmentNames: '', attachmentSizes: '[]' });
    expect(attachmentsOf(state.threadEmails[0])).toEqual([]);
    expect(state.pendingSend.options).toMatchObject({ attachments: files, pgp });
    expect(smtp.sendWithUndo).toHaveBeenCalledWith(expect.objectContaining({ attachments: files, pgp }), 30_000);
  });

  it('keeps attachments visible for a signed plaintext send', async () => {
    const store = makeStore();
    await store.getState().sendEmail(options({
      attachments: [{ filename: 'signed.docx', content: 'AQID', encoding: 'base64' }],
      pgp: { encrypt: false, sign: true },
    }));
    expect(attachmentsOf(store.getState().threadEmails[0])).toEqual([{ filename: 'signed.docx', sizeBytes: 3 }]);
  });

  it('removes the optimistic attachment row when the held send is undone', async () => {
    const store = makeStore();
    await store.getState().sendEmail(options({ attachments: [{ filename: 'report.docx', content: 'AQID', encoding: 'base64' }] }));
    expect(attachmentsOf(store.getState().threadEmails[0])).toHaveLength(1);
    await store.getState().undoSend();
    expect(store.getState().threadEmails).toEqual([]);
    expect(store.getState().pendingSend).toBeNull();
    expect(smtp.cancelSend).toHaveBeenCalledWith(42, undefined);
    expect(smtp.commitSend).not.toHaveBeenCalled();
  });
});
