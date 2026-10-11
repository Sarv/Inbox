import { describe, expect, it, vi } from 'vitest';

import { buildPrintDocument, printDocumentFor } from '../../../../../src/components/email-detail/print-document';
import { emailFrameCsp } from '../../../../../src/utils/email-frame-csp';

// The user's auto-load rules, reduced to one fact: this sender's images are
// allowed on account A only. The real rules read stores; the question here is
// only WHICH account print asks them about.
vi.mock('../../../../../src/utils/remote-images', () => ({
  remoteImageFactsOf: (email: { accountId?: string | null }, pane?: string | null) => ({ accountId: email.accountId ?? pane ?? null }),
  shouldAutoLoadRemoteImages: (facts: { accountId: string | null } | null) => facts?.accountId === 'acct-A',
}));

// Printing an email (CASA M-4). What breaks if this fails: printing fires the
// tracking pixel the viewer blocked, or a crafted subject/sender becomes markup
// in the print document.

const email = {
  subject: 'Invoice <img src="https://tracker.example/s.gif">',
  fromName: 'Eve "<b>"',
  fromAddress: 'eve@example.com',
  toAddress: 'me@example.com',
  ccAddress: 'boss@example.com',
  date: 1_700_000_000,
  rawBody: '<p>Body <img src="https://tracker.example/b.gif"></p>',
};

describe('buildPrintDocument', () => {
  it('carries the email policy before the document content, blocking remote images by default', () => {
    const doc = buildPrintDocument(email, false);
    expect(doc.startsWith(`<!DOCTYPE html>${emailFrameCsp(false)}`)).toBe(true);
  });

  // Follows the user's image rules for this sender.
  it('allows remote images only when the caller says the rules allow them', () => {
    expect(buildPrintDocument(email, true)).toContain(emailFrameCsp(true));
  });

  // Breaks: header text turns into markup (here, a second tracking pixel).
  it('escapes subject, sender and recipients; only the body is HTML', () => {
    const doc = buildPrintDocument(email, false);
    expect(doc).toContain('Invoice &lt;img src=&quot;https://tracker.example/s.gif&quot;&gt;');
    expect(doc).not.toContain('<img src="https://tracker.example/s.gif">');
    expect(doc).toContain('Eve &quot;&lt;b&gt;&quot; &lt;eve@example.com&gt;');
    expect(doc).toContain('<strong>Cc:</strong> boss@example.com');
    expect(doc).toContain('<p>Body <img src="https://tracker.example/b.gif"></p>');
  });

  it('falls back sensibly for missing fields', () => {
    const doc = buildPrintDocument({ date: 0, cleanBody: 'plain' }, false);
    expect(doc).toContain('(no subject)');
    expect(doc).toContain('<div class="body">plain</div>');
    expect(doc).not.toContain('Cc:');
  });
});

describe('printDocumentFor', () => {
  // In All Inboxes a thread row carries no accountId: the pane knows which
  // account it was read from, and the on-screen frame decides with that.
  // Breaks: print decides with the ACTIVE account instead, and prints (fires)
  // the pixel the screen blocked — or drops images the screen shows.
  it('decides remote images with the message account, else the pane account — as the screen does', () => {
    expect(printDocumentFor(email, 'acct-A')).toContain(emailFrameCsp(true));
    expect(printDocumentFor(email, 'acct-B')).toContain(emailFrameCsp(false));
    expect(printDocumentFor({ ...email, accountId: 'acct-A' }, 'acct-B')).toContain(emailFrameCsp(true));
    expect(printDocumentFor({ ...email, accountId: 'acct-B' }, 'acct-A')).toContain(emailFrameCsp(false));
  });
});
