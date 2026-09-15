// The bulk / notification predicate. Moved here (with its cases) from the
// renderer's `utils/email-classification.ts`, which scored the same idea, had
// no caller, and carried its own no-reply regex next to core's better one.
//
// What breaks if this file goes red: a marketing blast renders as a chat
// bubble (the mangled-template bug), or — far worse in the other direction — a
// colleague's genuine reply is taken for a blast and rendered as a document,
// losing its place in the conversation.
import { describe, it, expect } from 'vitest';

import { assessBulkMail, isBulkMail, isConversationMail } from '../../../src/utils/bulk-mail';

describe('assessBulkMail', () => {
  // A hand-written reply is the case the whole chat view exists for. If this
  // fails, ordinary mail stops being rendered as conversation.
  it('treats a plain hand-written reply as a person', () => {
    const result = assessBulkMail({
      rawBody: '<div><p>Hi Advik,</p><p>Please find the API doc attached. Thanks!</p></div>',
      messageId: '<CAF=abc123@mail.gmail.com>',
      fromAddress: 'mitali@example.com',
    });
    expect(result.isBulk).toBe(false);
  });

  // Length and rich formatting are not bulk signals — a long human mail with
  // bold and lists must stay a person's message.
  it('keeps a long hand-written email with bold/lists conversational', () => {
    const result = assessBulkMail({
      rawBody:
        '<p>Hi team,</p><p><b>EMAIL_RQ_182:</b> Solution should support MFA.</p>' +
        '<ul><li>Point one</li><li>Point two</li></ul><p>Please confirm.</p>'.repeat(6),
      messageId: '<x@mail.gmail.com>',
      fromAddress: 'person@company.com',
    });
    expect(result.isBulk).toBe(false);
  });

  // Outlook ships >10KB of mso markup, inline styles on every block and a
  // layout table for a one-line reply. Scoring "designed HTML" flagged these as
  // automated and stripped the chat treatment off real replies — the regression
  // this case pins.
  it('keeps a verbose Outlook/Word email conversational (no designed-HTML signal)', () => {
    const outlook =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head>' +
      '<body><table role="presentation" style="width:100%"><tr><td style="padding:0">' +
      '<div style="margin:0"><p style="margin:0"><b>Hi Mitali,</b></p>' +
      '<p style="margin:0">As discussed, please share the API doc. Thanks!</p></div>' +
      '</td></tr></table>' + `<!--${'x'.repeat(12000)}-->` + '</body></html>';
    const result = assessBulkMail({
      rawBody: outlook,
      messageId: '<x@mail.gmail.com>',
      fromAddress: 'advik@corp.com',
    });
    expect(result.isBulk).toBe(false);
  });

  // The `|bulk|` tag is written at sync time from List-Id / List-Unsubscribe /
  // Precedence. It is the only RFC-grade signal we have, and it must decide on
  // its own — a blast whose body has not been fetched yet still has this.
  it('treats the stored |bulk| tag as decisive, with no body at all', () => {
    const result = assessBulkMail({ tags: '|read|bulk|', fromAddress: 'team@startup.example' });
    expect(result.isBulk).toBe(true);
    expect(result.signals).toContain('bulk-header');
  });

  // Regression: the reported Keka digest — `no-reply@kekamail.com`, body not
  // yet fetched. Sender alone has to be enough or the first render of a
  // notification mail goes through the chat treatment and then jumps.
  it('flags a no-reply sender before the body arrives', () => {
    expect(isBulkMail({ fromAddress: 'no-reply@kekamail.com' })).toBe(true);
  });

  // Notification senders overwhelmingly put the marker at the END of a
  // generated local part; core's role-address detector knows both spellings,
  // which is exactly why this predicate reuses it instead of its own regex.
  it('flags machine mailboxes by suffix as well as prefix', () => {
    expect(isBulkMail({ fromAddress: 'notifications@jira.com' })).toBe(true);
    expect(isBulkMail({ fromAddress: 'pullrequests-reply@bitbucket.org' })).toBe(true);
    expect(isBulkMail({ fromAddress: 'drive-shares-dm-noreply@google.com' })).toBe(true);
    // A human whose local part merely starts with a role word is NOT a robot.
    expect(isBulkMail({ fromAddress: 'newsome@company.com' })).toBe(false);
  });

  it('flags a 1x1 tracking pixel', () => {
    const result = assessBulkMail({
      rawBody: '<p>Sale!</p><img src="https://t.example/o.gif" width="1" height="1">',
      fromAddress: 'deals@shop.com',
    });
    expect(result.isBulk).toBe(true);
    expect(result.signals).toContain('tracking-pixel');
  });

  it('flags an unrendered template placeholder', () => {
    expect(isBulkMail({ rawBody: '<p>Hello {{first_name}},</p>' })).toBe(true);
    expect(isBulkMail({ rawBody: '<p>Hi %FIRST_NAME%</p>' })).toBe(true);
    expect(isBulkMail({ rawBody: '<p>Dear [NAME]</p>' })).toBe(true);
  });

  it('flags an ESP Message-ID but not a real client one', () => {
    expect(isBulkMail({ rawBody: '<p>hi</p>', messageId: '<abc.123@sendgrid.net>' })).toBe(true);
    expect(isBulkMail({ rawBody: '<p>hi</p>', messageId: '<abc@bounces.amazonses.com>' })).toBe(true);
    expect(isBulkMail({ rawBody: '<p>hi</p>', messageId: '<abc@mail.gmail.com>' })).toBe(false);
  });

  // A corporate footer can say "unsubscribe". On its own that must never flip
  // a colleague's mail out of the conversation.
  it('does NOT decide on a lone "unsubscribe" word (below threshold)', () => {
    const result = assessBulkMail({
      rawBody:
        '<p>You can unsubscribe from the internal newsletter in settings. Anyway, see you Monday!</p>',
      messageId: '<x@mail.gmail.com>',
      fromAddress: 'colleague@company.com',
    });
    expect(result.isBulk).toBe(false);
    expect(result.signals).toEqual(['unsubscribe-copy']);
    expect(result.score).toBeLessThan(3);
  });

  it('flags a real marketing email (tracking pixel + unsubscribe)', () => {
    const result = assessBulkMail({
      rawBody:
        '<table role="presentation"><tr><td>Big Sale</td></tr></table>' +
        '<img src="https://t.brand/open.gif" width="1" height="1">' +
        '<a href="https://x/u">Unsubscribe</a> · <a href="https://x/p">Manage preferences</a>',
      fromAddress: 'news@brand.com',
    });
    expect(result.isBulk).toBe(true);
  });

  // Nothing supplied at all must not throw and must not accuse.
  it('says nothing about an empty input', () => {
    expect(assessBulkMail({})).toEqual({ isBulk: false, score: 0, signals: [] });
  });

  it('isConversationMail is the inverse predicate', () => {
    expect(isConversationMail({ rawBody: '<p>See you tomorrow.</p>', messageId: '<x@mail.gmail.com>' })).toBe(true);
    expect(isConversationMail({ rawBody: '<p>Hi {{name}}</p>' })).toBe(false);
  });
});
