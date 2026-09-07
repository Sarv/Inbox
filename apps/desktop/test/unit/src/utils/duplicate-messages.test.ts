import type { EmailRecord } from '@sarvinbox/core';
import { describe, it, expect } from 'vitest';

import {
  collapseDuplicateMessages,
  hiddenDuplicateIds,
} from '../../../../src/utils/duplicate-messages';

/**
 * The conversation-view collapse for byte-identical copies of one message.
 *
 * What breaks if this file fails: Sarv ran dual delivery (mail landing in Sarv
 * was also delivered to Gmail) and a later migration merged the Gmail side back
 * in, so a thread can hold seven real, distinct server messages that are the
 * SAME mail. Too loose and the collapse eats a genuine reply — mail silently
 * disappears, the worst failure a mail client has. Too tight and the user reads
 * the same paragraph seven times and stops trusting the thread.
 */

/** An EmailRecord carrying only the fields the collapse looks at. */
const email = (over: Partial<EmailRecord> & Record<string, unknown> = {}): EmailRecord =>
  ({
    id: 'e1',
    messageId: '<m1@x>',
    threadId: 't1',
    folderId: 'INBOX',
    uid: 1,
    tags: '|INBOX|',
    subject: 'Integration between Email (SARV) and Acme SSO',
    fromAddress: 'arun.iyer@partner.example',
    fromName: 'Arun Iyer',
    toAddress: 'advik.d@sarv.com',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: 1_000,
    receivedDate: null,
    cleanBody: 'Team, below are known integrations',
    rawBody: '<p>Team, below are known integrations</p>',
    contentType: 'html',
    contentHash: 'h',
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as EmailRecord;

/** The real shape from the DB: one mail, seven deliveries, weeks apart. */
const sevenCopies = () =>
  [1, 2, 3, 4, 5, 6, 7].map((n) =>
    email({ id: `copy${n}`, uid: 53600 + n, messageId: `<PN2P287MB${n}@outlook.com>`, date: 1_000 * n }),
  );

describe('collapseDuplicateMessages', () => {
  it('folds byte-identical copies behind the EARLIEST one', () => {
    const groups = collapseDuplicateMessages(sevenCopies());

    expect(groups).toHaveLength(1);
    expect(groups[0].email.id).toBe('copy1');
    expect(groups[0].duplicates.map((d) => d.id)).toEqual(
      ['copy2', 'copy3', 'copy4', 'copy5', 'copy6', 'copy7'],
    );
  });

  // The copies arrive days or weeks apart — that IS what dual delivery plus a
  // migration looks like. Keying identity on the date would group nothing.
  it('groups copies whose arrival times are far apart', () => {
    const groups = collapseDuplicateMessages([
      email({ id: 'oct', date: 1_759_000_000 }),
      email({ id: 'nov', date: 1_763_000_000 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].duplicates.map((d) => d.id)).toEqual(['nov']);
  });

  // Distinct Message-IDs are exactly the case this exists for: each copy is a
  // real server message, so `emails.message_id UNIQUE` never saw a conflict.
  it('groups copies that carry DIFFERENT Message-IDs', () => {
    const groups = collapseDuplicateMessages([
      email({ id: 'a', messageId: '<one@test.local>' }),
      email({ id: 'b', messageId: '<two@test.local>', date: 2_000 }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it('returns groups earliest-first and leaves the input untouched', () => {
    const input = [
      email({ id: 'later', date: 5_000, rawBody: '<p>reply</p>' }),
      email({ id: 'earlier', date: 1_000 }),
    ];
    const snapshot = input.map((e) => e.id);

    const groups = collapseDuplicateMessages(input);

    expect(groups.map((g) => g.email.id)).toEqual(['earlier', 'later']);
    expect(input.map((e) => e.id)).toEqual(snapshot);
  });
});

describe('collapseDuplicateMessages — what must NEVER be collapsed', () => {
  // The failure that matters most: a real reply swallowed by the collapse is
  // mail the user never learns arrived.
  it.each([
    ['a different body', { rawBody: '<p>Team, below are known integrations!</p>' }],
    ['a different sender', { fromAddress: 'mitali.b@sarv.com' }],
    ['a different subject', { subject: 'Re: Integration between Email (SARV) and Acme SSO' }],
    ['a different attachment count', { hasAttachments: true, attachmentCount: 1, attachmentNames: '["spec.pdf"]' }],
    ['a different attachment name', { attachmentCount: 1, attachmentNames: '["other.pdf"]', attachmentSizes: '[10]' }],
    ['a different attachment size', { attachmentCount: 1, attachmentNames: '["spec.pdf"]', attachmentSizes: '[99]' }],
  ])('keeps a message with %s separate', (_what, over) => {
    const base = email({
      id: 'base',
      attachmentCount: (over as Record<string, unknown>).attachmentSizes ? 1 : 0,
      attachmentNames: (over as Record<string, unknown>).attachmentSizes ? '["spec.pdf"]' : null,
      attachmentSizes: (over as Record<string, unknown>).attachmentSizes ? '[10]' : null,
    });

    const groups = collapseDuplicateMessages([base, email({ id: 'other', date: 2_000, ...over })]);

    expect(groups).toHaveLength(2);
  });

  // Sender case is not identity — the same mail re-fetched with a differently
  // cased header is still the same mail.
  it('IGNORES sender casing', () => {
    const groups = collapseDuplicateMessages([
      email({ id: 'a' }),
      email({ id: 'b', date: 2_000, fromAddress: 'Arun.Iyer@Partner.Example' }),
    ]);

    expect(groups).toHaveLength(1);
  });

  // A LIST row carries a bounded cleanBody SNIPPET and no rawBody. Two unrelated
  // messages whose first 100 characters agree would look identical, so a row
  // without the full original is never a collapse candidate.
  it('never collapses rows whose body has not downloaded yet', () => {
    const noBody = { rawBody: '', cleanBody: 'Dear customer, your statement is ready' };
    const groups = collapseDuplicateMessages([
      email({ id: 'a', ...noBody }),
      email({ id: 'b', date: 2_000, ...noBody }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.duplicates.length === 0)).toBe(true);
  });

  it('collapses them once the bodies DO arrive', () => {
    const groups = collapseDuplicateMessages([
      email({ id: 'a' }),
      email({ id: 'b', date: 2_000 }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it('treats a whitespace-only body as no body', () => {
    const groups = collapseDuplicateMessages([
      email({ id: 'a', rawBody: '   \n ' }),
      email({ id: 'b', date: 2_000, rawBody: '\t' }),
    ]);

    expect(groups).toHaveLength(2);
  });
});

describe('collapseDuplicateMessages — the pinned (open) message', () => {
  // Opening a duplicate from search must not render an empty detail pane: the
  // selected copy takes the visible slot and the earlier one folds behind it.
  it('keeps the pinned copy visible even when it is not the earliest', () => {
    const groups = collapseDuplicateMessages(sevenCopies(), 'copy5');

    expect(groups).toHaveLength(1);
    expect(groups[0].email.id).toBe('copy5');
    expect(groups[0].duplicates.map((d) => d.id)).toEqual(
      ['copy2', 'copy3', 'copy4', 'copy1', 'copy6', 'copy7'],
    );
    expect(groups[0].duplicates).toHaveLength(6); // nothing lost in the swap
  });

  it('is a no-op when the pinned copy is already the earliest', () => {
    const groups = collapseDuplicateMessages(sevenCopies(), 'copy1');

    expect(groups[0].email.id).toBe('copy1');
    expect(groups[0].duplicates).toHaveLength(6);
  });

  it('ignores a pinned id that is not in the thread', () => {
    const groups = collapseDuplicateMessages(sevenCopies(), 'not-here');

    expect(groups[0].email.id).toBe('copy1');
  });
});

describe('collapseDuplicateMessages — degenerate input', () => {
  it('returns nothing for an empty thread', () => {
    expect(collapseDuplicateMessages([])).toEqual([]);
  });

  it('passes a single message through untouched', () => {
    const groups = collapseDuplicateMessages([email({ id: 'only' })]);

    expect(groups).toEqual([{ email: expect.objectContaining({ id: 'only' }), duplicates: [] }]);
  });

  // Every message must survive somewhere — visible or hidden. A collapse that
  // drops a row is data loss, not a display choice.
  it('accounts for EVERY input message across the groups', () => {
    const input = [
      ...sevenCopies(),
      email({ id: 'reply', date: 9_000, rawBody: '<p>Noted, thanks</p>' }),
      email({ id: 'nobody', date: 9_500, rawBody: '' }),
    ];

    const groups = collapseDuplicateMessages(input);
    const seen = [...groups.map((g) => g.email.id), ...groups.flatMap((g) => g.duplicates.map((d) => d.id))];

    expect(seen.sort()).toEqual(input.map((e) => e.id).sort());
  });

  // Same date and same body but genuinely different rows (e.g. re-delivered in
  // the same second) still need a deterministic winner, or the visible copy
  // flips between renders and the pane flickers.
  it('is deterministic when copies share a date', () => {
    const same = [
      email({ id: 'z', uid: 9, date: 1_000 }),
      email({ id: 'a', uid: 2, date: 1_000 }),
    ];

    expect(collapseDuplicateMessages(same)[0].email.id).toBe('a'); // lowest uid wins
    expect(collapseDuplicateMessages([...same].reverse())[0].email.id).toBe('a');
  });
});

describe('hiddenDuplicateIds', () => {
  it('lists every folded copy and never the visible one', () => {
    const hidden = hiddenDuplicateIds(collapseDuplicateMessages(sevenCopies()));

    expect(hidden.has('copy1')).toBe(false);
    expect(hidden.size).toBe(6);
  });

  it('is empty for a thread with no duplicates', () => {
    const groups = collapseDuplicateMessages([
      email({ id: 'a' }),
      email({ id: 'b', date: 2_000, rawBody: '<p>different</p>' }),
    ]);

    expect(hiddenDuplicateIds(groups).size).toBe(0);
  });
});
