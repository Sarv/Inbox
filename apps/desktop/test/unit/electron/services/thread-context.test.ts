import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIRST_SPLIT_VERSION, type EmailRecord, type FirstSplitPart, type ThreadMessage } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FIRST_EMAIL_BODY_CHARS,
  MESSAGE_BODY_CHARS,
  buildThreadMessages,
} from '../../../../electron/services/thread-context';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

// What breaks if this file fails: the thread the reply drafter reads — the
// pipeline's auto-drafter and the manual agent:draftReply both. A draft or a
// Trash copy in it and the drafter answers the user's own unsent reply, or
// quotes mail the user threw away; a missing first email and it replies
// without the looped-in history; a missing NEWEST member and it replies
// without seeing the message it answers. Real account database, real facade.

const T0 = 1_780_000_000;
const T = 'thread-1';

let dir = '';
let account: TestAccount;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'thread-context-'));
  account = await openTestAccount(dir, 'acct');
});
afterEach(async () => {
  await account.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (over: Partial<EmailRecord> & { id: string }) => account.add(T, over);
const build = (aliases: string[] = []): ThreadMessage[] => buildThreadMessages(account.storage, T, { userAliases: aliases });

const OWN: FirstSplitPart = {
  role: 'own', fromAddress: 'e1@sender.test', fromName: 'Eve', date: T0, dateApprox: false,
  body: '<p>Looping you in — see below.</p>', fallback: false,
};
const QUOTE_OLD: FirstSplitPart = {
  role: 'quote', fromAddress: 'old@x.test', fromName: 'Olga', date: T0 - 7200, dateApprox: false,
  body: '<p>The original ask.</p>', fallback: false,
};
const QUOTE_MID: FirstSplitPart = {
  role: 'quote', fromAddress: 'me@me.test', fromName: null, date: T0 - 3600, dateApprox: true,
  body: '<p>My earlier answer.</p>', fallback: true,
};

/** Store a split for the thread's current first email (main's own key). */
function storeSplit(parts: FirstSplitPart[]): void {
  const key = account.storage.firstMemberKeySync(T)!;
  expect(account.storage.saveFirstSplit({ key, status: 'ok', parts, quoteCount: 2, modelUsed: 'm' }).applied).toBe(true);
}

describe('buildThreadMessages', () => {
  // Breaks: the drafter gets the old untyped {from, date: number, body} shape.
  it('returns the core ThreadMessage shape, oldest first, with labelled recipients', async () => {
    await add({
      id: 'e1', date: T0, fromAddress: 'e1@sender.test', fromName: 'Eve', subject: 'Plan',
      toAddress: 'me@me.test, bob@x.test', toNames: '"Me", Bob', ccAddress: 'cc@x.test', ccNames: null,
    });
    await add({ id: 'e2', date: T0 + 60, fromAddress: 'me@me.test', fromName: null, subject: 'Re: Plan', toAddress: '' });

    expect(build(['ME@me.test'])).toEqual([
      {
        messageId: '<e1@test.example>', subject: 'Plan', from: 'Eve <e1@sender.test>',
        to: ['Me <me@me.test>', 'Bob <bob@x.test>'], cc: ['cc@x.test'],
        date: new Date(T0 * 1000).toISOString(), body: expect.stringContaining('e1 body'), isFromUser: false,
      },
      {
        messageId: '<e2@test.example>', subject: 'Re: Plan', from: 'me@me.test',
        to: [], cc: [], date: new Date((T0 + 60) * 1000).toISOString(), body: 'e2 body', isFromUser: true,
      },
    ]);
  });

  // Breaks: a draft (either shape) or a Trash copy reaches the drafter as a message.
  it('never includes a draft or a Trash copy', async () => {
    await add({ id: 'e1', date: T0 });
    await add({ id: 'draft-local', date: T0 + 10, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    await add({ id: 'draft-imap', date: T0 + 20, tags: '|INBOX.Drafts|', folderId: 'f-drafts' });
    await add({ id: 'binned', date: T0 + 30, tags: '|Trash|', folderId: 'f-trash' });
    await add({ id: 'e2', date: T0 + 40 });

    expect(build().map((m) => m.messageId)).toEqual(['<e1@test.example>', '<e2@test.example>']);
  });

  // Breaks: the looped-in history — a usable split replaces E1 with the
  // messages it quotes, oldest first, and E1's own words carry its identity.
  it('replaces the first email with its usable split; the own part carries E1’s id, subject and recipients', async () => {
    await add({ id: 'e1', date: T0, subject: 'Fwd: Plan', toAddress: 'me@me.test', ccAddress: 'boss@x.test' });
    await add({ id: 'e2', date: T0 + 60 });
    storeSplit([OWN, QUOTE_MID, QUOTE_OLD]);

    const messages = build(['me@me.test']);
    expect(messages.map((m) => m.from)).toEqual([
      'Olga <old@x.test>', 'me@me.test', 'Eve <e1@sender.test>', 'Sender <sender@x.com>',
    ]);
    const [oldest, mine, own] = messages;
    expect(oldest).toMatchObject({ messageId: null, subject: null, to: [], cc: [], isFromUser: false });
    expect(oldest.body).toContain('The original ask.');
    expect(mine).toMatchObject({ isFromUser: true, date: new Date((T0 - 3600) * 1000).toISOString() });
    expect(own).toMatchObject({
      messageId: '<e1@test.example>', subject: 'Fwd: Plan', to: ['me@me.test'], cc: ['boss@x.test'],
    });
    expect(own.body).toContain('Looping you in');
    expect(messages[3].messageId).toBe('<e2@test.example>');
  });

  // Breaks: a stale split (another first email, a changed body, an older
  // version) puts the wrong history in the drafter's context — it must fall
  // back to E1's full body, which is then the only copy of that history.
  it('falls back to the full first email when the split is stale, for another email, or another version', async () => {
    const long = `<p>${'history '.repeat(1200)}</p>`; // ~9.6K chars of text
    await add({ id: 'e1', date: T0, rawBody: long });
    storeSplit([OWN, QUOTE_OLD]);

    // Another version.
    account.run('UPDATE first_email_splits SET split_version = ?', FIRST_SPLIT_VERSION + 1);
    let first = build()[0];
    expect(first.messageId).toBe('<e1@test.example>');
    expect(first.body.length).toBeGreaterThan(MESSAGE_BODY_CHARS);
    expect(first.body.length).toBeLessThanOrEqual(FIRST_EMAIL_BODY_CHARS);

    // The body changed under the split (re-heal): stale fingerprint.
    account.run('UPDATE first_email_splits SET split_version = ?', FIRST_SPLIT_VERSION);
    // Current again: the split is used (its oldest quote comes first).
    expect(build()[0].body).toContain('The original ask.');
    await account.storage.updateEmail('e1', { rawBody: '<p>healed history</p>' });
    first = build()[0];
    expect(first.body).toContain('healed history');

    // An earlier email arrived: the split was for another first email.
    await add({ id: 'e0', date: T0 - 500, rawBody: '<p>even earlier</p>' });
    first = build()[0];
    expect(first.messageId).toBe('<e0@test.example>');
    expect(first.body).toContain('even earlier');
  });

  // Breaks: later messages repeat the whole quoted chain (the prompt fills
  // with duplicates), or a reply whose own words the cut misread arrives EMPTY.
  it('quote-strips later members, falling back to the cleaned body when the cut leaves nothing', async () => {
    await add({ id: 'e1', date: T0 });
    await add({
      id: 'reply', date: T0 + 60,
      rawBody: '<p>Sounds good, ship it.</p><p>On Mon, 1 Jun 2026 at 10:00, Eve &lt;e1@sender.test&gt; wrote:</p><blockquote>e1 body</blockquote>',
    });
    await add({
      id: 'top', date: T0 + 120,
      rawBody: '<p>On Mon, 1 Jun 2026 at 10:00, Eve &lt;e1@sender.test&gt; wrote:</p><blockquote>only quoted text here</blockquote>',
    });
    await add({ id: 'plain', date: T0 + 180, contentType: 'text', rawBody: 'Plain words.\n\n> quoted line one\n> quoted line two' });

    const [, reply, top, plain] = build();
    expect(reply.body).toBe('Sounds good, ship it.');
    expect(top.body).toContain('only quoted text here');
    expect(plain.body).toBe('Plain words.');
  });

  // Breaks: a later message longer than the cap blows the prompt budget.
  it('caps later members at the message budget', async () => {
    await add({ id: 'e1', date: T0 });
    await add({ id: 'long', date: T0 + 60, rawBody: `<p>${'word '.repeat(1000)}</p>` });
    expect(build()[1].body.length).toBe(MESSAGE_BODY_CHARS);
  });

  // Breaks: the drafter replies without seeing the message it answers.
  it('always includes the newest member, even in a long thread', async () => {
    for (let i = 0; i < 15; i += 1) await add({ id: `m${i}`, date: T0 + i * 60 });
    const messages = build();
    expect(messages).toHaveLength(15);
    expect(messages.at(-1)!.messageId).toBe('<m14@test.example>');
  });

  // Breaks: a header-only row (body not downloaded) or one with an empty
  // Message-ID/subject crashes the builder or feeds the prompt "undefined".
  it('tolerates missing bodies, Message-IDs and subjects, and works without aliases', async () => {
    await add({ id: 'e1', date: T0, rawBody: '', cleanBody: 'text only first', subject: '' });
    await add({ id: 'e2', date: T0 + 60, rawBody: '', cleanBody: '', messageId: '' });

    const [first, second] = buildThreadMessages(account.storage, T);
    expect(first).toMatchObject({ subject: null, body: 'text only first', isFromUser: false });
    expect(second).toMatchObject({ messageId: null, body: '' });
  });

  // Breaks: the looped-in history out of order — a quote dated like its
  // carrier must still read BEFORE the carrier's own words.
  it('orders split parts by date, the own part last on a tie, ties between quotes kept in order', async () => {
    await add({ id: 'e1', date: T0, subject: '' });
    const quoteA: FirstSplitPart = { ...QUOTE_OLD, date: T0, body: '<p>quote A</p>' };
    const quoteB: FirstSplitPart = { ...QUOTE_OLD, date: T0, body: '<p>quote B</p>' };
    storeSplit([OWN, quoteA, quoteB]);

    const messages = build();
    expect(messages.map((m) => m.body)).toEqual([
      expect.stringContaining('quote A'), expect.stringContaining('quote B'), expect.stringContaining('Looping you in'),
    ]);
    // The first email had no subject: the own part says so rather than inventing one.
    expect(messages[2]).toMatchObject({ subject: null, messageId: '<e1@test.example>' });
  });

  // Breaks: a thread holding only the user's draft hands the drafter that
  // draft as a message to answer.
  it('is empty for a thread with no member', async () => {
    await add({ id: 'only-draft', tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    expect(build()).toEqual([]);
  });
});
