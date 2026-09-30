// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { savedDraftContent, textToParagraphsHtml } from '../../../../src/utils/saved-draft-content';

// What breaks if this file fails: a draft reopened from Drafts comes back
// wrong — an encrypted one as its "Encrypted message" placeholder (which the
// next autosave then saves over the real draft), without its files, or no
// longer encrypted, so the next save stores it in the clear.

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).electronAPI;
});

const bridge = (over: { openDraft?: unknown; getAttachmentBase64?: unknown } = {}) => {
  const api = {
    pgp: { openDraft: vi.fn(async () => over.openDraft) },
    emails: { getAttachmentBase64: vi.fn(async () => over.getAttachmentBase64 ?? { success: true, base64: 'QUJD' }) },
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
