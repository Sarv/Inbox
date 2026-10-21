// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalCalendarAvailability } from '../../../../src/types/local-calendar';
import { savedDraftContent, textToParagraphsHtml } from '../../../../src/utils/saved-draft-content';

// What breaks if this file fails: a draft reopened from Drafts comes back
// wrong — an encrypted one as its "Encrypted message" placeholder (which the
// next autosave then saves over the real draft), without its files, or no
// longer encrypted, so the next save stores it in the clear.

const originalAlert = window.alert;
const mockAlert = () => { const alert = vi.fn(); window.alert = alert; return alert; };

afterEach(() => {
  vi.restoreAllMocks();
  window.alert = originalAlert;
  delete (window as any).electronAPI;
});

const bridge = (over: { openDraft?: unknown; getAttachmentBase64?: unknown; getCalendarAvailability?: (messageId: string, accountId?: string) => Promise<unknown> } = {}) => {
  const api = {
    pgp: { openDraft: vi.fn(async () => over.openDraft) },
    emails: { getAttachmentBase64: vi.fn(async () => over.getAttachmentBase64 ?? { success: true, base64: 'QUJD' }) },
    ...(over.getCalendarAvailability ? { drafts: { getCalendarAvailability: over.getCalendarAvailability } } : {}),
  };
  (window as any).electronAPI = api;
  return api;
};

describe('textToParagraphsHtml', () => {
  // Breaks: a plain-text draft reopens as one run-on line, or loses its blank lines.
  it('makes one paragraph per line, keeping empty lines', () => {
    expect(textToParagraphsHtml('one\n\ntwo')).toBe('<p>one</p><p>&nbsp;</p><p>two</p>');
  });
});

describe('savedDraftContent, app-local calendar availability', () => {
  const startMs = Date.parse('2026-10-21T10:00:00Z');
  const availability: LocalCalendarAvailability = {
    status: 'ready', startMs, endMs: startMs + 86_400_000, checkedAt: startMs - 60_000,
    timeZone: 'UTC', durationMinutes: 30, calendarIds: ['local-work'], calendarNames: ['Work'],
    scope: 'local-only', slots: [{ startMs, endMs: startMs + 1_800_000, label: 'Wednesday at 10:00' }],
  };

  // Regression: closing a proposed meeting draft must not discard its send-time calendar recheck.
  it('loads metadata by canonical Message-ID in the owning account and preserves the unchanged body', async () => {
    const lookup = vi.fn(async () => ({ success: true, data: availability }));
    const api = bridge({ getCalendarAvailability: lookup });
    const content = await savedDraftContent({ id: 'internal-row-id', messageId: '<draft@example.test>', message_id: '<older@example.test>', accountId: 'account-b', cleanBody: 'How about Wednesday?', attachmentNames: '[]' });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('<draft@example.test>', 'account-b');
    expect(content).toEqual({ htmlContent: '<p>How about Wednesday?</p>', attachments: [], pgpEncrypted: false, calendarAvailability: availability });
    expect(content?.htmlContent).not.toContain('local-work');
    expect(api.pgp.openDraft).not.toHaveBeenCalled();
  });

  it('supports snake_case Message-ID rows without substituting their local row id', async () => {
    const lookup = vi.fn(async () => ({ success: true, data: availability }));
    bridge({ getCalendarAvailability: lookup });
    expect((await savedDraftContent({ id: 'different-local-row', message_id: '<snake@example.test>', accountId: 'account-a', rawBody: '<p>Saved body</p>' }))?.calendarAvailability).toEqual(availability);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('<snake@example.test>', 'account-a');
  });

  it('keeps legacy rows with no canonical Message-ID readable without looking up an unrelated row id', async () => {
    const lookup = vi.fn(); const alert = mockAlert();
    bridge({ getCalendarAvailability: lookup });
    expect(await savedDraftContent({ id: 'legacy-local-row', cleanBody: 'Legacy draft' })).toEqual({ htmlContent: '<p>Legacy draft</p>', attachments: [], pgpEncrypted: false });
    expect(lookup).not.toHaveBeenCalled(); expect(alert).not.toHaveBeenCalled();
  });

  it('opens ordinary drafts when a successful metadata read confirms no saved calendar check', async () => {
    const lookup = vi.fn(async () => ({ success: true }));
    bridge({ getCalendarAvailability: lookup });
    expect(await savedDraftContent({ id: 'row', messageId: '<ordinary@example.test>', cleanBody: 'Ordinary draft' })).toEqual({ htmlContent: '<p>Ordinary draft</p>', attachments: [], pgpEncrypted: false });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('<ordinary@example.test>', undefined);
  });

  // Regression: metadata failure must never silently reopen a claimed meeting time without its recheck proof.
  it.each(['reported', 'rejected', 'missing-result'] as const)('blocks reopening and notifies the user when metadata reading is %s', async failure => {
    const lookup = vi.fn(async (): Promise<unknown> => {
      if (failure === 'rejected') throw new Error('Synthetic private storage failure');
      return failure === 'reported' ? { success: false, error: 'Synthetic private storage failure' } : undefined;
    });
    const alert = mockAlert();
    const api = bridge({ getCalendarAvailability: lookup });
    expect(await savedDraftContent({ id: 'row', messageId: '<meeting@example.test>', accountId: 'account-b', cleanBody: 'A proposed time', attachmentNames: '["plan.pdf"]' })).toBeNull();
    expect(alert).toHaveBeenCalledExactlyOnceWith('Could not load this draft’s saved calendar check. The draft was not opened. Please try again.');
    expect(api.emails.getAttachmentBase64).not.toHaveBeenCalled(); expect(api.pgp.openDraft).not.toHaveBeenCalled();
  });

  // Regression: metadata restoration must not bypass OpenPGP or reopen encrypted placeholders as mail content.
  it('preserves app-local availability alongside content decrypted only by main', async () => {
    const lookup = vi.fn(async () => ({ success: true, data: availability }));
    const api = bridge({ getCalendarAvailability: lookup, openDraft: { ok: true, contentType: 'html', body: '<p>Decrypted proposal</p>', attachments: [] } });
    expect(await savedDraftContent({ id: 'encrypted-row', messageId: '<encrypted@example.test>', accountId: 'account-b', pgpStatus: 'encrypted', cleanBody: 'Encrypted message' })).toEqual({
      htmlContent: '<p>Decrypted proposal</p>', attachments: [], pgpEncrypted: true, calendarAvailability: availability,
    });
    expect(api.pgp.openDraft).toHaveBeenCalledExactlyOnceWith('encrypted-row', 'account-b');
    expect(api.emails.getAttachmentBase64).not.toHaveBeenCalled();
  });

  it('still refuses encrypted placeholder content when metadata exists but the key is locked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(async () => ({ success: true, data: availability }));
    const api = bridge({ getCalendarAvailability: lookup, openDraft: { ok: false, code: 'locked', error: 'Unlock your key' } });
    expect(await savedDraftContent({ id: 'encrypted-row', messageId: '<locked@example.test>', pgpStatus: 'encrypted', cleanBody: 'Encrypted message' })).toBeNull();
    expect(api.emails.getAttachmentBase64).not.toHaveBeenCalled();
  });
});

describe('savedDraftContent, plain drafts', () => {
  // Breaks: the ordinary reopen path changed while adding the encrypted one.
  it('reopens from the stored body and loads the files by name', async () => {
    const api = bridge();
    const content = await savedDraftContent({ id: 'd1', accountId: 'acct', cleanBody: 'hi\nthere', attachmentNames: '["a.pdf"]', attachmentSizes: '[3]' });
    expect(content).toMatchObject({ htmlContent: '<p>hi</p><p>there</p>', pgpEncrypted: false });
    expect(content?.attachments.map((file) => file.filename)).toEqual(['a.pdf']);
    expect(api.emails.getAttachmentBase64).toHaveBeenCalledWith('d1', 'a.pdf', 'acct');
    expect(api.pgp.openDraft).not.toHaveBeenCalled();
  });

  // Breaks: a draft with no text part reopens blank.
  it('falls back to the raw body, then the HTML body, then nothing', async () => {
    bridge();
    expect((await savedDraftContent({ id: 'd', rawBody: '<b>raw</b>' }))?.htmlContent).toBe('<b>raw</b>');
    expect((await savedDraftContent({ id: 'd', htmlBody: '<i>html</i>' }))?.htmlContent).toBe('<i>html</i>');
    expect((await savedDraftContent({ id: 'd' }))?.htmlContent).toBe('');
  });
});

describe('savedDraftContent, encrypted drafts', () => {
  const file = { filename: 'plan.pdf', contentType: 'application/pdf', size: 3, content: 'QUJD', encoding: 'base64' };

  // Breaks: an encrypted draft reopens as its placeholder, and without its files.
  it('decrypts through main, never through the row', async () => {
    const api = bridge({ openDraft: { ok: true, contentType: 'html', body: '<p>the plan</p>', attachments: [file] } });
    const content = await savedDraftContent({ id: 'd1', accountId: 'acct', pgpStatus: 'encrypted', cleanBody: 'Encrypted message' });
    expect(api.pgp.openDraft).toHaveBeenCalledWith('d1', 'acct');
    expect(content).toEqual({ htmlContent: '<p>the plan</p>', attachments: [{ ...file, type: 'attachment' }], pgpEncrypted: true });
    // The files come out of the ciphertext — none are fetched by name.
    expect(api.emails.getAttachmentBase64).not.toHaveBeenCalled();
  });

  // Breaks: a text-only encrypted draft reopens as one run-on line.
  it('turns a text body into paragraphs', async () => {
    bridge({ openDraft: { ok: true, contentType: 'text', body: 'a\nb', attachments: [] } });
    expect((await savedDraftContent({ id: 'd1', pgpStatus: 'encrypted' }))?.htmlContent).toBe('<p>a</p><p>b</p>');
  });

  // Breaks: a draft that cannot be decrypted (no key, locked key) opens as its placeholder —
  // and the next autosave replaces the real draft with the word "Encrypted message".
  it('opens nothing when the draft cannot be decrypted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge({ openDraft: { ok: false, code: 'locked', error: 'Unlock your key' } });
    expect(await savedDraftContent({ id: 'd1', pgpStatus: 'encrypted' })).toBeNull();
    expect(warn).toHaveBeenCalledWith('[Draft] Encrypted draft could not be opened:', 'locked', 'Unlock your key');
  });

  // Breaks: a signed (not encrypted) draft is sent to the decrypter and fails to open.
  it('reads a signed draft like a plain one', async () => {
    const api = bridge();
    expect(await savedDraftContent({ id: 'd1', pgpStatus: 'signed', cleanBody: 'x' })).toMatchObject({ pgpEncrypted: false });
    expect(api.pgp.openDraft).not.toHaveBeenCalled();
  });
});
