import type { EmailRecord } from '@sarvinbox/core';
import { describe, expect, it } from 'vitest';

import {
  attachmentsOf,
  chatMessagesFromConversation,
  chatMessagesFromEmails,
  draftIdsIn,
  isFromMe,
  toEpochMs,
} from '../../../../../src/components/email-detail/chat-message-adapter';

import type { ConversationMessage } from '../../../../../src/services/conversation-service';

const ME = 'me@acme.example';

/** Seconds, the unit sarvinbox stores — deliberately not milliseconds. */
const TEN_AM = 1772532000; // 2026-03-03T10:00:00Z
const ELEVEN_AM = TEN_AM + 3600;

function email(overrides: Partial<EmailRecord> & { id: string }): EmailRecord {
  return {
    messageId: `<${overrides.id}@acme.example>`,
    threadId: 't1',
    folderId: 'INBOX',
    uid: 1,
    tags: '',
    subject: 'Q3',
    fromAddress: 'alice@acme.example',
    fromName: 'Alice Chen',
    toAddress: ME,
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: TEN_AM,
    receivedDate: null,
    cleanBody: '',
    rawBody: '',
    contentType: 'html',
    contentHash: 'hash',
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    ...overrides,
  } as EmailRecord;
}

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

describe('chatMessagesFromEmails', () => {
  function convert(
    emails: EmailRecord[],
    extra: Partial<Parameters<typeof chatMessagesFromEmails>[1]> = {},
  ) {
    return chatMessagesFromEmails(emails, {
      currentUserEmail: ME,
      emailsById: mapOf(...emails),
      ...extra,
    });
  }

  it('renders the thread’s own emails when there is no conversation to show', () => {
    const [message] = convert([
      email({ id: 'e1', rawBody: '<p>Body</p>', toNames: 'Me', ccAddress: 'cc@acme.example' }),
    ]);
    expect(message).toMatchObject({
      id: 'e1',
      sourceId: 'e1',
      fromAddress: 'alice@acme.example',
      toNames: 'Me',
      ccAddress: 'cc@acme.example',
      date: TEN_AM * 1000,
      body: '<p>Body</p>',
    });
  });

  // Regression: cleanBody is stripped Markdown kept for search and list rows;
  // rendering it in place of the real HTML loses every link and image.
  it('prefers the original HTML over the stripped copy', () => {
    const [message] = convert([email({ id: 'e1', rawBody: '<p>HTML</p>', cleanBody: 'plain' })]);
    expect(message!.body).toBe('<p>HTML</p>');
  });

  it('falls back to the stripped copy when no HTML was fetched', () => {
    const [message] = convert([email({ id: 'e1', rawBody: '', cleanBody: 'plain' })]);
    expect(message!.body).toBe('plain');
  });

  it('drops unsent drafts and orders the rest oldest first', () => {
    const messages = convert([
      email({ id: 'later', date: ELEVEN_AM, rawBody: 'b' }),
      email({ id: 'draft', tags: '|draft|', rawBody: 'd' }),
      email({ id: 'earlier', date: TEN_AM, rawBody: 'a' }),
    ]);
    expect(messages.map((each) => each.id)).toEqual(['earlier', 'later']);
  });

  it('marks an email whose body never arrived as pending', () => {
    const [message] = convert([email({ id: 'e1', rawBody: '', cleanBody: '' })]);
    expect(message).toMatchObject({ bodyPending: true });
  });
});
