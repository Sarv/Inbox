// The bulk / notification predicate. Moved here (with its cases) from the
// renderer's `utils/email-classification.ts`, which scored the same idea, had
// no caller, and carried its own no-reply regex next to core's better one.
//
// What breaks if this file goes red: a marketing blast renders as a chat
// bubble (the mangled-template bug), or — far worse in the other direction — a
// colleague's genuine reply is taken for a blast and rendered as a document,
// losing its place in the conversation.
import { describe, it, expect } from 'vitest';

import {
  assessBulkMail,
  BULK_HEADER_NAMES,
  bulkHeaderSignals,
  hasBulkHeaderSignal,
  headerLookupFromText,
  headerValueFromText,
  headerValuesFromText,
  isBulkMail,
  isConversationMail,
  senderOwnText,
} from '../../../src/utils/bulk-mail';

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

  // REPLACES a rule that flagged any 1x1 <img>. Ordinary signature templates
  // use 1x1 spacer gifs for layout, so that rule condemned human mail; the
  // header arms name the same senders without reading markup. A campaign is now
  // recognised by its CLICK-COUNTING links, which a person's own mail does not
  // contain.
  it('flags links rewritten through a click tracker', () => {
    const result = assessBulkMail({
      rawBody: '<p>Sale!</p><a href="https://shop.us1.list-manage.com/track/click?u=9">Shop now</a>',
      fromAddress: 'deals@shop.com',
    });
    expect(result.isBulk).toBe(true);
    expect(result.signals).toContain('tracker-domain-links');
  });

  // The regression that made the previous version unusable: a person replying
  // ON TOP of a quoted newsletter inherits every tracker link and UTM parameter
  // in it. The quoted chain is cut before anything is scored, so the reply is
  // judged on the sender's own two lines. Longer thread, more quoted history —
  // which is why this failed worse the longer a conversation ran.
  it('does NOT condemn a human reply for the newsletter quoted under it', () => {
    const result = assessBulkMail({
      fromAddress: 'mitali@example.com',
      messageId: '<x@mail.gmail.com>',
      rawBody:
        '<p>Yes, let us go with option B. Thanks!</p>' +
        '<p>On Wed, Sep 10, 2026 at 9:02 AM, Deals &lt;news@brand.com&gt; wrote:</p>' +
        '<blockquote><p>Hello {{first_name}}, unsubscribe any time</p>' +
        '<a href="https://shop.us1.list-manage.com/track/click?u=9&utm_source=news">Shop</a>' +
        '</blockquote>',
    });
    expect(result.isBulk).toBe(false);
    expect(result.signals).toEqual([]);
  });

  // A UTM link is something a person can legitimately paste into their own
  // message, so it must need a companion signal rather than deciding alone.
  it('does NOT decide on a pasted UTM link alone (below threshold)', () => {
    const result = assessBulkMail({
      fromAddress: 'colleague@company.com',
      messageId: '<x@mail.gmail.com>',
      rawBody: '<p>Worth a read: <a href="https://blog.example.com/post?utm_source=twitter">this</a></p>',
    });
    expect(result.isBulk).toBe(false);
    expect(result.signals).toEqual(['utm-campaign-links']);
    expect(result.score).toBeLessThan(3);
  });

  // A UTM link and unsubscribe copy in the sender's OWN content combine past
  // the threshold — neither is enough by itself.
  it('combines two medium signals into a bulk verdict', () => {
    const result = assessBulkMail({
      // A sender and Message-ID that say nothing either way, so the verdict has
      // to come from the two content signals alone.
      fromAddress: 'hello@brand.example',
      messageId: '<x@mail.brand.example>',
      rawBody:
        '<p>Our September picks: <a href="https://brand.example/p?utm_campaign=sept">see them</a></p>' +
        '<p><a href="https://brand.example/u">Unsubscribe</a></p>',
    });
    expect(result.isBulk).toBe(true);
    expect(result.signals).toEqual(['utm-campaign-links', 'unsubscribe-copy']);
  });

  // Reading a body means converting HTML to text, per message. Once the cheap
  // signals have decided, that work must not happen at all.
  it('skips the body entirely once a header/sender signal has decided', () => {
    const result = assessBulkMail({
      tags: '|bulk|',
      rawBody: '<p>Hello {{first_name}}</p>',
    });
    expect(result.signals).toEqual(['bulk-header']);
    expect(result.score).toBe(3);
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

  // The same real marketing email as before, judged on its links and its
  // unsubscribe copy now that the pixel rule is gone.
  it('flags a real marketing email', () => {
    const result = assessBulkMail({
      rawBody:
        '<table role="presentation"><tr><td>Big Sale</td></tr></table>' +
        '<a href="https://click.rs6.net/x?utm_medium=email">Shop</a> · ' +
        '<a href="https://x.example/u">Unsubscribe</a> · <a href="https://x.example/p">Manage preferences</a>',
      fromAddress: 'news@brand.com',
    });
    expect(result.isBulk).toBe(true);
  });

  // A plain-text mail has no tags to convert; feeding it to an HTML parser
  // would swallow anything shaped like one.
  it('reads a plain-text body without an HTML parse', () => {
    expect(senderOwnText('Hi there, see https://x.example/a > and let me know')).toContain('https://x.example/a');
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

describe('bulkHeaderSignals', () => {
  const from = (headers: string) => bulkHeaderSignals(headerLookupFromText(headers));

  // The two RFC list headers and Precedence are what sync has always read; they
  // decide the stored |bulk| tag, which in turn keeps recurring same-subject
  // newsletters out of the subject-based thread fallback.
  it('reads the RFC list headers and Precedence', () => {
    expect(from('List-Id: <news.brand.com>\r\n').listId).toBe(true);
    expect(from('List-Unsubscribe: <https://x.example/u>\r\n').listUnsubscribe).toBe(true);
    expect(from('Precedence: bulk\r\n').precedenceBulk).toBe(true);
    expect(from('Precedence: list\r\n').precedenceBulk).toBe(true);
    expect(from('Precedence: junk\r\n').precedenceBulk).toBe(true);
  });

  // NEW ARM. RFC 3834: `no` is the single value meaning a person sent it, so
  // the test is "present and not no" — not "present". Reading it as presence
  // alone would flag every auto-reply-suppressed human message.
  it('treats Auto-Submitted as bulk unless it is exactly "no"', () => {
    expect(from('Auto-Submitted: auto-generated\r\n').autoSubmitted).toBe(true);
    expect(from('Auto-Submitted: auto-replied\r\n').autoSubmitted).toBe(true);
    expect(from('Auto-Submitted: no\r\n').autoSubmitted).toBe(false);
    expect(from('Subject: hi\r\n').autoSubmitted).toBe(false);
  });

  // The value may carry RFC 3834 parameters after a semicolon; the token before
  // it is the one that decides.
  it('ignores Auto-Submitted parameters after the semicolon', () => {
    expect(from('Auto-Submitted: auto-generated; owner-email=x@y.example\r\n').autoSubmitted).toBe(true);
    expect(from('Auto-Submitted: no; nothing-to-see\r\n').autoSubmitted).toBe(false);
  });

  // NEW ARM. Feedback-ID is added by bulk senders for Google Postmaster Tools;
  // presence alone is the signal.
  it('reads Feedback-ID', () => {
    expect(from('Feedback-ID: 123:campaign:brand\r\n').feedbackId).toBe(true);
    expect(from('Subject: hi\r\n').feedbackId).toBe(false);
  });

  // Vendor tracing headers only exist in a full header block. The ingest fetch
  // does not ask for them, so this arm must stay quiet rather than mis-report.
  it('reads vendor tracing headers, and an ESP X-Mailer but not an ordinary one', () => {
    expect(from('X-Campaign: autumn\r\n').espTrace).toBe(true);
    expect(from('X-SES-Outgoing: 2026.09.15\r\n').espTrace).toBe(true);
    expect(from('X-Mailer: Mailchimp Mailer\r\n').espTrace).toBe(true);
    expect(from('X-Mailer: Apple Mail (2.3774.600.62)\r\n').espTrace).toBe(false);
  });

  // A person's mail carries none of them, and must come back clean on every arm
  // — this is the direction that costs a real conversation when it is wrong.
  it('says nothing about an ordinary personal message', () => {
    const signals = from(
      'From: Mitali <mitali@example.com>\r\nSubject: Re: API doc\r\nX-Mailer: Apple Mail (2.3774)\r\n',
    );
    expect(Object.values(signals).some(Boolean)).toBe(false);
    expect(hasBulkHeaderSignal(headerLookupFromText(
      'From: Mitali <mitali@example.com>\r\nSubject: Re: API doc\r\n',
    ))).toBe(false);
  });

  // Any one arm is enough for the stored tag.
  it('hasBulkHeaderSignal fires on any single arm', () => {
    expect(hasBulkHeaderSignal(headerLookupFromText('Feedback-ID: 1:c:b\r\n'))).toBe(true);
    expect(hasBulkHeaderSignal(headerLookupFromText('Auto-Submitted: auto-generated\r\n'))).toBe(true);
  });

  // The fetch list and the detector must name the same headers: one the
  // detector reads but the fetch omits is a rule that silently never fires.
  it('names every header it reads in BULK_HEADER_NAMES', () => {
    for (const name of ['list-id', 'list-unsubscribe', 'precedence', 'auto-submitted', 'feedback-id']) {
      expect(BULK_HEADER_NAMES).toContain(name);
    }
  });
});

describe('headerValueFromText', () => {
  // Regression the `m`-flag comment describes: a folded value must come back
  // whole. A List-Unsubscribe with a mailto AND an https entry wraps in real
  // mail, and truncating it to the first line loses half the header.
  it('unfolds a value wrapped across lines', () => {
    const headers = 'List-Unsubscribe: <mailto:u@x.example>,\r\n <https://x.example/u>\r\nSubject: hi\r\n';
    expect(headerValueFromText(headers, 'list-unsubscribe')).toBe('<mailto:u@x.example>, <https://x.example/u>');
  });

  it('returns null for an absent or empty header', () => {
    expect(headerValueFromText('Subject: hi\r\n', 'list-id')).toBeNull();
    expect(headerValueFromText('List-Id:\r\nSubject: hi\r\n', 'list-id')).toBeNull();
    expect(headerValueFromText('', 'list-id')).toBeNull();
  });

  // The name is interpolated into a RegExp; a caller passing something with
  // regex punctuation must not silently match the wrong header.
  it('does not treat the header name as a pattern', () => {
    expect(headerValueFromText('X-A-B: yes\r\n', 'x.a.b')).toBeNull();
  });
});

describe('headerValuesFromText', () => {
  // THE regression: a terminator that CONSUMED the newline left the next
  // occurrence with nothing to anchor on, so of two adjacent Received lines
  // only the first was ever found — and the origin-IP fallback silently read
  // an internal hop as the sender.
  it('finds every occurrence, including adjacent ones, in header order', () => {
    const headers = 'Received: from a\r\nReceived: from b\r\nSubject: hi\r\nReceived: from c\r\n';
    expect(headerValuesFromText(headers, 'received')).toEqual(['from a', 'from b', 'from c']);
  });

  it('unfolds each value on its own', () => {
    const headers = 'Received: from a\r\n by b\r\nReceived: from c\r\n\twith d\r\n';
    expect(headerValuesFromText(headers, 'received')).toEqual(['from a by b', 'from c with d']);
  });

  it('is empty for an absent header or an empty block, and skips empty values', () => {
    expect(headerValuesFromText('Subject: hi\r\n', 'received')).toEqual([]);
    expect(headerValuesFromText('', 'received')).toEqual([]);
    expect(headerValuesFromText('Received:\r\nReceived: from a\r\n', 'received')).toEqual(['from a']);
  });

  // The single-value helper is the first of the many — one regex, one rule.
  it('agrees with headerValueFromText on the first value', () => {
    const headers = 'Received: from a\r\nReceived: from b\r\n';
    expect(headerValueFromText(headers, 'received')).toBe(headerValuesFromText(headers, 'received')[0]);
  });
});
