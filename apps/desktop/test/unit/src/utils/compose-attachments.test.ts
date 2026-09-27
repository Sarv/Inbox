// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachmentsKey, loadEmailAttachments, toDraftAttachments } from '../../../../src/utils/compose-attachments';

// What breaks if this file fails: attachments fall out of drafts and forwards —
// saved without them, reopened without them, or loaded from the wrong mailbox.

const pdf = { filename: 'invoice.pdf', content: 'JVBERg==', contentType: 'application/pdf', size: 4, type: 'attachment' };

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).electronAPI;
});

describe('toDraftAttachments', () => {
  // Breaks: the save sends the composer's UI fields (size, type, encoding)
  // instead of the name + bytes the main process stores.
  it('keeps the name, bytes and type', () => {
    expect(toDraftAttachments([pdf])).toEqual([{ filename: 'invoice.pdf', content: 'JVBERg==', contentType: 'application/pdf' }]);
  });

  // Breaks: a file known only by `name` (the picker's older shape) is saved nameless.
  it('falls back to `name`, then to "attachment"', () => {
    const named = toDraftAttachments([{ name: 'a.txt', content: 'YQ==', size: 1, type: '' }, { content: 'Yg==', size: 1, type: '' }]);
    expect(named.map((file) => file.filename)).toEqual(['a.txt', 'attachment']);
  });

  // Breaks: a file whose bytes never loaded is saved as an empty attachment.
  it('leaves out files with no content', () => {
    expect(toDraftAttachments([{ filename: 'x.bin', size: 0, type: '' }])).toEqual([]);
    expect(toDraftAttachments(undefined)).toEqual([]);
  });
});

describe('attachmentsKey', () => {
  // Breaks: adding or removing a file is not seen as a change, so it is never saved.
  it('changes when a file is added or removed', () => {
    expect(attachmentsKey([pdf])).not.toBe(attachmentsKey([]));
    expect(attachmentsKey([pdf, { ...pdf, filename: 'b.pdf' }])).not.toBe(attachmentsKey([pdf]));
  });

  // Breaks: an unchanged list reads as changed, re-saving an untouched draft.
  it('is stable for the same files', () => {
    expect(attachmentsKey([{ ...pdf }])).toBe(attachmentsKey([pdf]));
  });
});

describe('loadEmailAttachments', () => {
  const stubFetch = (impl: (id: string, name: string, accountId?: string) => unknown) => {
    const getAttachmentBase64 = vi.fn(async (id: string, name: string, accountId?: string) => impl(id, name, accountId));
    (window as any).electronAPI = { emails: { getAttachmentBase64 } };
    return getAttachmentBase64;
  };

  // Breaks: a reopened draft (or a forward) comes back without its files.
  it('loads every declared file as a composer attachment', async () => {
    stubFetch(() => ({ success: true, base64: 'JVBERg==' }));
    const files = await loadEmailAttachments({ id: 'e1', attachmentNames: '["invoice.pdf","b.txt"]' });
    expect(files.map((file) => file.filename)).toEqual(['invoice.pdf', 'b.txt']);
    expect(files[0]).toMatchObject({ content: 'JVBERg==', encoding: 'base64', size: 6 });
  });

  // MULTI-ACCOUNT. Breaks: from All Inboxes the files are looked up in the
  // ACTIVE account's mailbox, find nothing, and the forward goes out without them.
  it('asks the owning account for the files', async () => {
    const fetch = stubFetch(() => ({ success: true, base64: 'YQ==' }));
    await loadEmailAttachments({ id: 'e1', attachmentNames: '["a.txt"]', accountId: 'acct-2' });
    expect(fetch).toHaveBeenCalledWith('e1', 'a.txt', 'acct-2');
  });

  // Breaks: one file that fails (offline, evicted) drops every other file too.
  it('skips a file that fails and keeps the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((_id, name) => {
      if (name === 'gone.pdf') throw new Error('Not connected to IMAP');
      if (name === 'empty.pdf') return { success: false, error: 'not found' };
      return { success: true, base64: 'YQ==' };
    });
    const files = await loadEmailAttachments({ id: 'e1', attachmentNames: '["gone.pdf","empty.pdf","ok.txt"]' });
    expect(files.map((file) => file.filename)).toEqual(['ok.txt']);
  });

  // Breaks: a mail without attachments makes a pointless round-trip per open.
  it('fetches nothing when the mail declares no files', async () => {
    const fetch = stubFetch(() => ({ success: true, base64: '' }));
    expect(await loadEmailAttachments({ id: 'e1', attachmentNames: null })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
