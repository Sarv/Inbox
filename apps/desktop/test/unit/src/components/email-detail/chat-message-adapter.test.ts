// @vitest-environment happy-dom
// The library splits bodies with the DOM, so these tests need a real
// DOMParser. Everything else in this file is a pure function over strings.
import type { EmailRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import {
  attachmentsOf,
  chatMessagesFromConversation,
  bodyOf,
  chatMessagesFromThread,
  draftIdsIn,
  isFromMe,
  isThreadSegmentWarm,
  mailsFromEmails,
  toEpochMs,
  toEpochSeconds,
  warmThreadSegments,
} from '../../../../../src/components/email-detail/chat-message-adapter';
import type { ConversationMessage } from '../../../../../src/services/conversation-service';

import { ELEVEN_AM, email, ME, TEN_AM } from './email-fixture';

function conversationMessage(
  overrides: Partial<ConversationMessage> & { id: string },
): ConversationMessage {
  return {
    fromAddress: 'alice@acme.example',
    fromName: 'Alice Chen',
    toAddress: ME,
    date: TEN_AM,
    body: '<p>Hi</p>',
    isExtracted: true,
    sourceEmailId: 'e1',
    ...overrides,
  };
}

function mapOf(...emails: EmailRecord[]) {
  return new Map(emails.map((each) => [each.id, each]));
}

describe('toEpochMs', () => {
  // Regression: sarvinbox stores SECONDS, the view takes MILLISECONDS. Getting
  // this wrong does not throw — it silently puts the whole thread in January
  // 1970, where every date separator reads the same.
  it('converts stored seconds to the milliseconds the view expects', () => {
    expect(toEpochMs(TEN_AM)).toBe(TEN_AM * 1000);
  });

  // Regression: AI-extracted turns often carry no date (the LLM could not parse
  // a quoted "Sent:" header). `new Date(NaN).toISOString()` THROWS, so anything
  // unusable has to arrive as NaN, which the view renders as its unknown-date
  // group instead of taking the thread down.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('yields NaN for %s', (_label, value) => {
    expect(toEpochMs(value as number | null | undefined)).toBeNaN();
  });
});

describe('toEpochSeconds', () => {
  // Regression: the AI summarizer and the extensions read stored rows, so a
  // transformed message handed to them has to be back in seconds. Off by 1000
  // and the summary reasons about a thread from 1970.
  it('converts the view’s milliseconds back to stored seconds', () => {
    expect(toEpochSeconds(TEN_AM * 1000)).toBe(TEN_AM);
  });

  // Regression: NaN does not survive JSON — it reaches the summarizer as `null`
  // in a numeric field. Zero is the value the store already uses for "no date".
  it.each([
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -5],
  ])('yields 0 for %s', (_label, value) => {
    expect(toEpochSeconds(value)).toBe(0);
  });
});

describe('isFromMe', () => {
  it('matches the reader’s own address, however it is cased or padded', () => {
    expect(isFromMe('  ME@Acme.Example ', ME)).toBe(true);
  });

  it('does not attribute someone else’s message to the reader', () => {
    expect(isFromMe('alice@acme.example', ME)).toBe(false);
  });

  // Regression: when the IMAP username could not be resolved, the caller falls
  // back to the displayed email's recipient LIST. That is not an identity, so
  // attributing against it would flag a recipient as the sender — every bubble
  // goes left instead, which is the honest answer.
  it('attributes nothing when handed a recipient list rather than an identity', () => {
    expect(isFromMe('me@acme.example', 'me@acme.example, bob@acme.example')).toBe(false);
  });

  it('attributes nothing when the reader is unknown', () => {
    expect(isFromMe('alice@acme.example', '')).toBe(false);
    expect(isFromMe(null, ME)).toBe(false);
  });
});

describe('draftIdsIn', () => {
  // Regression: a Gmail draft shares its thread's id, so it is pulled into the
  // thread and would render as a bubble that looks like you already replied.
  it('picks out unsent drafts by their tag', () => {
    const ids = draftIdsIn([
      email({ id: 'e1' }),
      email({ id: 'e2', tags: '|inbox||draft|' }),
      email({ id: 'e3', tags: '|inbox|' }),
    ]);
    expect([...ids]).toEqual(['e2']);
  });
});

describe('attachmentsOf', () => {
  it('maps the stored columns onto the view’s attachment shape', () => {
    const attachments = attachmentsOf(
      email({
        id: 'e1',
        attachmentNames: '["report.pdf","notes.txt"]',
        attachmentSizes: '[20480,512]',
      }),
    );
    expect(attachments).toEqual([
      { filename: 'report.pdf', sizeBytes: 20480 },
      { filename: 'notes.txt', sizeBytes: 512 },
    ]);
  });

  // Regression: the view formats a size with pretty-bytes, which THROWS on a
  // non-finite number. An unknown size has to be absent, not null — a `null`
  // would sail past an `!= null` guard nowhere and reach the formatter.
  it('omits the size entirely when the store did not record one', () => {
    const [attachment] = attachmentsOf(
      email({ id: 'e1', attachmentNames: '["scan.pdf"]', attachmentSizes: null }),
    );
    expect(attachment).toEqual({ filename: 'scan.pdf' });
    expect('sizeBytes' in attachment!).toBe(false);
  });

  it('has nothing to map for a message with no source email', () => {
    expect(attachmentsOf(undefined)).toEqual([]);
  });
});

describe('chatMessagesFromConversation', () => {
  const source = email({
    id: 'e1',
    ccAddress: 'cc@acme.example',
    ccNames: 'Carol',
    attachmentNames: '["report.pdf"]',
    attachmentSizes: '[20480]',
  });

  function convert(
    messages: ConversationMessage[],
    extra: Partial<Parameters<typeof chatMessagesFromConversation>[1]> = {},
  ) {
    return chatMessagesFromConversation(messages, {
      currentUserEmail: ME,
      emailsById: mapOf(source),
      ...extra,
    });
  }

  it('carries every field the view needs across', () => {
    const [message] = convert([conversationMessage({ id: 'm1' })]);
    expect(message).toMatchObject({
      id: 'm1',
      // The source id is what routes an action — reply, download, open
      // original — back to the real underlying mail.
      sourceId: 'e1',
      fromAddress: 'alice@acme.example',
      fromName: 'Alice Chen',
      toAddress: ME,
      ccAddress: 'cc@acme.example',
      ccNames: 'Carol',
      date: TEN_AM * 1000,
      body: '<p>Hi</p>',
      isFromMe: false,
      attachments: [{ filename: 'report.pdf', sizeBytes: 20480 }],
    });
  });

  // Regression: progressive extraction APPENDS a bubble as each email
  // completes, so unsorted they arrive out of order — misordered bubbles and
  // repeated date separators ("Today" … "Yesterday" … "Today").
  it('puts the turns in chronological order however they arrived', () => {
    const messages = convert([
      conversationMessage({ id: 'later', date: ELEVEN_AM }),
      conversationMessage({ id: 'earlier', date: TEN_AM }),
    ]);
    expect(messages.map((each) => each.id)).toEqual(['earlier', 'later']);
  });

  // Regression: also covers bubbles left in an older cache, built before drafts
  // were excluded from extraction at all.
  it('drops a turn extracted from an unsent draft', () => {
    const draft = email({ id: 'e2', tags: '|draft|' });
    const messages = chatMessagesFromConversation(
      [conversationMessage({ id: 'm1' }), conversationMessage({ id: 'm2', sourceEmailId: 'e2' })],
      { currentUserEmail: ME, emailsById: mapOf(source, draft) },
    );
    expect(messages.map((each) => each.id)).toEqual(['m1']);
  });

  it('right-aligns the reader’s own turn', () => {
    const [message] = convert([conversationMessage({ id: 'm1', fromAddress: ME })]);
    expect(message!.isFromMe).toBe(true);
  });

  // Regression: inline images are stored as `sarv-image:<id>` refs, not data
  // URLs. Unresolved, every inline image in the thread renders broken.
  it('resolves inline image refs through the host’s cache', () => {
    const [message] = convert([conversationMessage({ id: 'm1', body: '<img src="sarv-image:ab">' })], {
      resolveImages: (html) => html.replace('sarv-image:ab', 'data:image/png;base64,AA'),
    });
    expect(message!.body).toBe('<img src="data:image/png;base64,AA">');
  });

  describe('body state', () => {
    // Regression: a spinner that never stops is the failure the reader cannot
    // act on — a permanently failed body must offer a retry instead.
    it('marks a body that failed for good as failed, not pending', () => {
      const [message] = convert([conversationMessage({ id: 'm1', body: '' })], {
        failedBodies: new Set(['e1']),
      });
      expect(message).toMatchObject({ bodyFailed: true });
      expect(message!.bodyPending).toBeUndefined();
    });

    it('marks a body that has not arrived yet as pending', () => {
      const [message] = convert([conversationMessage({ id: 'm1', body: '' })]);
      expect(message).toMatchObject({ bodyPending: true });
      expect(message!.bodyFailed).toBeUndefined();
    });

    // Regression: a body that HAS arrived must carry neither flag, or the view
    // flickers back to a spinner over content it already has.
    it('leaves a body that arrived alone', () => {
      const [message] = convert([conversationMessage({ id: 'm1' })], {
        failedBodies: new Set(['e1']),
      });
      expect(message!.bodyPending).toBeUndefined();
      expect(message!.bodyFailed).toBeUndefined();
    });

    // Known limitation, stated rather than hidden: a turn whose source email is
    // not in the thread map cannot be pending OR failed, because there is no id
    // to retry with. It renders as an empty bubble.
    it('claims neither state for a turn whose source email is missing', () => {
      const [message] = convert([
        conversationMessage({ id: 'm1', body: '', sourceEmailId: 'gone' }),
      ]);
      expect(message!.bodyPending).toBeUndefined();
      expect(message!.bodyFailed).toBeUndefined();
    });
  });
});

describe('mailsFromEmails', () => {
  it('describes a stored row in the shape the library reads', () => {
    const [mail] = mailsFromEmails([
      email({ id: 'e1', rawBody: '<p>Body</p>', toNames: 'Me', ccAddress: 'cc@acme.example' }),
    ]);
    expect(mail).toMatchObject({
      id: 'e1',
      fromAddress: 'alice@acme.example',
      fromName: 'Alice Chen',
      toAddress: ME,
      toNames: 'Me',
      ccAddress: 'cc@acme.example',
      // SECONDS, unconverted: the transform is told the unit and converts once
      // itself. Converting here as well puts the thread 56,000 years out.
      date: TEN_AM,
      body: '<p>Body</p>',
      isDraft: false,
    });
  });

  // Regression: cleanBody is stripped Markdown kept for search and list rows;
  // splitting it in place of the real HTML loses every link and image, and the
  // DOM rules have no markup left to recognise a quote by.
  it('prefers the original HTML over the stripped copy', () => {
    const [mail] = mailsFromEmails([
      email({ id: 'e1', rawBody: '<p>HTML</p>', cleanBody: 'plain' }),
    ]);
    expect(mail!.body).toBe('<p>HTML</p>');
  });

  it('falls back to the stripped copy when no HTML was fetched', () => {
    const [mail] = mailsFromEmails([email({ id: 'e1', rawBody: '', cleanBody: 'plain' })]);
    expect(mail!.body).toBe('plain');
  });

  // Regression: a draft is a `|draft|` TAG here, not a column — the library
  // cannot see that, so this is the one place it gets told.
  it('flags an unsent draft so the library can leave it out', () => {
    const mails = mailsFromEmails([email({ id: 'e1' }), email({ id: 'e2', tags: '|draft|' })]);
    expect(mails.map((mail) => mail.isDraft)).toEqual([false, true]);
  });

  // Regression: "the body has not arrived" is the failed-bodies set here, not a
  // flag on the row, so a permanent failure has to be handed over explicitly or
  // the bubble spins forever instead of offering a retry.
  it('carries the pending and failed body states over', () => {
    const [pending, failed] = mailsFromEmails(
      [email({ id: 'e1', rawBody: '' }), email({ id: 'e2', rawBody: '' })],
      new Set(['e2']),
    );
    expect(pending).toMatchObject({ bodyPending: true });
    expect(failed).toMatchObject({ bodyFailed: true });
  });

  // Regression: `fromAddress` is typed non-null, but the SQLite column is not,
  // and a row written before the sender was parsed genuinely carries NULL. The
  // library requires a string, so the null has to stop here — the cast is the
  // point of the test, not an oversight.
  it('never hands the library a null sender', () => {
    const [mail] = mailsFromEmails([
      email({ id: 'e1', fromAddress: null as unknown as string }),
    ]);
    expect(mail!.fromAddress).toBe('');
  });
});

describe('chatMessagesFromThread', () => {
  /**
   * A Gmail-style reply: Bob's own line, then the attribution and Alice's
   * quoted message. Alice's mail is NOT in the thread — the only copy of it is
   * this quote, which is exactly the case the library exists to recover.
   */
  const BOB_REPLY = [
    '<div dir="ltr">Thanks Alice, that works.</div>',
    '<div class="gmail_quote">',
    '<div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br>',
    '</div>',
    '<blockquote class="gmail_quote"><div dir="ltr">Can we move Q3 to Friday?</div></blockquote>',
    '</div>',
  ].join('');

  function convert(emails: EmailRecord[], extra: Partial<{ resolveImages: (html: string) => string; failedBodies: ReadonlySet<string> }> = {}) {
    return chatMessagesFromThread(emails, { currentUserEmail: ME, ...extra });
  }

  // Regression: the whole point of the Standard view. Render one bubble per
  // MAIL and Alice's message is invisible — it exists nowhere but inside Bob's
  // reply, so the conversation reads as if Bob spoke first, unprompted.
  it('recovers a message that exists only as a quote', () => {
    const messages = convert([
      email({
        id: 'e2',
        fromAddress: 'bob@acme.example',
        fromName: 'Bob Ray',
        date: ELEVEN_AM,
        rawBody: BOB_REPLY,
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ fromAddress: 'alice@acme.example', sourceId: 'e2' });
    expect(messages[0]!.body).toContain('Q3 to Friday');
    expect(messages[1]).toMatchObject({ id: 'e2', fromAddress: 'bob@acme.example' });
    // The quoted history is Alice's bubble now, not part of Bob's.
    expect(messages[1]!.body).not.toContain('Q3 to Friday');
  });

  // Regression: the quote's date must be read from its attribution line, not
  // borrowed from the reply carrying it — otherwise both bubbles land on 11:00
  // and the thread cannot be read as a sequence.
  it('dates the recovered message from its own attribution line', () => {
    const [quoted, own] = convert([
      email({ id: 'e2', fromAddress: 'bob@acme.example', date: ELEVEN_AM, rawBody: BOB_REPLY }),
    ]);
    expect(own!.date).toBe(ELEVEN_AM * 1000);
    expect(quoted!.date).toBeLessThan(own!.date);
  });

  // Regression: image refs must be resolved on the SPLIT bodies, not the raw
  // mail. Resolving first inlines every image in the quoted history — most of
  // which is about to be thrown away — and the call count is the only thing
  // that can tell the two orders apart.
  it('resolves inline image refs on each split body, not on the raw mail', () => {
    const resolveImages = vi.fn((html: string) => html.replace('sarv-image:ab', 'data:image/png;base64,AA'));
    const messages = convert(
      [email({ id: 'e2', fromAddress: 'bob@acme.example', date: ELEVEN_AM, rawBody: BOB_REPLY })],
      { resolveImages },
    );
    expect(resolveImages).toHaveBeenCalledTimes(messages.length);
    expect(resolveImages).not.toHaveBeenCalledWith(BOB_REPLY);
  });

  it('leaves bodies untouched when the host resolves no images', () => {
    const [message] = convert([email({ id: 'e1', rawBody: '<p>Body</p>' })]);
    expect(message!.body).toContain('Body');
  });

  it('drops unsent drafts and orders the rest oldest first', () => {
    const messages = convert([
      email({ id: 'later', date: ELEVEN_AM, rawBody: '<p>b</p>' }),
      email({ id: 'draft', tags: '|draft|', rawBody: '<p>d</p>' }),
      email({ id: 'earlier', date: TEN_AM, rawBody: '<p>a</p>' }),
    ]);
    expect(messages.map((each) => each.id)).toEqual(['earlier', 'later']);
  });

  it('marks an email whose body never arrived as pending', () => {
    const [message] = convert([email({ id: 'e1', rawBody: '', cleanBody: '' })]);
    expect(message).toMatchObject({ bodyPending: true });
  });

  it('offers a retry for an email whose body failed for good', () => {
    const [message] = convert([email({ id: 'e1', rawBody: '', cleanBody: '' })], {
      failedBodies: new Set(['e1']),
    });
    expect(message).toMatchObject({ bodyFailed: true });
  });

  it('right-aligns the reader’s own message', () => {
    const [message] = convert([email({ id: 'e1', fromAddress: ME, rawBody: '<p>Mine</p>' })]);
    expect(message!.isFromMe).toBe(true);
  });

  it('has nothing to show for an empty thread', () => {
    expect(convert([])).toEqual([]);
  });
});

describe('bodyOf', () => {
  // Regression: the segment cache is keyed on this string. If the warm and the
  // render ever disagree about which column the body comes from, every warmed
  // entry is a miss and nothing says so — the view just does the work twice.
  it('prefers the original HTML and falls back to the stripped preview', () => {
    expect(bodyOf(email({ id: 'e1', rawBody: '<p>raw</p>', cleanBody: 'clean' }))).toBe('<p>raw</p>');
    expect(bodyOf(email({ id: 'e2', rawBody: '', cleanBody: 'clean' }))).toBe('clean');
    expect(bodyOf(email({ id: 'e3', rawBody: '', cleanBody: '' }))).toBe('');
  });
});

describe('warmThreadSegments', () => {
  /** A fresh id per assertion — the segment cache is shared and long-lived. */
  let serial = 0;
  const fresh = (body: string) =>
    email({ id: `warm-${(serial += 1)}`, date: ELEVEN_AM, rawBody: body });

  const QUOTING_REPLY = [
    '<div dir="ltr">Thanks Alice, that works.</div>',
    '<div class="gmail_quote">',
    '<div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br>',
    '</div>',
    '<blockquote class="gmail_quote"><div dir="ltr">Can we move Q3 to Friday?</div></blockquote>',
    '</div>',
  ].join('');

  // Regression: the whole point. If the warm writes an entry the render path
  // does not look for, the click that opens the chat view still splits the
  // whole thread — and the only symptom is that it stayed slow.
  it('leaves the split where the chat view will find it', () => {
    const mail = fresh(QUOTING_REPLY);
    expect(isThreadSegmentWarm(mail)).toBe(false);

    warmThreadSegments([mail], { currentUserEmail: ME });

    expect(isThreadSegmentWarm(mail)).toBe(true);
  });

  // Regression: warming a slice at a time is only safe because a mail's
  // segments do not depend on the mails around it. If that ever stops being
  // true the chunked warm would serve the view a DIFFERENT split than the one
  // it would have computed — wrong bubbles, not just slow ones.
  it('produces the same bubbles warmed one mail at a time as in one pass', () => {
    const first = fresh(QUOTING_REPLY);
    const second = email({ id: `warm-${(serial += 1)}`, date: TEN_AM, rawBody: '<p>Earlier</p>' });
    const cold = chatMessagesFromThread([first, second], { currentUserEmail: ME });

    const warmFirst = fresh(QUOTING_REPLY);
    const warmSecond = email({
      id: `warm-${(serial += 1)}`,
      date: TEN_AM,
      rawBody: '<p>Earlier</p>',
    });
    warmThreadSegments([warmFirst], { currentUserEmail: ME });
    warmThreadSegments([warmSecond], { currentUserEmail: ME });
    const warmed = chatMessagesFromThread([warmFirst, warmSecond], { currentUserEmail: ME });

    expect(warmed.map((each) => each.body)).toEqual(cold.map((each) => each.body));
    expect(warmed.map((each) => each.date)).toEqual(cold.map((each) => each.date));
  });

  // Regression: a body that arrives late replaces an empty one, and the entry
  // warmed for the old text must not be served for the new. The cache is keyed
  // on the body for exactly this, so the warm must key it the same way.
  it('does not count a mail as warm once its body changes', () => {
    const mail = fresh('<p>First</p>');
    warmThreadSegments([mail], { currentUserEmail: ME });

    expect(isThreadSegmentWarm({ ...mail, rawBody: '<p>Second</p>' })).toBe(false);
  });

  // Regression: a mail with no body has nothing to split, and calling it warm
  // would let the walk skip it forever — the body would land and never be
  // split ahead of the click.
  it('never calls a mail with no body warm', () => {
    const mail = email({ id: `warm-${(serial += 1)}`, rawBody: '', cleanBody: '' });
    warmThreadSegments([mail], { currentUserEmail: ME });

    expect(isThreadSegmentWarm(mail)).toBe(false);
  });

  it('has nothing to do for an empty slice', () => {
    expect(() => warmThreadSegments([], { currentUserEmail: ME })).not.toThrow();
  });
});
