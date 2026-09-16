import { describe, expect, it } from 'vitest';

import { calculateImportanceScore, hasBulkHeaders } from '../../../src/processor/email-processor';
import type { EmailRecord } from '../../../src/types/models';

/**
 * The bulk arm of the rule-based importance scorer.
 *
 * What breaks if this file goes red: bulk mail stops being recognised as bulk.
 * Two ways that used to happen at once — the header buckets were computed by a
 * second, private copy of the detection rules that drifted from the one sync
 * uses, and every caller that holds a stored ROW (which has no raw headers)
 * scored the entire bulk arm at zero, so newsletters ranked alongside real mail.
 */

const email = (over: Partial<EmailRecord> = {}): EmailRecord =>
  ({
    id: 'e1',
    messageId: '<m1@mail.example>',
    threadId: 't1',
    folderId: 'INBOX',
    uid: 1,
    tags: '|INBOX|',
    subject: 'September update',
    fromAddress: 'news@brand.example',
    fromName: 'Brand',
    toAddress: 'me@acme.example',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: 1_757_900_000,
    receivedDate: null,
    cleanBody: 'Here is what shipped this month.',
    rawBody: '<p>Here is what shipped this month.</p>',
    contentType: 'html',
    contentHash: 'h1',
    inReplyTo: null,
    references: null,
    priority: null,
    ...over,
  }) as EmailRecord;

const score = (record: EmailRecord, rawHeaders?: string | null) =>
  calculateImportanceScore(record, null, 'me@acme.example', 'acme.example', new Set(), rawHeaders);

const factorNames = (record: EmailRecord, rawHeaders?: string | null) =>
  score(record, rawHeaders).factors.map((f) => f.name);

describe('hasBulkHeaders', () => {
  // The RFC list headers land in the List-Unsubscribe bucket together: List-Id
  // without List-Unsubscribe is the same fact about the message.
  it('puts List-Id and List-Unsubscribe in the same bucket', () => {
    expect(hasBulkHeaders('List-Unsubscribe: <https://x.example/u>\r\n').hasListUnsubscribe).toBe(true);
    expect(hasBulkHeaders('List-Id: <news.brand.example>\r\n').hasListUnsubscribe).toBe(true);
  });

  it('reads Precedence into its own bucket', () => {
    const buckets = hasBulkHeaders('Precedence: bulk\r\n');
    expect(buckets.hasPrecedenceBulk).toBe(true);
    expect(buckets.hasListUnsubscribe).toBe(false);
  });

  // THE DRIFT REGRESSION: Auto-Submitted and Feedback-ID are read by sync's
  // detector, so the scorer has to see them too — when it kept its own copy of
  // the rules these two were simply missing from it.
  it('counts Auto-Submitted, Feedback-ID and vendor headers as other indicators', () => {
    expect(hasBulkHeaders('Auto-Submitted: auto-generated\r\n').hasOtherBulkIndicators).toBe(true);
    expect(hasBulkHeaders('Feedback-ID: 1:campaign:brand\r\n').hasOtherBulkIndicators).toBe(true);
    expect(hasBulkHeaders('X-Campaign: autumn\r\n').hasOtherBulkIndicators).toBe(true);
  });

  // `no` is RFC 3834's value for "a person sent this" — reading the header as
  // presence alone demotes every human message whose client suppresses
  // auto-replies.
  it('does not count Auto-Submitted: no', () => {
    expect(hasBulkHeaders('Auto-Submitted: no\r\n').hasOtherBulkIndicators).toBe(false);
  });

  it('reports nothing for absent headers', () => {
    expect(hasBulkHeaders(null)).toEqual({
      hasListUnsubscribe: false,
      hasPrecedenceBulk: false,
      hasOtherBulkIndicators: false,
    });
    expect(hasBulkHeaders(undefined).hasListUnsubscribe).toBe(false);
    expect(hasBulkHeaders('').hasListUnsubscribe).toBe(false);
  });
});

describe('calculateImportanceScore — the bulk arm', () => {
  // THE REGRESSION: every caller that scores a stored ROW passes no headers, so
  // the whole bulk arm was dead for them and a newsletter scored like a
  // colleague's mail. Sync already stamped `|bulk|` from those same headers.
  it('falls back to the stored |bulk| tag when no headers are available', () => {
    const bulk = email({ tags: '|INBOX|bulk|' });
    expect(factorNames(bulk)).toContain('bulk_tagged');
    expect(score(bulk).score).toBeLessThan(score(email()).score);
  });

  // With real headers in hand the header arms speak for themselves; counting the
  // tag as well would penalise the same message twice for one fact.
  it('does not also count the tag when raw headers were supplied', () => {
    const names = factorNames(email({ tags: '|INBOX|bulk|' }), 'List-Unsubscribe: <https://x.example/u>\r\n');
    expect(names).toContain('list_unsubscribe');
    expect(names).not.toContain('bulk_tagged');
  });

  // An untagged row must not pick up the penalty — this is the direction that
  // costs a real conversation when it is wrong.
  it('leaves an ordinary untagged row alone', () => {
    expect(factorNames(email())).not.toContain('bulk_tagged');
    expect(factorNames(email({ tags: '|INBOX|read|' }))).not.toContain('bulk_tagged');
  });

  // Tags are matched whole between pipes: a tag merely CONTAINING the word must
  // not trip the fallback.
  it('does not match a tag that only contains the word bulk', () => {
    expect(factorNames(email({ tags: '|INBOX|bulky|' }))).not.toContain('bulk_tagged');
  });

  // The new arms have to reach the score through the same path the old ones
  // did, headers and all.
  it('scores Auto-Submitted and Feedback-ID through the other-indicators arm', () => {
    expect(factorNames(email(), 'Auto-Submitted: auto-generated\r\n')).toContain('bulk_headers');
    expect(factorNames(email(), 'Feedback-ID: 1:campaign:brand\r\n')).toContain('bulk_headers');
    expect(factorNames(email(), 'Auto-Submitted: no\r\n')).not.toContain('bulk_headers');
  });
});
