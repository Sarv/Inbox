import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { InboxAssistantExchange } from '../../../../src/types/inbox-assistant';
import { createAssistantHarness, promptConversations, type AssistantHarness, type ScriptedAI } from '../../../helpers/assistant-harness';

// How long a review card can change mail, and what replaces it when its time is
// up. Reported 2026-11-18: "Review my uncategorized unread emails" left a card
// whose buttons were disabled behind "This review has expired", and refreshing
// did not bring it back. These run the real agent (see assistant-harness.ts).

/** The time a user has to act on a review they can see. */
const LIFETIME_MS = 60 * 60_000;
const QUESTION = 'Review my uncategorized unread emails.';

/** A model that calls every conversation a cold pitch, confidently. */
const markAll: ScriptedAI = prompt => JSON.stringify({ recommendations: promptConversations(prompt)
  .map(row => ({ id: row.id, recommendation: 'mark_read', reason: 'Cold sales pitch with no prior relationship.', confidence: 0.97 })) });

let harness: AssistantHarness;
let clock: MockInstance<() => number>;
/** Milliseconds the test has moved the clock forward. */
let skew = 0;
let requests = 0;

beforeEach(async () => {
  skew = 0;
  const realNow = Date.now.bind(Date);
  clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
  harness = await createAssistantHarness({ ai: markAll });
});
afterEach(async () => { clock.mockRestore(); await harness.close(); });

async function seedPitches(accountId: string, count: number, name = accountId): Promise<void> {
  for (let index = 0; index < count; index++) {
    await harness.mail(accountId, `t-${name}-${index}`, { id: `m-${name}-${index}`, subject: `Backlink offer ${index}`,
      fromAddress: `seller${index}@ads.example`, tags: '|INBOX|', cleanBody: 'Buy our backlinks today.', rawBody: 'Buy our backlinks today.' });
  }
}
const review = (accountIds = ['primary']) => harness.ask(QUESTION, { accountIds });
/** What the card's "Refresh review" sends: the same question, for the review's own accounts. */
const refresh = (expired: InboxAssistantExchange) => harness.ask(expired.question, {
  accountIds: expired.review!.accounts.map(account => account.id), reviewKind: expired.review!.kind, reviewOnly: true, previousExchangeId: expired.id });
const apply = (exchange: InboxAssistantExchange, over: Record<string, unknown> = {}) => harness.service.applyReview({
  requestId: `apply-${++requests}`, chatId: exchange.chatId ?? harness.chatId, exchangeId: exchange.id, reviewId: exchange.review!.id,
  itemIds: exchange.review!.items.map(item => item.id), ...over });
const shown = (exchange: InboxAssistantExchange) => harness.service.chat(exchange.chatId ?? harness.chatId).exchanges.find(item => item.id === exchange.id)?.review;

describe('how long a review can change mail', () => {
  // Breaks: the minutes a large review takes to prepare are taken out of the
  // time the user gets to act on it, so the card arrives part-spent and goes
  // dead ("This review has expired") while they are still reading it.
  it('gives a review that took minutes to prepare its whole lifetime from the moment it is ready', async () => {
    await seedPitches('primary', 3);
    harness.ai = prompt => { skew += 3.5 * 60_000; return markAll(prompt, 'review'); };
    const exchange = await review();
    const ready = Date.now();
    expect(exchange.review!.status).toBe('ready');
    expect(ready - exchange.review!.createdAt).toBeGreaterThanOrEqual(3.5 * 60_000);
    expect(exchange.review!.expiresAt - ready).toBeGreaterThan(LIFETIME_MS - 5_000);
    expect(exchange.review!.expiresAt - ready).toBeLessThanOrEqual(LIFETIME_MS);
    expect(shown(exchange)).toMatchObject({ status: 'ready', expiresAt: exchange.review!.expiresAt });
    // A minute short of an hour after it appeared it still changes mail.
    skew += LIFETIME_MS - 60_000;
    const result = await apply(exchange);
    expect(result.reviewResult).toMatchObject({ appliedCount: 3, failedCount: 0, skippedCount: 0 });
    expect(harness.readChanges.flatMap(change => change.emailIds).sort()).toEqual(['m-primary-0', 'm-primary-1', 'm-primary-2']);
  });

  // Breaks: a command review ("Mark all … read") counts its matching time
  // against the user in the same way.
  it('starts the lifetime of a "mark all … read" review when its matching is done', async () => {
    await harness.mail('primary', 't-acme', { id: 'm-acme', subject: 'Acme renewal notice', fromAddress: 'billing@acme.example', tags: '|INBOX|', cleanBody: 'Your Acme plan renews soon.', rawBody: 'Your Acme plan renews soon.' });
    const open = harness.deps.openMailbox;
    let slow = true;
    harness.deps.openMailbox = async accountId => { if (slow) { slow = false; skew += 3 * 60_000; } return open(accountId); };
    const exchange = await harness.ask('Mark all Acme emails read', { accountIds: ['primary'] });
    expect(exchange.review).toMatchObject({ kind: 'mark_read', status: 'ready' });
    expect(exchange.review!.expiresAt - Date.now()).toBeGreaterThan(LIFETIME_MS - 5_000);
    expect(harness.readChanges).toEqual([]);
  });

  // Breaks: the safety limit itself. Mail is changed on the strength of a review
  // older than its lifetime, or the refusal does not say why.
  it('refuses a review that really is past its lifetime, says so, and changes nothing', async () => {
    await seedPitches('primary', 2);
    const exchange = await review();
    skew += LIFETIME_MS - 2_000;
    expect(shown(exchange)!.status).toBe('ready');
    skew += 2_000;
    await expect(apply(exchange)).rejects.toThrow('This review has expired. Prepare a fresh review before changing mail.');
    await expect(apply(exchange, { autoContinue: true, itemIds: [] })).rejects.toThrow('This review has expired.');
    expect(shown(exchange)!.status).toBe('expired');
    expect(harness.readChanges).toEqual([]);
    // The refusal is not a saved failure of the review: its recommendations are still shown.
    expect(shown(exchange)!.items.map(item => item.recommendation)).toEqual(['mark_read', 'mark_read']);
  });
});

describe('refreshing an expired review', () => {
  // Breaks: "Refresh review" hands back another review that cannot change mail,
  // so an expired card can never be acted on, however often it is refreshed.
  it('yields a new review that can change mail, while the expired one stays refused', async () => {
    await seedPitches('primary', 2);
    const first = await review();
    skew += LIFETIME_MS + 1;
    const second = await refresh(first);
    expect(second.id).not.toBe(first.id);
    expect(second.review!.id).not.toBe(first.review!.id);
    expect(second.review).toMatchObject({ status: 'ready', kind: 'uncategorized' });
    expect(second.review!.expiresAt - Date.now()).toBeGreaterThan(LIFETIME_MS - 5_000);
    expect(harness.service.chat(harness.chatId).exchanges.map(item => item.review?.status)).toEqual(['expired', 'ready']);
    await expect(apply(first)).rejects.toThrow('expired');
    expect(harness.readChanges).toEqual([]);
    const result = await apply(second);
    expect(result.reviewResult).toMatchObject({ appliedCount: 2 });
    expect(harness.readChanges.map(change => change.accountId)).toEqual(['primary', 'primary']);
  });

  // Breaks: a provider blip during a refresh is treated as a finished review
  // (mail offered for marking that no model looked at), or leaves the
  // conversation unable to try again.
  it.each([
    ['a gateway outage', Object.assign(new Error('Bad gateway'), { status: 502 })],
    ['a rate limit', Object.assign(new Error('Too many requests'), { status: 429 })],
    ['a dropped connection', Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })],
  ])('keeps everything unread after %s, says the review did not finish, and succeeds when retried', async (_name, failure) => {
    await seedPitches('primary', 2);
    const first = await review();
    skew += LIFETIME_MS + 1;
    const provider = harness.deps.callAI;
    harness.deps.callAI = () => Promise.reject(failure);
    const failed = await refresh(first);
    expect(failed.review!.status).toBe('partial');
    expect(failed.review!.items.map(item => [item.recommendation, item.needsRetry])).toEqual([['needs_review', true], ['needs_review', true]]);
    expect(failed.review!.items[0]!.reason).toBe('The AI review could not finish. This conversation stays unread and can be retried.');
    expect(failed.review!.coverage[0]!.warnings.join(' ')).toContain('2 conversations did not receive a verified AI recommendation');
    // Nothing in it can be marked without the user choosing it by hand.
    await expect(apply(failed)).resolves.toMatchObject({ reviewResult: { appliedCount: 0, skippedCount: 2 } });
    await expect(apply(first)).rejects.toThrow('expired');
    expect(harness.readChanges).toEqual([]);
    // The provider recovers: the same refresh now produces a review that works.
    harness.deps.callAI = provider;
    const retried = await refresh(first);
    expect(retried.review).toMatchObject({ status: 'ready' });
    expect(retried.review!.items.every(item => item.recommendation === 'mark_read' && !item.needsRetry)).toBe(true);
    await expect(apply(retried)).resolves.toMatchObject({ reviewResult: { appliedCount: 2 } });
  });

  // Breaks: a mailbox that could not be read for a moment is shown as an account
  // with no unread mail, which reads as "nothing to review" instead of "try again".
  it('reports an account whose mailbox could not be opened as not reviewed, and reviews it on the next refresh', async () => {
    await seedPitches('primary', 1);
    const first = await review();
    skew += LIFETIME_MS + 1;
    const open = harness.deps.openMailbox;
    harness.deps.openMailbox = () => Promise.reject(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
    const failed = await refresh(first);
    expect(failed.review!.items).toEqual([]);
    expect(failed.review!.coverage).toEqual([expect.objectContaining({ accountId: 'primary', status: 'unavailable', warnings: ['This account could not be completely reviewed. No action was performed.'] })]);
    harness.deps.openMailbox = open;
    const retried = await refresh(first);
    expect(retried.review!.coverage[0]).toMatchObject({ status: 'reviewed', reviewedThreads: 1 });
    await expect(apply(retried)).resolves.toMatchObject({ reviewResult: { appliedCount: 1 } });
  });

  // Breaks: pressing "Refresh review" twice runs two reviews of the same mail at
  // once (double the AI spend, two cards racing to change the same messages),
  // or the second press cancels the first.
  it('refuses a second refresh while one is running and lets the first finish', async () => {
    await seedPitches('primary', 2);
    const first = await review();
    skew += LIFETIME_MS + 1;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    harness.ai = async prompt => { entered(); await gate; return markAll(prompt, 'review'); };
    const running = refresh(first);
    await reached;
    const callsBefore = harness.calls.length;
    await expect(refresh(first)).rejects.toThrow('Another Inbox Agent request is still running in this conversation.');
    expect(harness.calls.length).toBe(callsBefore);
    release();
    const second = await running;
    expect(second.review!.status).toBe('ready');
    // One refreshed review, not two; no failed copy of the refused press is saved.
    expect(harness.chat().exchanges.map(item => item.id)).toEqual([first.id, second.id]);
    await expect(apply(second)).resolves.toMatchObject({ reviewResult: { appliedCount: 2 } });
    expect(harness.readChanges).toHaveLength(2);
  });
});

describe('a review belongs to the accounts it was made for', () => {
  // The same thread and message ids in both accounts: header-derived ids make
  // this ordinary when two of the user's own addresses receive the same mail.
  const seedShared = async () => {
    for (const accountId of ['primary', 'secondary']) {
      await harness.mail(accountId, 't-shared', { id: 'm-shared', subject: 'Backlink offer', fromAddress: 'seller@ads.example', tags: '|INBOX|', cleanBody: 'Buy our backlinks today.', rawBody: 'Buy our backlinks today.' });
    }
  };

  // Breaks: approving one account's review marks the other account's copy of
  // the same message as read.
  it('changes only the reviewed account when another account holds the same message ids', async () => {
    await seedShared();
    const exchange = await review(['primary']);
    expect(exchange.review!.accounts.map(account => account.id)).toEqual(['primary']);
    expect(exchange.review!.items.map(item => item.accountId)).toEqual(['primary']);
    await apply(exchange);
    expect(harness.readChanges).toEqual([{ accountId: 'primary', emailIds: ['m-shared'], read: true }]);
  });

  // Breaks: a review made for one account can be replayed through another
  // account's card, or keeps working after its own account is disconnected by
  // falling through to the account that is left.
  it('refuses one account\'s review through another account\'s card, and after its own account is gone', async () => {
    await seedShared();
    const mine = await review(['primary']);
    harness.newChat();
    const other = await review(['secondary']);
    expect(other.review!.items.map(item => item.accountId)).toEqual(['secondary']);
    await expect(apply(other, { reviewId: mine.review!.id, itemIds: mine.review!.items.map(item => item.id) })).rejects.toThrow('expired');
    await expect(apply(mine, { chatId: other.chatId, exchangeId: other.id })).rejects.toThrow('expired');
    await expect(apply(mine, { itemIds: other.review!.items.map(item => item.id) })).rejects.toThrow('Choose only items from this review.');
    harness.accounts.splice(harness.accounts.findIndex(account => account.id === 'primary'), 1);
    try {
      await expect(apply(mine)).rejects.toThrow();
    } finally { harness.accounts.unshift({ id: 'primary', email: 'rc@sarv.example' }); }
    expect(harness.readChanges).toEqual([]);
    // The other account's own review is untouched by all of that.
    await apply(other);
    expect(harness.readChanges).toEqual([{ accountId: 'secondary', emailIds: ['m-shared'], read: true }]);
  });

  // Breaks: a refresh widens to accounts the expired review never covered.
  it('refreshes for the expired review\'s own accounts, each change going to the account that holds the mail', async () => {
    await seedPitches('primary', 1);
    await seedPitches('secondary', 1);
    const both = await review(['primary', 'secondary']);
    skew += LIFETIME_MS + 1;
    const again = await refresh(both);
    expect(again.accountIds).toEqual(['primary', 'secondary']);
    expect(again.review!.items.map(item => item.accountId).sort()).toEqual(['primary', 'secondary']);
    await apply(again);
    expect(harness.readChanges.map(change => [change.accountId, change.emailIds]).sort()).toEqual([['primary', ['m-primary-0']], ['secondary', ['m-secondary-0']]]);
  });
});
