// @vitest-environment happy-dom
// The library splits bodies with the DOM, so these tests need a real
// DOMParser. Everything else in this file is a pure function over strings.
import type { ChatMessage } from '@sarv-in/email-chat-view';
import type { EmailRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import {
  AS_SENT_MARKER,
  asSentEmailIds,
  attachmentsOf,
  carrierEmailOf,
  chatMessagesFromConversation,
  bodyOf,
  chatMessagesFromThread,
  draftIdsIn,
  dropDuplicateQuotes,
  isFromMe,
  normalizedContent,
  ownerEmailOf,
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
    const [message] = convert(
      [conversationMessage({ id: 'm1', body: '<img src="sarv-image:ab">' })],
      {
        resolveImages: (html) => html.replace('sarv-image:ab', 'data:image/png;base64,AA'),
      }
    );
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
    const [mail] = mailsFromEmails([email({ id: 'e1', fromAddress: null as unknown as string })]);
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

  function convert(
    emails: EmailRecord[],
    extra: Partial<{
      resolveImages: (html: string) => string;
      recolorBody: (html: string) => string;
      failedBodies: ReadonlySet<string>;
    }> = {}
  ) {
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
    const resolveImages = vi.fn((html: string) =>
      html.replace('sarv-image:ab', 'data:image/png;base64,AA')
    );
    const messages = convert(
      [email({ id: 'e2', fromAddress: 'bob@acme.example', date: ELEVEN_AM, rawBody: BOB_REPLY })],
      { resolveImages },
    );
    expect(resolveImages).toHaveBeenCalledTimes(messages.length);
    expect(resolveImages).not.toHaveBeenCalledWith(BOB_REPLY);
  });

  // Regression: the chat view never re-coloured a body at all. Its frame takes
  // its canvas from the app theme, so a sender's `color:black` stayed black on
  // a dark canvas and a `background:white` painted a white slab across the
  // bubble — the same message read correctly in the Standard view and only
  // there. The hook is what lets the view hand its dark-mode rewrite in.
  it('re-colours each split body through the host', () => {
    const recolorBody = vi.fn((html: string) => `${html}<!--dark-->`);
    const messages = convert([email({ id: 'e1', rawBody: '<p>Body</p>' })], { recolorBody });
    expect(recolorBody).toHaveBeenCalledTimes(messages.length);
    expect(messages[0]!.body).toContain('<!--dark-->');
  });

  // Regression: the rewrite has to run BEFORE the image refs are resolved. Put
  // it after and every walk drags a base64 payload per inline image through a
  // DOM parse, on the click that opens the thread. (It runs after the mail's
  // stylesheet is inlined for the opposite reason — the rewrite reads `style`
  // attributes and nothing else — which `chat-body-styles.test.ts` covers.)
  it('re-colours before the image refs are resolved', () => {
    const calls: string[] = [];
    convert(
      [email({ id: 'e1', rawBody: '<p><img src="sarv-image:ab">Hello</p>' })],
      {
        recolorBody: (html) => {
          calls.push('recolor');
          expect(html).toContain('sarv-image:ab');
          return html;
        },
        resolveImages: (html) => {
          calls.push('resolve');
          return html.replace('sarv-image:ab', 'data:image/png;base64,AA');
        },
      },
    );
    expect(calls).toEqual(['recolor', 'resolve']);
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

  // Regression: a first message typed in Outlook has no quote to split on, and
  // every Enter the sender pressed is its own empty paragraph. The bubble drew
  // all of them, a wall of blank lines between the greeting and the update.
  // Needs @sarv-in/email-chat-view 0.2.4, which caps a run at two blank lines.
  it('caps a wall of blank lines in a first message typed in Outlook', () => {
    const blank = '<p class="MsoNormal"><o:p>&nbsp;</o:p></p>';
    const [message] = convert([
      email({
        id: 'e1',
        rawBody:
          '<div class="WordSection1"><p class="MsoNormal">Hi Sorabh,</p>' +
          blank.repeat(7) +
          '<p class="MsoNormal">Please find the latest update below.</p></div>',
      }),
    ]);

    expect(message!.body.match(/<o:p>/g)).toHaveLength(2);
    expect(message!.body).toContain('Please find the latest update below.');
    expect(message!.applied).toContain('collapse:blank-run');
  });

  // Regression: a Google Sheets range pasted into Gmail declares
  // `table-layout:fixed;width:0px` and is sized ONLY by its `<col width>`
  // attributes. Losing them anywhere between the store and the frame collapses
  // the table to one pixel wide, which reads as a screen of blank lines under
  // "Please find the latest update below". This guards the app's half of that
  // path; the frame's sanitizer is guarded in the library (0.2.4).
  it('hands the view a pasted spreadsheet with its column widths intact', () => {
    const sheet =
      '<table cellspacing="0" cellpadding="0" dir="ltr" border="1" ' +
      'style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse">' +
      '<colgroup><col width="64"><col width="215"></colgroup><tbody>' +
      '<tr><td>SL NO</td><td>Description</td></tr>' +
      '<tr><td>1</td><td>Chatbot shows developer details</td></tr>' +
      '<tr><td>2</td><td>Incorrect source links</td></tr>' +
      '</tbody></table>';
    const [message] = convert([
      email({
        id: 'e1',
        rawBody: `<div dir="ltr">Hi Sorabh,<br><br>Please find the latest update below:<br>${sheet}</div>`,
      }),
    ]);

    expect(message!.body).toContain('<col width="64"><col width="215">');
    expect(message!.body).toContain('table-layout:fixed');
  });
});

/**
 * Which stored mail a bubble belongs to.
 *
 * What breaks if this block goes red: the bubble showing a message recovered
 * from a quote goes back to acting on the mail that QUOTED it — it shows that
 * mail's attachments under the quoted author's name, and its star, archive and
 * delete reach a message the reader is not looking at.
 */
describe('ownerEmailOf', () => {
  const CARRIER = email({ id: 'e2', fromAddress: 'bob@acme.example', date: ELEVEN_AM });

  // Regression: a mail's own turn loses its actions and its attachment strip.
  it('gives a mail’s own bubble its mail', () => {
    expect(ownerEmailOf({ id: 'e2', fromAddress: 'bob@acme.example' }, mapOf(CARRIER))).toBe(
      CARRIER
    );
  });

  // Regression: THE bug. `sourceId` on a recovered quote is the carrier, so a
  // straight lookup hands Alice's bubble Bob's mail.
  it('gives a quote recovered from a mail no email at all', () => {
    expect(
      ownerEmailOf(
        { id: 'e2#1', sourceId: 'e2', fromAddress: 'alice@acme.example' },
        mapOf(CARRIER)
      )
    ).toBeUndefined();
  });

  // Regression: the AI view loses every action. An extracted turn's id is the
  // model's, never the mail's, so id equality alone cannot answer for it — the
  // sender does.
  it('gives an extracted turn the mail it was carved from when the senders agree', () => {
    expect(
      ownerEmailOf({ id: 'm-7', sourceId: 'e2', fromAddress: 'BOB@Acme.Example ' }, mapOf(CARRIER))
    ).toBe(CARRIER);
    expect(
      ownerEmailOf({ id: 'm-8', sourceId: 'e2', fromAddress: 'alice@acme.example' }, mapOf(CARRIER))
    ).toBeUndefined();
  });

  it('has no email for a bubble whose mail is not in the thread', () => {
    expect(
      ownerEmailOf({ id: 'gone', fromAddress: 'bob@acme.example' }, mapOf(CARRIER))
    ).toBeUndefined();
  });
});

/**
 * Which mail a bubble's BYTES came out of — a different question, deliberately.
 *
 * What breaks if this goes red: a reader who chose to load remote images from
 * this sender sees the blocked-images banner on every quoted bubble, because
 * the decision was made with no mail to check.
 */
describe('carrierEmailOf', () => {
  const CARRIER = email({ id: 'e2', fromAddress: 'bob@acme.example', date: ELEVEN_AM });

  it('follows a recovered quote back to the mail that carried it', () => {
    expect(carrierEmailOf({ id: 'e2#1', sourceId: 'e2' }, mapOf(CARRIER))).toBe(CARRIER);
    expect(carrierEmailOf({ id: 'e2' }, mapOf(CARRIER))).toBe(CARRIER);
  });
});

/**
 * The same message, sent once and quoted back once.
 *
 * What breaks if this block goes red: a thread renders more turns than it has
 * messages — the reader sees the same mail twice under one sender header, the
 * second copy carrying whatever the reply that quoted it happened to attach.
 * The library's own dedupe compares the first 150 characters for EQUALITY,
 * which a confidentiality banner on one copy and not the other defeats.
 */
describe('duplicate recovered quotes', () => {
  /** Alice's mail as she sent it — her client stamps a banner on every one. */
  const ALICE_SENT = [
    '<div>Acme Confidential</div>',
    '<div dir="ltr">Can we move the Q3 review to Friday? The room is booked all',
    ' Thursday and half the team is out.</div>',
  ].join('');

  /** The same message as Bob's client quoted it back — banner gone. */
  const BOB_QUOTING_ALICE = [
    '<div dir="ltr">Friday works.</div>',
    '<div class="gmail_quote">',
    '<div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br>',
    '</div>',
    '<blockquote class="gmail_quote"><div dir="ltr">Can we move the Q3 review to',
    ' Friday? The room is booked all Thursday and half the team is out.</div></blockquote>',
    '</div>',
  ].join('');

  const convert = (emails: EmailRecord[]) =>
    chatMessagesFromThread(emails, { currentUserEmail: ME });

  // Regression: THE duplicate. Both copies render, one above the other, and the
  // view looks like it invented a message.
  it('drops the quoted copy of a mail the thread already shows', () => {
    const messages = convert([
      email({ id: 'e1', fromAddress: 'alice@acme.example', date: TEN_AM, rawBody: ALICE_SENT }),
      email({
        id: 'e2',
        fromAddress: 'bob@acme.example',
        date: ELEVEN_AM,
        rawBody: BOB_QUOTING_ALICE,
      }),
    ]);

    expect(messages.map((each) => each.id)).toEqual(['e1', 'e2']);
    // The stored mail is the copy that survives, banner and all — never the
    // second-hand one.
    expect(messages[0]!.body).toContain('Acme Confidential');
  });

  // Regression: the fix eats the feature. A message that exists ONLY inside a
  // reply is the whole reason the split recovers quotes at all.
  it('still recovers a quote of a message that is not in the thread', () => {
    const messages = convert([
      email({
        id: 'e2',
        fromAddress: 'bob@acme.example',
        date: ELEVEN_AM,
        rawBody: BOB_QUOTING_ALICE,
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ fromAddress: 'alice@acme.example', sourceId: 'e2' });
  });

  // Regression: one message quoted by three separate replies renders three
  // times — the library's exact key misses them for the same reason.
  it('recovers a message quoted by two different replies exactly once', () => {
    const second = BOB_QUOTING_ALICE.replace('Friday works.', 'Agreed, Friday.');
    const messages = convert([
      email({
        id: 'e2',
        fromAddress: 'bob@acme.example',
        date: ELEVEN_AM,
        rawBody: BOB_QUOTING_ALICE,
      }),
      email({ id: 'e3', fromAddress: 'carol@acme.example', date: ELEVEN_AM + 60, rawBody: second }),
    ]);

    expect(messages.filter((each) => each.fromAddress === 'alice@acme.example')).toHaveLength(1);
  });

  // Regression: the compare is unanchored, so without a length floor a one-line
  // "Ship it." somewhere in the thread would delete any quoted message that
  // merely opens with those words — mail vanishing silently, the worst failure
  // this view has.
  it('keeps a recovered quote that merely opens with a short mail’s words', () => {
    const quoting = [
      '<div dir="ltr">Will do.</div>',
      '<div class="gmail_quote">',
      '<div dir="ltr" class="gmail_attr">',
      'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br>',
      '</div>',
      '<blockquote class="gmail_quote"><div dir="ltr">Ship it on Friday once the',
      ' release notes are signed off by legal and by marketing.</div></blockquote>',
      '</div>',
    ].join('');

    const messages = convert([
      email({
        id: 'e1',
        fromAddress: 'carol@acme.example',
        date: TEN_AM,
        rawBody: '<p>Ship it.</p>',
      }),
      email({ id: 'e2', fromAddress: 'bob@acme.example', date: ELEVEN_AM, rawBody: quoting }),
    ]);

    expect(messages.filter((each) => each.fromAddress === 'alice@acme.example')).toHaveLength(1);
  });
});

describe('dropDuplicateQuotes', () => {
  const bubble = (over: Partial<ChatMessage> & { id: string }): ChatMessage =>
    ({ fromAddress: 'alice@acme.example', date: TEN_AM * 1000, body: '', ...over }) as ChatMessage;

  // Regression: a stored mail disappears because another mail in the thread
  // repeats it. Only quotes are ever dropped — a mail is a fact.
  it('never drops a mail’s own turn, however much it repeats another', () => {
    const body = '<p>The migration window is Saturday 02:00 to 06:00 UTC, as agreed.</p>';
    const kept = dropDuplicateQuotes([bubble({ id: 'e1', body }), bubble({ id: 'e2', body })]);
    expect(kept.map((each) => each.id)).toEqual(['e1', 'e2']);
  });
});

describe('normalizedContent', () => {
  // Regression: the compare stops seeing through the cosmetic differences
  // between a message and the copy a client quoted back — an entity for a
  // space, a mention that became a link, a re-wrapped line.
  it('reduces a body to the letters and digits that survive being quoted', () => {
    expect(
      normalizedContent('<p>Hi&nbsp;<a href="mailto:a@b.c">@Ankur D</a>, ship&#8203;</p>')
    ).toBe(normalizedContent('Hi @Ankur D,\n ship'));
  });
});

describe('bodyOf', () => {
  // Regression: the segment cache is keyed on this string. If the warm and the
  // render ever disagree about which column the body comes from, every warmed
  // entry is a miss and nothing says so — the view just does the work twice.
  it('prefers the original HTML and falls back to the stripped preview', () => {
    expect(bodyOf(email({ id: 'e1', rawBody: '<p>raw</p>', cleanBody: 'clean' }))).toBe(
      '<p>raw</p>'
    );
    expect(bodyOf(email({ id: 'e2', rawBody: '', cleanBody: 'clean' }))).toBe('clean');
    expect(bodyOf(email({ id: 'e3', rawBody: '', cleanBody: '' }))).toBe('');
  });
});

/**
 * Mail the reader must see EXACTLY as it was sent.
 *
 * What breaks if this block goes red: a notification is run through the
 * conversational strip chain again and reaches the reader as a wireframe. The
 * digest below is the shape that proved it — `signature:logo-strip` deletes its
 * whole app-badge footer, both images and 60% of its bytes, with nothing in the
 * UI to say anything was removed.
 */
describe('as-sent mail', () => {
  /** A designed notification: a layout table on a white card, then an
   *  app-badge footer — the block the strip chain eats. */
  const DIGEST = [
    '<table width="600" bgcolor="#ffffff" role="presentation"><tr><td>',
    '<h2>Daily Email Digest</h2>',
    '<p>You have 3 pending approvals.</p>',
    '</td></tr></table>',
    '<table role="presentation"><tr><td>',
    '<a href="https://example.test/ios"><img src="https://cdn.example.test/appstore.png" alt="App Store"></a>',
    '<a href="https://example.test/android"><img src="https://cdn.example.test/play.png" alt="Google Play"></a>',
    '</td></tr></table>',
  ].join('');

  const digest = (overrides: Partial<EmailRecord> = {}) =>
    email({
      id: 'keka-1',
      date: TEN_AM,
      fromName: 'Sarv.com',
      fromAddress: 'no-reply@kekamail.com',
      messageId: '<k1@kekamail.com>',
      rawBody: DIGEST,
      tags: '|INBOX|bulk|',
      ...overrides,
    });

  // Regression: the content loss itself. Byte-for-byte, because "most of it
  // survived" is exactly the failure — the footer, the logo and the QR code
  // were the part that went.
  it('hands the bubble a machine-sent designed mail byte for byte', () => {
    const [message] = chatMessagesFromThread([digest()], { currentUserEmail: ME });
    expect(message!.body).toBe(DIGEST);
  });

  /** The daily digest as MJML really emits it: the sizes that make the text
   *  visible live in a class, the wide layout lives in a min-width query, and
   *  the wrapper cell sets `font-size:0px` to kill inline-block whitespace. */
  const MJML_DIGEST = [
    '<!doctype html><html><head><style type="text/css">',
    '@media only screen and (min-width:480px){.mj-column-per-50{width:50%!important}}',
    '.employee-name{font-size:28px}',
    '</style></head><body style="word-spacing:normal;">',
    '<table role="presentation"><tbody><tr><td style="font-size:0px;text-align:center;">',
    '<div class="mj-column-per-50" style="display:inline-block;width:100%;">',
    '<img src="https://cdn.example.test/keka.png" alt="keka"></div>',
    '<div class="employee-name">Hello, Ankur Dubey</div>',
    '</td></tr></tbody></table></body></html>',
  ].join('');

  // Regression: the digest reached the chat view with "Hello, Ankur Dubey" and
  // its section headings MISSING and its header and footer rows stacked one
  // item per line, while the standard view drew it correctly. The frame's
  // sanitizer removes `<style>`, so a size that lived in a class was inherited
  // from a `font-size:0px` cell instead — the text rendered at zero.
  it('writes a designed mail’s own stylesheet onto the mail before the frame drops it', () => {
    const [message] = chatMessagesFromThread([digest({ rawBody: MJML_DIGEST })], {
      currentUserEmail: ME,
    });
    expect(message!.body).toContain('font-size: 28px');
    expect(message!.body).toContain('width: 50%');
    expect(message!.body).toContain('Hello, Ankur Dubey');
    // Left in place the sanitizer keeps the CSS as TEXT and prints it above the
    // message, so the stylesheet itself must be gone.
    expect(message!.body).not.toContain('<style');
  });

  // Regression: without the marker the library's per-sender pastel paints
  // straight over the email — `data-sec-applied` is the only per-bubble hook
  // the app's stylesheet has. Replaced, not appended: nothing shaped this body.
  it('marks the bubble as untouched so the view can style it', () => {
    const [message] = chatMessagesFromThread([digest()], { currentUserEmail: ME });
    expect(message!.applied).toEqual([AS_SENT_MARKER]);
  });

  // The fixture has to be one the strip chain really does mangle, or the test
  // above passes for the wrong reason and protects nothing.
  it('is a body the ordinary split would have mangled', () => {
    const [message] = chatMessagesFromThread(
      [
        digest({
          tags: '|INBOX|',
          fromAddress: 'alice@acme.example',
          messageId: '<a1@mail.gmail.com>',
        }),
      ],
      {
        currentUserEmail: ME,
      }
    );
    expect(message!.body).not.toBe(DIGEST);
    expect(message!.body).not.toContain('appstore.png');
  });

  // Regression: THE long-thread guarantee. One reply makes this a conversation,
  // and a conversation gets the chat treatment — all of it, so a thread never
  // renders half one way and half the other.
  it('gives up on the whole thread as soon as a second sender appears', () => {
    const messages = chatMessagesFromThread(
      [digest(), email({ id: 'reply-1', date: ELEVEN_AM, rawBody: '<p>Got it.</p>' })],
      { currentUserEmail: ME },
    );
    expect(asSentEmailIds([digest(), email({ id: 'reply-1' })]).size).toBe(0);
    expect(messages.every((each) => each.applied?.includes(AS_SENT_MARKER))).toBe(false);
    expect(messages.find((each) => each.id === 'keka-1')!.body).not.toBe(DIGEST);
  });

  // Regression: a person's reply carrying a signature logo passes BOTH of the
  // per-mail rules — `looksDesigned` fires on the one image, and the `|bulk|`
  // tag is set from headers a corporate server puts on ordinary mail. Without
  // the thread gate it was restored to its full raw source, quoted history and
  // all, and rendered beside the clean bubble of the very same message.
  it('never claims a person\u2019s signed reply in a thread somebody answered', () => {
    const signedReply = email({
      id: 'shikhar-1',
      date: TEN_AM,
      fromName: 'Shikhar Khanna',
      fromAddress: 'shikhar@acme.example',
      // Enough to trip `isBulkMail` on its own — one of the several ways an
      // ordinary reply picks up the tag (a server-set `Precedence`, a
      // `List-Unsubscribe` on a corporate footer, an ESP-shaped Message-ID).
      tags: '|INBOX|bulk|',
      rawBody: [
        '<p>Hello Rakesh,</p><p>I havent received anything yet</p><p><b>Regards,</b></p>',
        '<img src="https://cdn.acme.example/sarv-logo.png" alt="Sarv">',
        '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">',
        'On Sat, Jul 18, 2026 at 3:06 PM, rakesh kumawat &lt;rakesh@acme.example&gt; wrote:<br>',
        '</div><blockquote class="gmail_quote"><div dir="ltr">',
        'As I mentioned, all possible logic will be handled on the backend.',
        '</div></blockquote></div>',
      ].join(''),
    });
    const rakesh = email({
      id: 'rakesh-1',
      date: ELEVEN_AM,
      fromAddress: 'rakesh@acme.example',
      rawBody: '<p>As I mentioned, all possible logic will be handled on the backend.</p>',
    });

    // Both per-mail rules really do pass on this mail, or the gate below is
    // being credited for a decision something else already made.
    expect(asSentEmailIds([signedReply]).size).toBe(1);

    expect(asSentEmailIds([signedReply, rakesh]).size).toBe(0);
    const messages = chatMessagesFromThread([signedReply, rakesh], { currentUserEmail: ME });
    expect(messages.some((each) => each.applied?.includes(AS_SENT_MARKER))).toBe(false);
  });

  // Regression: `looksDesigned` is true of any mail carrying ONE image, a
  // signature logo included. Only the machine-sent test keeps a person's mail —
  // even a single-sender run of them — out of the as-sent path.
  it('leaves a person’s designed-looking mail in the chat treatment', () => {
    const fromAlice = digest({
      id: 'alice-1',
      tags: '|INBOX|',
      fromAddress: 'alice@acme.example',
      fromName: 'Alice Chen',
      messageId: '<a1@mail.gmail.com>',
    });
    expect(asSentEmailIds([fromAlice]).size).toBe(0);
  });

  // Regression: a designed mail the split read as quoting something used to be
  // abandoned — it reached the reader as several mangled turns, which is how a
  // login alert arrived as two stripped copies of itself. The extra turns are
  // dropped instead, because the restored body already contains every one of
  // them: one bubble, showing the mail whole.
  it('collapses a designed mail back to one bubble when the split recovered extra turns', () => {
    const quotedBody = `${DIGEST}<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br></div><blockquote class="gmail_quote"><div dir="ltr">Can we move Q3 to Friday?</div></blockquote></div>`;
    const quoting = digest({ id: 'keka-2', rawBody: quotedBody });

    // The split really does carve this body into more than one turn — proven on
    // the same body sent by a person, which the as-sent path never claims — or
    // the assertions below pass for the wrong reason and protect nothing.
    const fromAlice = chatMessagesFromThread(
      [
        digest({
          id: 'alice-2',
          rawBody: quotedBody,
          tags: '|INBOX|',
          fromAddress: 'alice@acme.example',
          messageId: '<a2@mail.gmail.com>',
        }),
      ],
      { currentUserEmail: ME }
    );
    expect(fromAlice.length).toBeGreaterThan(1);

    const messages = chatMessagesFromThread([quoting], { currentUserEmail: ME });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('keka-2');
    expect(messages[0]!.body).toBe(quotedBody);
    expect(messages[0]!.applied).toEqual([AS_SENT_MARKER]);
  });

  // A notification is not the whole thread: collapsing its extra turns must
  // leave every other mail's bubbles standing.
  it('drops only the claimed mail’s extra turns, not the rest of the thread', () => {
    const quoting = digest({
      id: 'keka-2',
      rawBody: `${DIGEST}<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br></div><blockquote class="gmail_quote"><div dir="ltr">Can we move Q3 to Friday?</div></blockquote></div>`,
    });
    // Same sender, so the thread still qualifies — but plain, so the as-sent
    // path leaves it alone and it stays an ordinary bubble.
    const plain = digest({ id: 'keka-3', date: ELEVEN_AM, rawBody: '<p>Your build passed.</p>' });
    const messages = chatMessagesFromThread([quoting, plain], { currentUserEmail: ME });
    expect(messages.map((each) => each.id)).toEqual(['keka-2', 'keka-3']);
  });

  // An as-sent body is still the app's own HTML: its `sarv-image:` refs have to
  // be resolved or every inline image in a notification renders broken.
  it('still resolves inline image refs on an as-sent body', () => {
    const withRef = digest({
      rawBody: DIGEST.replace('https://cdn.example.test/appstore.png', 'sarv-image:ab'),
    });
    const [message] = chatMessagesFromThread([withRef], {
      currentUserEmail: ME,
      resolveImages: (html) => html.replace('sarv-image:ab', 'data:image/png;base64,AA'),
    });
    expect(message!.body).toContain('data:image/png;base64,AA');
    expect(message!.body).toContain('play.png');
  });

  // Regression: a bulk mail with nothing designed about it is a plain message,
  // and skipping the split would leave its quoted history and signature in.
  it('does not claim a plain-text notification', () => {
    expect(asSentEmailIds([digest({ rawBody: '<p>Your build passed.</p>' })]).size).toBe(0);
  });

  // A mail whose body has not arrived has nothing to render as sent, and
  // claiming it would replace the bubble's pending spinner with an empty box.
  it('does not claim a mail whose body never arrived', () => {
    expect(asSentEmailIds([digest({ rawBody: '', cleanBody: '' })]).size).toBe(0);
  });

  it('has nothing to claim in an empty thread', () => {
    expect(asSentEmailIds([]).size).toBe(0);
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
