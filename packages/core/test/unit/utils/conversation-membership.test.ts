import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_EXCLUDED_FOLDERS,
  SENT_FOLDER_TAGS,
  STANDARD_DRAFT_FOLDERS,
  compareConversationOrder,
  conversationFoldersOf,
  conversationMembers,
  conversationSenders,
  draftFolderPathsOf,
  firstConversationMember,
  hasLiveUserDraftAmong,
  hasNewerMember,
  isDraftRow,
  isExcludedFolderCopy,
  isLiveDraft,
  isReadableDate,
  isSentCopy,
  latestConversationMember,
  sentFolderPathsOf,
  type ConversationFolders,
} from '../../../src/utils/conversation-membership';

// What breaks if this file fails: the ONE answer to "which rows of a thread are
// the conversation, and in what order". Standard, the message list, the AI
// view, the list row's "(N)", the split scheduler, the drafter and the
// auto-draft gates all read it — a wrong answer shows as a draft rendered as a
// sent message, a deleted draft reappearing, real mail vanishing from its
// thread, or main and the renderer picking different "first emails".

type Row = { id: string; date: number | null; tags: string; messageId?: string | null };
const row = (id: string, tags: string, date: number | null = 100, messageId: string | null = `<${id}@x>`): Row =>
  ({ id, tags: `|${tags}|`, date, messageId });

// Provider-specific Drafts and Sent paths, as the classifier finds them from
// the folder list (special-use \Drafts / \Sent, iCloud's known 'Sent
// Messages' path), and user folders that merely contain "draft".
const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
  { path: 'INBOX.Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  { path: 'INBOX.Sent', name: 'Sent', specialUse: '\\Sent' },
  { path: 'Sent Messages', name: 'Sent Messages', specialUse: null },
  { path: 'Drafting', name: 'Drafting', specialUse: null },
  { path: 'Contract drafts review', name: 'Contract drafts review', specialUse: null },
];
const ROLES: ConversationFolders = conversationFoldersOf(FOLDERS);

describe('draftFolderPathsOf / sentFolderPathsOf / conversationFoldersOf', () => {
  // Breaks: a user folder called "Drafting" becomes a drafts folder under a
  // substring rule, and every message filed there silently vanishes from its
  // conversation (the regression store/helpers' `includes('draft')` rule has).
  it('uses the folder classifier, never a substring rule', () => {
    expect(draftFolderPathsOf(FOLDERS)).toEqual(['INBOX.Drafts']);
    expect(ROLES).toEqual({ draftPaths: ['INBOX.Drafts'], sentPaths: ['INBOX.Sent', 'Sent Messages'] });
  });

  // Breaks: a provider Sent copy (iCloud 'Sent Messages', Dovecot 'INBOX.Sent')
  // that kept a stale |draft| tag reads as a draft, and the user's own reply
  // drops out of the thread, the "(N)" count, the AI input and the drafter.
  it('finds Sent paths by special-use and by known provider path', () => {
    expect(sentFolderPathsOf(FOLDERS)).toEqual(['INBOX.Sent', 'Sent Messages']);
    expect(sentFolderPathsOf([{ path: 'Sent Messages' }])).toEqual(['Sent Messages']);
    expect(sentFolderPathsOf(null)).toEqual([]);
  });

  // Breaks: a user folder whose last segment is 'Draft'/'Sent' ('Clients/Draft')
  // becomes a drafts/sent folder next to the server's own special-use one, and
  // mail filed there drops out of its conversations and the list count.
  it('ignores the last-segment name guess when the server advertises the role', () => {
    const advertised = [
      { path: 'INBOX.Drafts', specialUse: '\\Drafts' },
      { path: 'Clients/Draft', specialUse: null },
      { path: 'Drafts', specialUse: null },
      { path: 'Projects/Sent', specialUse: null },
      { path: 'INBOX.Sent', specialUse: '\\Sent' },
    ];
    expect(draftFolderPathsOf(advertised)).toEqual(['Drafts', 'INBOX.Drafts']);
    expect(sentFolderPathsOf(advertised)).toEqual(['INBOX.Sent']);
  });

  // Breaks: a server that advertises no special-use at all loses its drafts
  // folder, and provider-path drafts render as sent messages.
  it('keeps the name guess when nothing is advertised', () => {
    const bare = [{ path: 'Clients/Draft' }, { path: 'Work/Sent' }];
    expect(draftFolderPathsOf(bare)).toEqual(['Clients/Draft']);
    expect(sentFolderPathsOf(bare)).toEqual(['Work/Sent']);
  });

  // Breaks: SQL built from the list gets different text per call (cache churn),
  // or an empty path matches every `||` tag string.
  it('dedupes, sorts, and drops empty or NUL-bearing paths', () => {
    expect(draftFolderPathsOf([
      { path: 'Z/Drafts' }, { path: 'A/Drafts' }, { path: 'Z/Drafts' }, { path: '' },
      { path: 'Bad\0/Drafts' }, null as never, { path: 42 as never },
    ])).toEqual(['A/Drafts', 'Z/Drafts']);
    expect(draftFolderPathsOf(null)).toEqual([]);
    expect(draftFolderPathsOf(undefined)).toEqual([]);
  });
});

describe('isDraftRow / isLiveDraft / isExcludedFolderCopy — the truth table', () => {
  // Each line: tags, is it a draft row?, is it a LIVE draft?, excluded copy?
  // Breaks: drafts or trashed copies entering the conversation; the user's own
  // sent replies (which keep a stale |draft|) disappearing from every thread.
  const TABLE: Array<[string, string, boolean, boolean, boolean]> = [
    ['local mirror marker', '|INBOX|draft|', true, true, false],
    ['IMAP Drafts folder, no marker', '|Drafts|', true, true, false],
    ['Gmail Drafts folder', '|[Gmail]/Drafts|', true, true, false],
    ['provider path from the folder list', '|INBOX.Drafts|', true, true, false],
    ['user folder "Drafting" is NOT a draft', '|Drafting|', false, false, false],
    ['user label containing drafts is NOT a draft', '|Contract drafts review|', false, false, false],
    ['sent copy with a stale marker', '|Sent|draft|', false, false, false],
    ['Gmail sent copy with a stale marker', '|[Gmail]/Sent Mail|draft|', false, false, false],
    ['Outlook sent copy with a stale marker', '|Sent Items|draft|', false, false, false],
    ['provider Sent path with a stale marker', '|INBOX.Sent|draft|', false, false, false],
    ['iCloud Sent Messages with a stale marker', '|Sent Messages|draft|', false, false, false],
    ['draft moved to Trash', '|Trash|draft|', true, false, true],
    ['draft in Gmail Trash', '|[Gmail]/Trash|Drafts|', true, false, true],
    ['draft flagged \\Deleted', '|Drafts|deleted|', true, false, false],
    ['Spam copy', '|Spam|', false, false, true],
    ['ordinary inbox mail', '|INBOX|read|', false, false, false],
    ['near-miss marker tag', '|INBOX|drafted|', false, false, false],
  ];

  for (const [label, tags, draft, live, excluded] of TABLE) {
    it(label, () => {
      expect(isDraftRow(tags, ROLES)).toBe(draft);
      expect(isLiveDraft(tags, ROLES)).toBe(live);
      expect(isExcludedFolderCopy(tags)).toBe(excluded);
    });
  }

  // Breaks: a caller without the folder list gets a different answer for the
  // standard shapes, or the provider paths only work through one builder.
  it('works without the folder list, and with hand-built folder roles', () => {
    expect(isDraftRow('|Drafts|')).toBe(true);
    expect(isDraftRow('|INBOX.Drafts|')).toBe(false);
    expect(isDraftRow('|INBOX.Drafts|', { draftPaths: ['INBOX.Drafts'], sentPaths: [] })).toBe(true);
    expect(isDraftRow('|INBOX.Drafts|', null)).toBe(false);
    // Without the account's Sent paths a provider Sent copy is only its marker.
    expect(isDraftRow('|INBOX.Sent|draft|')).toBe(true);
    expect(isDraftRow('|INBOX.Sent|draft|', { draftPaths: [], sentPaths: ['INBOX.Sent'] })).toBe(false);
    expect(isDraftRow('')).toBe(false);
    expect(isDraftRow(null)).toBe(false);
    expect(isDraftRow(undefined)).toBe(false);
    expect(isLiveDraft(undefined)).toBe(false);
    expect(isExcludedFolderCopy(null)).toBe(false);
  });

  // Breaks: a caller treating all three Sent names differently from the
  // exclusion lists the SQL twin is built from.
  it('exposes the lists the SQL twin is built from', () => {
    expect(SENT_FOLDER_TAGS).toEqual(['Sent', '[Gmail]/Sent Mail', 'Sent Items']);
    expect(STANDARD_DRAFT_FOLDERS).toEqual(['Drafts', '[Gmail]/Drafts']);
    expect(CONVERSATION_EXCLUDED_FOLDERS).toEqual([
      'Trash', 'Spam', '[Gmail]/Trash', '[Gmail]/Spam', 'Junk', 'Junk Email', 'Deleted Items',
    ]);
    expect(isSentCopy('|Sent Items|')).toBe(true);
    expect(isSentCopy('|Sent Messages|')).toBe(false);
    expect(isSentCopy('|Sent Messages|', ROLES)).toBe(true);
    expect(isSentCopy(null)).toBe(false);
    expect(isSentCopy(null, ROLES)).toBe(false);
  });
});

describe('conversationMembers', () => {
  // Breaks: a draft (any shape) or a trashed/junked copy renders as a message,
  // is sent to the AI as the "first email", or is counted in "(N)".
  it('drops drafts of every shape and Trash/Spam copies', () => {
    const rows = [
      row('m1', 'INBOX', 100),
      row('local', 'INBOX|draft', 150),
      row('imap', 'Drafts', 160),
      row('gmail', '[Gmail]/Drafts', 170),
      row('provider', 'INBOX.Drafts', 180),
      row('sent', 'Sent|draft', 200),
      row('providerSent', 'INBOX.Sent|draft', 210),
      row('trash', 'Trash', 250),
      row('trashdraft', 'Trash|draft', 260),
      row('spam', 'Spam', 270),
      row('drafting', 'Drafting', 300),
    ];
    expect(conversationMembers(rows, ROLES).map((r) => r.id)).toEqual(['m1', 'sent', 'providerSent', 'drafting']);
  });

  // Breaks: reading the Junk folder opens an empty conversation.
  it('falls back to the excluded copies when every non-draft row is one (all-junk view)', () => {
    const rows = [row('j2', 'Junk', 200), row('j1', 'Junk', 100), row('d', 'Drafts', 50)];
    expect(conversationMembers(rows, ROLES).map((r) => r.id)).toEqual(['j1', 'j2']);
  });

  // Breaks: a drafts-only thread invents a message; the draft must stay a
  // compose box.
  it('has no members for a drafts-only thread', () => {
    expect(conversationMembers([row('d1', 'Drafts'), row('d2', 'INBOX|draft')], ROLES)).toEqual([]);
    expect(conversationMembers([], ROLES)).toEqual([]);
  });

  // Breaks: callers that pass the rows along mutate the caller's list order.
  it('returns a sorted copy without mutating its input', () => {
    const rows = [row('b', 'INBOX', 200), row('a', 'INBOX', 100)];
    const before = rows.map((r) => r.id);
    expect(conversationMembers(rows).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('compareConversationOrder — one total order', () => {
  // Breaks: main and the renderer pick different first emails for a
  // same-second pair (SQL's ORDER BY date leaves the tie unspecified).
  it('breaks equal timestamps by id', () => {
    const rows = [row('b', 'INBOX', 100), row('a', 'INBOX', 100), row('c', 'INBOX', 50)];
    expect([...rows].sort(compareConversationOrder).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(compareConversationOrder(rows[0], rows[0])).toBe(0);
  });

  // Breaks: a row with no Date header poses as the thread's first email and
  // hides the real one from the AI split.
  it('sorts unreadable dates (null, 0, negative, NaN) last, by id among themselves', () => {
    const rows: Row[] = [
      row('nan', 'INBOX', Number.NaN),
      row('zero', 'INBOX', 0),
      row('neg', 'INBOX', -5),
      row('null', 'INBOX', null),
      row('late', 'INBOX', 900),
      row('early', 'INBOX', 10),
      { id: 'undef', tags: '|INBOX|', date: undefined as unknown as null },
    ];
    expect([...rows].sort(compareConversationOrder).map((r) => r.id))
      .toEqual(['early', 'late', 'nan', 'neg', 'null', 'undef', 'zero']);
  });
});

describe('firstConversationMember', () => {
  // Breaks: an earliest row that is a draft or a Trash copy becomes the AI
  // split's input.
  it('skips an earlier draft and an earlier Trash copy', () => {
    const rows = [row('draft', 'Drafts', 10), row('trash', 'Trash', 20), row('real', 'INBOX', 30), row('later', 'INBOX', 40)];
    expect(firstConversationMember(rows, ROLES)?.id).toBe('real');
  });

  it('is null for a thread with no members', () => {
    expect(firstConversationMember([row('d', 'Drafts')])).toBeNull();
  });
});

describe('isReadableDate', () => {
  // Breaks: a missing or unparseable Date: header (null/0/negative/NaN) is
  // treated as a real moment, so it decides the first or latest message, or
  // the AI split stamps a message 1970-01-01.
  it('accepts only finite positive seconds', () => {
    expect(isReadableDate(1_700_000_000)).toBe(true);
    for (const bad of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isReadableDate(bad)).toBe(false);
    }
  });
});

describe('latestConversationMember — the default reply target', () => {
  // Breaks: two members at the same second — a newest-first `b.date - a.date`
  // sort kept input order, so "latest" was the SAME email as the first card
  // and Reply answered the first message instead of the newest.
  it('breaks a same-second tie by id, opposite to the first member', () => {
    const rows = [row('a', 'INBOX', 100), row('b', 'INBOX', 100)];
    expect(firstConversationMember(rows)?.id).toBe('a');
    expect(latestConversationMember(rows)?.id).toBe('b');
    expect(latestConversationMember([...rows].reverse())?.id).toBe('b');
  });

  // Breaks: an undated row (sorted last) becomes the reply target, or a null
  // date feeds NaN to the comparator and the pick depends on input order.
  it('never picks an undated member over a dated one', () => {
    const rows = [row('u', 'INBOX', null), row('late', 'INBOX', 200), row('z', 'INBOX', 0), row('early', 'INBOX', 100)];
    expect(latestConversationMember(rows)?.id).toBe('late');
  });

  // Breaks: a thread of only undated rows has no reply target at all.
  it('falls back to the last member in the order when none is dated', () => {
    expect(latestConversationMember([row('y', 'INBOX', null), row('x', 'INBOX', 0)])?.id).toBe('y');
  });

  // Breaks: a newer draft or Trash copy becomes the reply target.
  it('skips drafts and Trash copies, and is null with no members', () => {
    const rows = [row('real', 'INBOX', 100), row('d', 'INBOX.Drafts', 300), row('t', 'Trash', 400)];
    expect(latestConversationMember(rows, ROLES)?.id).toBe('real');
    expect(latestConversationMember([row('d', 'Drafts')])).toBeNull();
  });
});

describe('hasNewerMember', () => {
  const email = row('e', 'INBOX', 100);

  // Breaks: auto-draft replies to an email somebody already answered.
  it('is true when a later member exists', () => {
    expect(hasNewerMember([email, row('reply', 'Sent', 200)], email, ROLES)).toBe(true);
  });

  // Breaks: a newer draft or a newer trashed copy blocks auto-draft forever.
  it('ignores newer drafts and newer Trash copies', () => {
    const rows = [email, row('d', 'INBOX.Drafts', 200), row('t', 'Trash', 300), row('old', 'INBOX', 50)];
    expect(hasNewerMember(rows, email, ROLES)).toBe(false);
  });

  // Breaks: an undated row reads as "someone already answered".
  it('never treats an unreadable-dated row as newer', () => {
    expect(hasNewerMember([email, row('undated', 'INBOX', 0), row('nulled', 'INBOX', null)], email)).toBe(false);
  });

  // Breaks: the email itself counts as newer than itself.
  it('does not count the email itself, and orders a same-second tie by id', () => {
    expect(hasNewerMember([email], email)).toBe(false);
    expect(hasNewerMember([email, row('f', 'INBOX', 100)], email)).toBe(true);
    expect(hasNewerMember([email, row('a', 'INBOX', 100)], email)).toBe(false);
  });

  // Breaks: an undated email (no or unparseable Date:) in an already-answered
  // thread is auto-drafted — and possibly auto-sent. Its position is unknown,
  // so any other member may be the answer; the gate this replaces (ORDER BY
  // date DESC LIMIT 1) skipped it too. Doubt resolves to "already answered".
  it('treats any other member as possibly newer than an undated email', () => {
    const undated = row('u', 'INBOX', null);
    expect(hasNewerMember([undated, row('x', 'INBOX', 500)], undated)).toBe(true);
    expect(hasNewerMember([undated, row('y', 'INBOX', 0)], undated)).toBe(true);
    expect(hasNewerMember([row('z', 'INBOX', Number.NaN), row('w', 'INBOX', 20)], row('z', 'INBOX', Number.NaN)))
      .toBe(true);
  });

  // Breaks: the conservative rule makes an undated email's thread "answered"
  // by its own draft or Trash copy, so auto-draft never runs on it.
  it('does not count drafts, Trash copies or the email itself for an undated email', () => {
    const undated = row('u', 'INBOX', null);
    expect(hasNewerMember([undated], undated)).toBe(false);
    expect(hasNewerMember([undated, row('d', 'INBOX.Drafts', 900), row('t', 'Trash', 900)], undated, ROLES))
      .toBe(false);
  });
});

describe('hasLiveUserDraftAmong', () => {
  // Breaks: auto-draft runs past a user's half-written reply that is not the
  // newest row in the thread.
  it('finds an older live user draft and a provider-path draft', () => {
    expect(hasLiveUserDraftAmong([row('d', 'INBOX|draft', 50), row('m', 'INBOX', 100)], ROLES)).toBe(true);
    expect(hasLiveUserDraftAmong([row('p', 'INBOX.Drafts')], ROLES)).toBe(true);
  });

  // Breaks: a trashed draft or a sent copy blocks every auto-draft.
  it('ignores trashed, deleted-flag and sent drafts', () => {
    expect(hasLiveUserDraftAmong([
      row('t', 'Trash|draft'), row('x', 'Drafts|deleted'), row('s', 'Sent|draft'),
      row('ps', 'INBOX.Sent|draft'), row('icloud', 'Sent Messages|draft'),
    ], ROLES)).toBe(false);
  });

  // Breaks: the agent's own saved draft blocks every later auto-draft in the
  // thread; comparing raw Message-IDs misses `<ID@h>` vs `id@h`.
  it("excludes the agent's own drafts by Message-ID key", () => {
    const rows = [row('agent', 'Drafts', 100, '<AgentDraft@Host>')];
    expect(hasLiveUserDraftAmong(rows, ROLES, ['agentdraft@host'])).toBe(false);
    expect(hasLiveUserDraftAmong(rows, ROLES, new Set([' <AGENTDRAFT@host> ']))).toBe(false);
    expect(hasLiveUserDraftAmong(rows, ROLES, ['someone-else@host'])).toBe(true);
    expect(hasLiveUserDraftAmong(rows, ROLES)).toBe(true);
  });

  // Breaks: a draft with no Message-ID yet is mistaken for the agent's when an
  // empty key sneaks into the agent set.
  it("treats a draft without a Message-ID as the user's", () => {
    expect(hasLiveUserDraftAmong([row('n', 'Drafts', 100, null)], ROLES, ['', '<>'])).toBe(true);
  });

  it('is false for no rows, and reads the standard Drafts shapes without a folder list', () => {
    expect(hasLiveUserDraftAmong([], ROLES, null)).toBe(false);
    expect(hasLiveUserDraftAmong([row('d', 'Drafts')])).toBe(true);
    expect(hasLiveUserDraftAmong([row('p', 'INBOX.Drafts')], null)).toBe(false);
  });
});

describe('conversationSenders — the one distinct-sender answer', () => {
  // Breaks: the as-sent rule's "single sender" — main's background job and the
  // renderer's on-open check counting senders differently, so one decides a
  // looped-in thread is designed bulk mail and the other auto-splits it.
  it('dedupes addresses case-insensitively, in order of first appearance, keeping the first spelling', () => {
    expect(conversationSenders([
      { fromAddress: 'Ann@X.test', fromName: 'Ann' },
      { fromAddress: 'bob@x.test', fromName: 'Bob' },
      { fromAddress: ' ann@x.test ', fromName: 'Annie' },
    ])).toEqual([
      { address: 'Ann@X.test', name: 'Ann' },
      { address: 'bob@x.test', name: 'Bob' },
    ]);
  });

  // Breaks: one sender's mail plus a header-less row reads as a two-party
  // exchange (the renderer's older count included the empty address).
  it('skips rows with no From address', () => {
    expect(conversationSenders([
      { fromAddress: 'a@x.test', fromName: null },
      { fromAddress: '', fromName: 'Nobody' },
      { fromAddress: '   ', fromName: null },
      { fromAddress: null },
      {},
    ])).toEqual([{ address: 'a@x.test', name: null }]);
  });

  // Breaks: the split's name lookup loses a sender whose FIRST message carried
  // no display name (or a blank one) although a later one did.
  it('fills a missing or blank name from a later message, and never overwrites a known one', () => {
    expect(conversationSenders([
      { fromAddress: 'q@x.test', fromName: null },
      { fromAddress: 'q@x.test', fromName: '   ' },
      { fromAddress: 'Q@x.test', fromName: ' Quinn ' },
      { fromAddress: 'q@x.test', fromName: 'Later Name' },
    ])).toEqual([{ address: 'q@x.test', name: 'Quinn' }]);
    expect(conversationSenders([])).toEqual([]);
  });
});
