import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  NO_BODY_CONTENT_HASH_PREFIX,
  accountIdFor,
  bodyContentHash,
  emailContentHash,
  generateContentHash,
  generateFolderId,
  generateId,
  generateThreadId,
  getIdTimestamp,
  isValidId,
  noBodyContentHash,
  normAccountIdPart,
  synthesizedMessageId,
  SYNTHESIZED_MESSAGE_ID_PREFIX,
} from '../../../src/utils/id';

// Two of these ids are load-bearing and effectively permanent:
//  * generateThreadId decides which conversation a message joins — a mismatch
//    splits a thread in two (or, worse, merges unrelated mail).
//  * accountIdFor is the credential-vault key AND the per-account DB filename.
//    Drift between two copies of that shape once broke login for a legacy
//    account, which is why it lives here as the single source of truth.

afterEach(() => {
  vi.useRealTimers();
});

describe('generateId', () => {
  it('produces a base36-timestamp + 16-hex-char id that isValidId accepts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'));

    const id = generateId();
    expect(id).toMatch(/^[a-z0-9]+-[a-f0-9]{16}$/);
    expect(id.split('-')[0]).toBe(Date.now().toString(36));
    expect(isValidId(id)).toBe(true);
  });

  // Ids are minted per row during a sync burst; two rows in the same millisecond
  // must not collide (the random suffix is what guarantees that).
  it('is unique even within the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'));
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });
});

describe('generateThreadId — replies join the root thread', () => {
  // The FIRST entry of References is the conversation root, so every reply in a
  // long chain must land on the same thread id.
  it('uses the first References entry so the whole chain shares one thread', () => {
    const root = '<root@x.com>';
    const first = generateThreadId('Re: hi', '<m2@x.com>', '<m1@x.com>', `${root} <m1@x.com>`);
    const later = generateThreadId('Re: hi', '<m9@x.com>', '<m8@x.com>', `${root} <m1@x.com> <m8@x.com>`);
    expect(first).toBe(later);
    expect(first).toMatch(/^thread-[a-f0-9]{16}$/);
  });

  it('falls back to In-Reply-To when there is no References header', () => {
    const viaInReplyTo = generateThreadId('Re: hi', '<m2@x.com>', '<root@x.com>', null);
    const viaReferences = generateThreadId('Re: hi', '<m3@x.com>', null, '<root@x.com>');
    expect(viaInReplyTo).toBe(viaReferences);
  });

  // Some clients send In-Reply-To without angle brackets; without normalization
  // the hash differs from the root's and the reply starts a second thread.
  it('normalizes a bracket-less In-Reply-To to the same thread', () => {
    const bare = generateThreadId('Re: hi', '<m2@x.com>', 'root@x.com', null);
    const bracketed = generateThreadId('Re: hi', '<m2@x.com>', '<root@x.com>', null);
    expect(bare).toBe(bracketed);
  });

  it('is case-insensitive on the message id', () => {
    expect(generateThreadId('s', '<ROOT@X.COM>', null, null)).toBe(generateThreadId('s', '<root@x.com>', null, null));
  });

  // References entries that are not message ids (some servers emit prose) must be
  // skipped, falling through to In-Reply-To rather than hashing garbage.
  it('ignores References tokens that are not <message-id> shaped', () => {
    const junkRefs = generateThreadId('Re: hi', '<m2@x.com>', '<root@x.com>', 'garbage tokens here');
    expect(junkRefs).toBe(generateThreadId('Re: hi', '<m2@x.com>', '<root@x.com>', null));
  });

  it('trims whitespace around In-Reply-To', () => {
    expect(generateThreadId('s', '<m@x.com>', '  <root@x.com>  ', null))
      .toBe(generateThreadId('s', '<m@x.com>', '<root@x.com>', null));
  });
});

describe('generateThreadId — new conversations', () => {
  it('threads on its own messageId when there are no threading headers', () => {
    const id = generateThreadId('Quarterly report', '<new@x.com>', null, null);
    expect(id).toMatch(/^thread-[a-f0-9]{16}$/);
    expect(generateThreadId('Totally different subject', '<new@x.com>', null, null)).toBe(id);
  });

  // The subject is deliberately IGNORED — grouping by subject merged unrelated
  // "Invoice" / "Hi" mails from different senders into one giant thread.
  it('ignores the normalized subject entirely', () => {
    expect(generateThreadId('a', '<m1@x.com>', null, null)).not.toBe(generateThreadId('a', '<m2@x.com>', null, null));
  });

  // Headerless messages must NOT all collapse into a single shared thread.
  it('gives every headerless, id-less message its own thread', () => {
    const a = generateThreadId('', '', null, null);
    const b = generateThreadId('', '', null, null);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^thread-[a-f0-9]{16}$/);
    expect(generateThreadId('', '', undefined, undefined)).not.toBe(a);
  });
});

describe('generateContentHash', () => {
  // Used for dedup, so it must be a stable, well-known SHA-256 — changing the
  // algorithm would re-import every message as "new".
  it('is a deterministic SHA-256 hex digest', () => {
    expect(generateContentHash('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(generateContentHash('hello')).toBe(generateContentHash('hello'));
    expect(generateContentHash('hello')).not.toBe(generateContentHash('hello '));
    expect(generateContentHash('')).toHaveLength(64);
  });
});

// Regression: `content_hash` was computed as `generateContentHash(cleanBody || subject)`
// at ingest, where a headers-first sync has NO body — so the column held a hash of
// the SUBJECT for essentially the whole mailbox and was never recomputed when the
// body arrived. Measured on a live account: 1,809 hash groups spanned more than one
// distinct `clean_body_len`, which a body-derived hash cannot do. Anything reading
// the column as "same hash means same content" (embedding freshness, a same-body
// collapse in the conversation view) was comparing subject lines instead.
describe('bodyContentHash', () => {
  // The clean body is the content when there is one — plain SHA-256 of it, so the
  // value is reproducible from the stored body.
  it('hashes the clean body', () => {
    expect(bodyContentHash({ cleanBody: 'hello' })).toBe(generateContentHash('hello'));
    expect(bodyContentHash({ cleanBody: 'hello', rawBody: '<p>hello</p>' })).toBe(
      generateContentHash('hello'),
    );
  });

  // HTML-only sends (most marketing mail) arrive with an EMPTY clean body and all
  // their content in the raw part. Hashing only the clean body would call them
  // body-less — the same mistake `legacyHasBodyExpression` exists to avoid.
  it('falls back to the raw body when the clean body is empty', () => {
    expect(bodyContentHash({ cleanBody: '', rawBody: '<p>hi</p>' })).toBe(
      generateContentHash('<p>hi</p>'),
    );
    expect(bodyContentHash({ cleanBody: '   \n ', rawBody: '<p>hi</p>' })).toBe(
      generateContentHash('<p>hi</p>'),
    );
  });

  // null is the signal callers branch on: no body means there is nothing to
  // recompute, so a body write that came back empty must not overwrite a good hash.
  it('returns null when there is no body at all', () => {
    expect(bodyContentHash({})).toBeNull();
    expect(bodyContentHash({ cleanBody: '', rawBody: '' })).toBeNull();
    expect(bodyContentHash({ cleanBody: null, rawBody: null })).toBeNull();
    expect(bodyContentHash({ cleanBody: ' ', rawBody: '\n\t' })).toBeNull();
  });

  // Two different bodies must never share a hash, or a dedupe/collapse reader hides
  // real mail.
  it('separates different bodies', () => {
    expect(bodyContentHash({ cleanBody: 'a' })).not.toBe(bodyContentHash({ cleanBody: 'b' }));
  });
});

describe('noBodyContentHash', () => {
  // The marker has to be RECOGNISABLE — that is the whole point of it over a bare
  // hash: a repair pass, and any "is this a real body hash?" reader, filters on it.
  it('marks the value as not body-derived', () => {
    const hash = noBodyContentHash('<a@test.local>');
    expect(hash.startsWith(NO_BODY_CONTENT_HASH_PREFIX)).toBe(true);
    expect(hash).not.toBe(generateContentHash('<a@test.local>'));
  });

  // Stable across re-syncs: a header refresh must not churn the column, or every
  // re-sync would look like a content change to a freshness check.
  it('is deterministic per message and case-insensitive', () => {
    expect(noBodyContentHash('<a@test.local>')).toBe(noBodyContentHash('<a@test.local>'));
    expect(noBodyContentHash('<A@Test.Local>')).toBe(noBodyContentHash('<a@test.local>'));
    expect(noBodyContentHash(' <a@test.local> ')).toBe(noBodyContentHash('<a@test.local>'));
  });

  // Distinct per message: the old behaviour made every body-less row hash the same,
  // which is exactly how unrelated mail came to look like duplicate content.
  it('separates different messages', () => {
    expect(noBodyContentHash('<a@test.local>')).not.toBe(noBodyContentHash('<b@test.local>'));
  });

  // Same fallback as generateThreadId's: without it, every message that arrived with
  // no Message-ID would share one value. Unique-per-call is the safe direction —
  // ingest synthesizes a Message-ID before this runs, so it is a backstop only.
  it('never collapses messages that have no identity', () => {
    const a = noBodyContentHash('');
    const b = noBodyContentHash(undefined);
    expect(a).not.toBe(b);
    expect(a.startsWith(NO_BODY_CONTENT_HASH_PREFIX)).toBe(true);
    expect(b.startsWith(NO_BODY_CONTENT_HASH_PREFIX)).toBe(true);
  });
});

describe('emailContentHash', () => {
  // The single rule the ingest, body-fetch and local writers all go through: the
  // body's hash once there is a body, the marker until then. A message stored
  // headers-first and healed later must land on the SAME hash as the same message
  // stored body-and-all in one go — otherwise the two ingest routes disagree about
  // whether identical mail is identical.
  it('agrees with bodyContentHash whenever a body exists', () => {
    expect(emailContentHash({ cleanBody: 'hello', messageId: '<a@test.local>' })).toBe(
      generateContentHash('hello'),
    );
    expect(emailContentHash({ cleanBody: '', rawBody: '<p>hi</p>', messageId: '<a@x>' })).toBe(
      generateContentHash('<p>hi</p>'),
    );
  });

  it('falls back to the no-body marker keyed on the Message-ID', () => {
    expect(emailContentHash({ cleanBody: '', messageId: '<a@test.local>' })).toBe(
      noBodyContentHash('<a@test.local>'),
    );
  });

  // The exact regression: two unrelated notifications sharing a subject must NOT
  // share a content hash just because neither body has been downloaded yet.
  it('does not hash the subject', () => {
    const first = emailContentHash({ cleanBody: '', messageId: '<a@test.local>' });
    const second = emailContentHash({ cleanBody: '', messageId: '<b@test.local>' });
    expect(first).not.toBe(second);
    expect(first).not.toBe(generateContentHash('OverTime Request is approved.'));
  });
});

// What breaks if these fail: a message that arrived with no Message-ID header
// gets stored more than once, and the user sees the same mail twice in a thread.
//
// `emails.message_id` is UNIQUE and is the identity every dedupe runs on, so an
// invented id decides whether a second sighting of one message is recognised.
// The previous key was `folderPath|uid|date|from`, and BOTH of those first two
// fields change for the same message: on Gmail every message is in All Mail as
// well as its label, and a UIDVALIDITY reset renumbers an entire mailbox.
describe('synthesizedMessageId', () => {
  const message = {
    fromAddress: 'arun.iyer@partner.example',
    internalDate: new Date('2025-10-28T05:50:14Z'),
    subject: 'Integration between Email and Acme SSO',
    toAddress: 'advik.d@sarv.com,mitali.b@sarv.com',
    size: 26199,
  };

  it('marks the id as one we invented', () => {
    expect(synthesizedMessageId(message).startsWith(SYNTHESIZED_MESSAGE_ID_PREFIX)).toBe(true);
    expect(synthesizedMessageId(message).endsWith('@sarvinbox.local>')).toBe(true);
  });

  // THE regression: the same message seen in a second folder must resolve to the
  // same id. The old key included the folder path, so it did not.
  it('does not depend on the folder the message was found in', () => {
    // The caller passes no folder at all now — the proof is that two sightings
    // built from identical message fields agree.
    expect(synthesizedMessageId(message)).toBe(synthesizedMessageId({ ...message }));
  });

  // A UIDVALIDITY reset renumbers every UID. Keyed on the UID, the whole mailbox
  // would re-ingest as new mail.
  it('does not depend on the UID', () => {
    // Same proof, stated separately: the UID is not part of the input shape, so
    // it cannot participate. This test fails the moment someone adds it back.
    expect(Object.keys(message)).not.toContain('uid');
    expect(synthesizedMessageId(message)).toBe(synthesizedMessageId(message));
  });

  it('is stable across re-syncs of the same message', () => {
    const first = synthesizedMessageId(message);
    const second = synthesizedMessageId({
      ...message,
      internalDate: new Date('2025-10-28T05:50:14Z'), // a fresh Date, same instant
    });
    expect(second).toBe(first);
  });

  it('accepts the arrival time as an epoch as well as a Date', () => {
    expect(synthesizedMessageId({ ...message, internalDate: message.internalDate.getTime() })).toBe(
      synthesizedMessageId(message),
    );
  });

  // Each of the five identity fields has to matter, or two different messages
  // collapse into one row and mail goes missing.
  it.each([
    ['sender', { fromAddress: 'someone.else@partner.example' }],
    ['arrival time', { internalDate: new Date('2025-10-28T05:50:15Z') }],
    ['subject', { subject: 'Something else entirely' }],
    ['recipients', { toAddress: 'other@sarv.com' }],
    ['size', { size: 26200 }],
  ])('gives a different id when the %s differs', (_field, override) => {
    expect(synthesizedMessageId({ ...message, ...override })).not.toBe(
      synthesizedMessageId(message),
    );
  });

  // Address case is not identity — the same message re-fetched with a
  // differently-cased header must not become a second message.
  it('ignores the case of the addresses', () => {
    expect(
      synthesizedMessageId({
        ...message,
        fromAddress: 'Arun.Iyer@Partner.Example',
        toAddress: 'Advik.D@sarv.com,Mitali.B@sarv.com',
      }),
    ).toBe(synthesizedMessageId(message));
  });

  // A message missing everything must still get an id rather than throwing —
  // it is already the degenerate case that put us on this path.
  it('still produces an id when every field is missing', () => {
    const empty = synthesizedMessageId({});
    expect(empty.startsWith(SYNTHESIZED_MESSAGE_ID_PREFIX)).toBe(true);
    expect(synthesizedMessageId({ fromAddress: null, subject: null })).toBe(empty);
  });
});

describe('generateFolderId', () => {
  it('is a stable folder-<16 hex> derived from the path', () => {
    expect(generateFolderId('INBOX')).toMatch(/^folder-[a-f0-9]{16}$/);
    expect(generateFolderId('INBOX')).toBe(generateFolderId('INBOX'));
    expect(isValidId(generateFolderId('INBOX'))).toBe(true);
  });

  // Servers report folder case inconsistently ("INBOX" vs "Inbox"); the id must
  // not change or we'd create a duplicate folder row on the next sync.
  it('is case-insensitive on the path', () => {
    expect(generateFolderId('inbox')).toBe(generateFolderId('INBOX'));
    expect(generateFolderId('[gmail]/all mail')).toBe(generateFolderId('[Gmail]/All Mail'));
  });

  it('distinguishes different paths', () => {
    expect(generateFolderId('INBOX')).not.toBe(generateFolderId('INBOX/Sub'));
  });
});

describe('normAccountIdPart', () => {
  it('lowercases and collapses every run of non-alphanumerics to one dash', () => {
    expect(normAccountIdPart('Advik.D@Sarv.com')).toBe('advik-d-sarv-com');
    expect(normAccountIdPart('a..b__c')).toBe('a-b-c');
  });

  it('trims whitespace and edge dashes so ids never start or end with a dash', () => {
    expect(normAccountIdPart('  .info@x.com.  ')).toBe('info-x-com');
    expect(normAccountIdPart('---x---')).toBe('x');
  });

  it('returns an empty string for empty, undefined and punctuation-only input', () => {
    expect(normAccountIdPart()).toBe('');
    expect(normAccountIdPart('')).toBe('');
    expect(normAccountIdPart('   ')).toBe('');
    expect(normAccountIdPart('!!!')).toBe('');
  });
});

describe('accountIdFor', () => {
  it('keys on email AND host in the documented acct-<email>--<host> shape', () => {
    expect(accountIdFor('advik.d@sarv.com', 'imap.sarv.com')).toBe('acct-advik-d-sarv-com--imap-sarv-com');
  });

  // The same address on two providers must be two accounts, each with its own
  // vault entry and DB file.
  it('gives the same address on different hosts different ids', () => {
    expect(accountIdFor('a@x.com', 'imap.sarv.com')).not.toBe(accountIdFor('a@x.com', 'imap.gmail.com'));
  });

  it('falls back to an email-only id when no host is given', () => {
    expect(accountIdFor('a@x.com')).toBe('acct-a-x-com');
    expect(accountIdFor('a@x.com', '')).toBe('acct-a-x-com');
    expect(accountIdFor('a@x.com', '   ')).toBe('acct-a-x-com');
  });

  // Case/whitespace differences in how the address was typed must not produce a
  // second account (the vault-key mismatch that broke login).
  it('is stable across casing and surrounding whitespace', () => {
    expect(accountIdFor('  Advik.D@Sarv.COM ', ' IMAP.Sarv.com ')).toBe(accountIdFor('advik.d@sarv.com', 'imap.sarv.com'));
  });

  it('uses a "default" base when the email is missing', () => {
    expect(accountIdFor('')).toBe('acct-default');
    expect(accountIdFor('', 'imap.sarv.com')).toBe('acct-default--imap-sarv-com');
  });
});

describe('isValidId', () => {
  it('accepts the ids this module generates', () => {
    expect(isValidId('thread-0123456789abcdef')).toBe(true);
    expect(isValidId('folder-0123456789abcdef')).toBe(true);
    expect(isValidId('m0abc-0123456789abcdef')).toBe(true);
  });

  it('rejects malformed ids', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId('noseparator')).toBe(false);
    expect(isValidId('thread-tooshort')).toBe(false);
    expect(isValidId('thread-0123456789ABCDEF')).toBe(false); // hex must be lowercase
    expect(isValidId('thread-0123456789abcdeff')).toBe(false); // 17 chars
    expect(isValidId('Upper-0123456789abcdef')).toBe(false);
  });
});

describe('getIdTimestamp', () => {
  it('recovers the creation time from a generated id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'));
    expect(getIdTimestamp(generateId())).toBe(Date.now());
  });

  it('decodes the base36 prefix of any id-shaped string', () => {
    expect(getIdTimestamp('zz-abcdef')).toBe(parseInt('zz', 36));
  });

  // An id with no separator has no timestamp to extract; callers branch on null.
  it('returns null when there is no separator to split on', () => {
    expect(getIdTimestamp('noseparator')).toBeNull();
    expect(getIdTimestamp('')).toBeNull();
  });
});
