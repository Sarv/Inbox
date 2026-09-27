import { describe, expect, it } from 'vitest';

import {
  buildForwardQuoteHtml,
  buildForwardQuoteText,
  composeForwardDraft,
  forwardSubject,
  toForwardSource,
} from '../../../../src/utils/forward-quote';

// What breaks if this suite goes red: a forward goes out (or is drafted)
// without the message it forwards, or a forward draft reopened from Drafts is
// just the note with nothing under it.

const original = {
  subject: 'Quarterly numbers',
  fromAddress: 'ceo@x.com',
  fromName: 'The CEO',
  toAddress: 'team@x.com',
  date: 1_700_000_000,
  cleanBody: 'line one\n\nline three',
  rawBody: null,
};

describe('buildForwardQuoteHtml', () => {
  // Breaks: the recipient can't tell who wrote the forwarded mail, or when.
  it('carries the original header and body', () => {
    const html = buildForwardQuoteHtml(original);
    expect(html).toContain('---------- Forwarded Message ----------');
    expect(html).toContain('<strong>From:</strong> The CEO');
    expect(html).toContain('<strong>Subject:</strong> Quarterly numbers');
    expect(html).toContain('<strong>To:</strong> team@x.com');
    // Blank lines survive as spacer paragraphs instead of collapsing.
    expect(html).toContain('<p>line one</p><p>&nbsp;</p><p>line three</p>');
  });

  // Breaks: a formatted (HTML) original would be flattened to its text.
  it('prefers the original HTML body, and falls back to the address with no name', () => {
    const html = buildForwardQuoteHtml({ ...original, fromName: null, rawBody: '<table>t</table>' });
    expect(html).toContain('<div><table>t</table></div>');
    expect(html).toContain('<strong>From:</strong> ceo@x.com');
  });

  // Breaks: an original with no body at all would throw.
  it('tolerates an original with no body', () => {
    expect(buildForwardQuoteHtml({ ...original, cleanBody: null })).toContain('<div><p>&nbsp;</p></div>');
  });
});

describe('buildForwardQuoteText', () => {
  // Breaks: the draft's plain-text part (and anything reading it) loses the
  // forwarded message.
  it('is the plain-text twin of the HTML quote', () => {
    const text = buildForwardQuoteText(original);
    expect(text.split('\n').slice(0, 2)).toEqual(['---------- Forwarded Message ----------', 'From: The CEO']);
    expect(text).toContain('Subject: Quarterly numbers');
    expect(text.endsWith('line one\n\nline three')).toBe(true);
    expect(buildForwardQuoteText({ ...original, cleanBody: null }).endsWith('To: team@x.com\n\n')).toBe(true);
  });
});

describe('forwardSubject', () => {
  // Breaks: forwarding a forward stacks "Fwd: Fwd: …".
  it('adds "Fwd: " exactly once', () => {
    expect(forwardSubject('Hi')).toBe('Fwd: Hi');
    expect(forwardSubject('Fwd: Hi')).toBe('Fwd: Hi');
  });
});

describe('composeForwardDraft', () => {
  // Breaks: a forward draft reopened from Drafts is only the note.
  it('puts the forwarded message under the note, in both parts', () => {
    const draft = composeForwardDraft(original, { body: 'FYI', htmlBody: '<p>FYI</p>' });
    expect(draft.htmlBody.startsWith('<p>FYI</p>')).toBe(true);
    expect(draft.htmlBody).toContain('Forwarded Message');
    expect(draft.body.startsWith('FYI\n\n---------- Forwarded Message')).toBe(true);
  });
});

describe('toForwardSource', () => {
  const row = {
    id: 'e1', subject: 'Invoice', fromAddress: 'a@x.com', fromName: 'A', toAddress: 'me@x.com',
    ccAddress: 'c@x.com', date: 1_700_000_000, cleanBody: 'hi', rawBody: '<p>hi</p>',
    hasAttachments: true, attachmentNames: '["invoice.pdf"]', accountId: 'acc-2',
  };

  // Regression: the message view and thread list dropped these, so forwards from there lost the original's files.
  it('carries the attachment fields through', () => {
    const source = toForwardSource(row);
    expect(source.hasAttachments).toBe(true);
    expect(source.attachmentNames).toBe('["invoice.pdf"]');
  });

  // Regression: without the owning account the forward sends from (and drafts into) the active account.
  it('carries the owning account through', () => {
    expect(toForwardSource(row).accountId).toBe('acc-2');
  });

  // Regression: a null subject / To rendered as "Fwd: null" and "To: null" in the quote.
  it('turns a missing subject and To into empty strings', () => {
    const source = toForwardSource({ ...row, subject: null, toAddress: null });
    expect(source.subject).toBe('');
    expect(source.toAddress).toBe('');
  });

  // Regression: a mail without attachments must not start a fetch of files that don't exist.
  it('keeps a no-attachment mail marked as such', () => {
    const source = toForwardSource({ ...row, hasAttachments: false, attachmentNames: null });
    expect(source.hasAttachments).toBe(false);
    expect(source.attachmentNames).toBeNull();
  });
});
