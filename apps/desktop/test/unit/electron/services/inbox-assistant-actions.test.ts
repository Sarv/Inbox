import type { EmailRecord, FolderRecord, SearchQuery } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { applyInboxAssistantReview, parseInboxAssistantReadCommand, prepareInboxAssistantReview, undoInboxAssistantReview, type InboxAssistantActionDeps, type InboxAssistantReadReceipt } from '../../../../electron/services/inbox-assistant-actions';
import { InboxAssistantRecommendationCache } from '../../../../electron/services/inbox-assistant-recommendation-cache';
import type { InboxAssistantAIWorkload } from '../../../../src/types/inbox-assistant';
import { emailRecord } from '../../../helpers/email-fixtures';

const accounts = [{ id: 'a', email: 'owner@company.example' }, { id: 'b', email: 'second@other.example' }];
const inbox = { id: 'inbox', name: 'Inbox', path: 'INBOX', specialUse: '\\Inbox', parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, subscribed: true, createdAt: 0, updatedAt: 0 } satisfies FolderRecord;
function email(id: string, overrides: Partial<EmailRecord> = {}): EmailRecord {
  return emailRecord({ id, messageId: `<${id}@newsletter.example>`, threadId: `thread-${id}`, folderId: 'inbox', uid: 10, tags: '|INBOX|', fromAddress: 'offers@newsletter.example', toAddress: accounts[0]!.email,
    subject: 'A seasonal sale', date: 1_791_600_000, rawBody: '<p>Enjoy our summer discount. No response needed.</p>', cleanBody: 'Enjoy our summer discount. No response needed.', hasBody: true, contentType: 'html', updatedAt: 10, ...overrides });
}
function fixture(records: EmailRecord[] = [email('one')], second: EmailRecord[] = []) {
  const data = new Map([['a', new Map(records.map(row => [row.id, row]))], ['b', new Map(second.map(row => [row.id, row]))]]);
  const mailboxes = new Map([...data].map(([accountId, byId]) => [accountId, {
    aliases: [] as string[], storage: {
      getFolders: vi.fn(async () => [inbox]), getContacts: vi.fn(async () => []), getAttachments: vi.fn(async () => []),
      getCategoryDefinitions: () => [{ slug: 'promotions' }, { slug: 'important' }, { slug: 'finance' }],
      getEmail: vi.fn(async (id: string) => byId.get(id) ?? null),
      getEmailsByThread: vi.fn(async (threadId: string) => [...byId.values()].filter(row => row.threadId === threadId)),
      searchEmails: vi.fn(async (query: SearchQuery) => {
        const unread = [...byId.values()].filter(row => query.isUnread === undefined || row.tags.includes('|read|') !== query.isUnread);
        const threads = [...new Set(unread.map(row => row.threadId || row.id))];
        const selected = threads.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 25));
        return unread.filter(row => selected.includes(row.threadId || row.id));
      }),
    },
  }]));
  const callAI = vi.fn(async (prompt: string, _signal?: AbortSignal, _workload?: InboxAssistantAIWorkload) => {
    const line = prompt.split('\n').find(value => value.startsWith('UNTRUSTED_CONVERSATIONS_JSON: '))!;
    const items = JSON.parse(line.slice('UNTRUSTED_CONVERSATIONS_JSON: '.length)) as Array<{ id: string }>;
    return JSON.stringify({ recommendations: items.map(item => ({ id: item.id, recommendation: 'mark_read', reason: 'Low-value unsolicited promotion with no requested response.', confidence: 0.98 })) });
  });
  const setRead = vi.fn(async (accountId: string, ids: string[], read: boolean): Promise<InboxAssistantReadReceipt> => {
    for (const id of ids) {
      const row = data.get(accountId)!.get(id)!;
      row.tags = row.tags.replace('|read|', '|');
      if (read) row.tags += 'read|';
      row.updatedAt++;
    }
    return { appliedIds: ids, queuedIds: [], failedIds: [] };
  });
  const moveMail = vi.fn(async (accountId: string, ids: string[], action: 'archive' | 'trash'): Promise<InboxAssistantReadReceipt> => {
    for (const id of ids) {
      const row = data.get(accountId)!.get(id)!;
      row.tags = row.tags.replace('|INBOX|', '|');
      if (action === 'trash') row.tags += 'Trash|';
      row.updatedAt++;
    }
    return { appliedIds: ids, queuedIds: [], failedIds: [] };
  });
  const deps: InboxAssistantActionDeps = { openMailbox: vi.fn(async id => { const mailbox = mailboxes.get(id); if (!mailbox) throw new Error('Account removed'); return mailbox; }), callAI, setRead, moveMail };
  return { deps, mailboxes, data, callAI, setRead, moveMail };
}

describe('financial and business-report action protection', () => {
  it.each([
    ['Screener.in - Watchlist updates', 'Latest rating and company updates for your watchlist.'],
    ['Zoho SalesIQ: Daily report for Oct 16', 'Daily Summary Report of HelpDesk. Visitor On Site: 4.'],
    ['Weekly sales summary', 'New leads: 12\nClosed sales: 3'],
    ['Your bank statement is ready', 'Your monthly statement is available.'],
  ])('keeps %s unread without sending it to AI or using cached actions', async (subject, rawBody) => {
    const f = fixture([email('protected', { subject, rawBody, contentType: 'text' })]);
    const cache = new InboxAssistantRecommendationCache();
    const lookup = vi.spyOn(cache, 'get');
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined,
      { recommendationCache: cache, reviewCacheIdentity: 'provider-model' });
    expect(review.items[0]).toMatchObject({ recommendation: 'keep_unread', confidence: 0 });
    expect(review.items[0]!.protectedReasons.length).toBeGreaterThan(0);
    expect(f.callAI).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('protects the whole conversation when the financial report is in a read sibling', async () => {
    const f = fixture([email('unread'), email('read-sibling', { threadId: 'thread-unread', tags: '|INBOX|read|',
      subject: 'Portfolio holdings update', rawBody: 'Your investment holdings have changed.', contentType: 'text' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ recommendation: 'keep_unread', messageCount: 2 });
    expect(f.callAI).not.toHaveBeenCalled();
  });

  it('vetoes and never caches a contradictory AI recommendation', async () => {
    const f = fixture();
    f.callAI.mockImplementation(async prompt => {
      const rows = JSON.parse(prompt.split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ id: string }>;
      return JSON.stringify({ recommendations: rows.map(row => ({ id: row.id, recommendation: 'mark_read',
        reason: 'Automated daily summary report.', confidence: 0.99 })) });
    });
    const cache = new InboxAssistantRecommendationCache();
    const store = vi.spyOn(cache, 'set');
    const options = { recommendationCache: cache, reviewCacheIdentity: 'provider-model' };
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    expect(review.items[0]).toMatchObject({ recommendation: 'keep_unread', confidence: 0 });
    expect(review.items[0]!.protectedReasons).toContain('Business reports or operational notifications require your review.');
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    expect(f.callAI).toHaveBeenCalledTimes(2);
  });
});

describe('contextual promotional review policy', () => {
  it('batches the exact escaped JSON size without dropping long originals or exceeding the prompt budget', async () => {
    const body = '"'.repeat(11_000);
    const f = fixture(Array.from({ length: 4 }, (_, index) => email(`quoted-${index}`, { rawBody: body, contentType: 'text' })));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items).toHaveLength(4);
    expect(review.items.every(item => item.recommendation === 'mark_read' && !item.needsRetry)).toBe(true);
    expect(f.callAI).toHaveBeenCalledTimes(2);
    const submitted = f.callAI.mock.calls.flatMap(([prompt]) => {
      expect(prompt.length).toBeLessThanOrEqual(64_000);
      return JSON.parse(prompt.split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ content: string }>;
    });
    expect(submitted).toHaveLength(4);
    expect(submitted.every(item => item.content.endsWith(body))).toBe(true);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each(['promotions', 'social', 'updates', 'forums'])('sends a manual %s classification to AI instead of treating it as permanent unread', async category => {
    const f = fixture([email('offer', { manualCategories: [category], tags: `|INBOX|${category}|` })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'mark_read', protectedReasons: [] });
    const input = JSON.parse(f.callAI.mock.calls[0]![0].split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ reviewSignals: string[] }>;
    expect(input[0]!.reviewSignals).toContain(`user_category:${category}`);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('uses prior business contact history as soft evidence and invalidates cache when that evidence changes', async () => {
    const f = fixture(); const options = { recommendationCache: new InboxAssistantRecommendationCache(), reviewCacheIdentity: 'soft-relationship-model' };
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    f.mailboxes.get('a')!.storage.getContacts.mockResolvedValue([{ email: 'offers@newsletter.example', sentCount: 12, contactType: 'vendor' }] as never);
    const behavior = 'offers@newsletter.example: deleted90d=19;readThenDeletedFast90d=17;lastOutboundDaysAgo=400';
    const history = vi.fn(async () => ({ text: behavior, available: true, senderCount: 1, omittedSenderCount: 0 }));
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: history });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    expect(review.items[0]).toMatchObject({ recommendation: 'mark_read', protectedReasons: [] });
    expect(f.callAI).toHaveBeenCalledTimes(2); expect(review.coverage[0]!.cachedRecommendations).toBe(0);
    const prompt = f.callAI.mock.calls[1]![0];
    expect(prompt).toContain('known_business_contact:offers@newsletter.example');
    expect(prompt).toContain('prior_sent_contact:offers@newsletter.example'); expect(prompt).toContain(behavior);
    expect(prompt).toContain('archive is not dismissal');
    expect(prompt).toContain('Do not divide them into rates'); expect(history).toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('leaves the recommendation to the model when a previously contacted vendor sends advertising', async () => {
    const f = fixture(); f.mailboxes.get('a')!.storage.getContacts.mockResolvedValue([{ email: 'offers@newsletter.example', sentCount: 12, contactType: 'vendor' }] as never);
    const respond = f.callAI.getMockImplementation()!;
    f.callAI.mockImplementation(async prompt => (await respond(prompt)).replace(/mark_read/g, 'keep_unread'));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'keep_unread', protectedReasons: [] });
    expect(f.callAI).toHaveBeenCalledOnce(); expect(f.setRead).not.toHaveBeenCalled();
  });

  it('protects host-known sender VIP status before using cached or AI recommendations', async () => {
    const f = fixture(); const history = vi.fn(async () => ({ text: 'sender:VIP', hasVip: true, available: true, senderCount: 1, omittedSenderCount: 0 }));
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: history });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'keep_unread', confidence: 0 });
    expect(review.items[0]!.protectedReasons).toContain('A favorite or VIP contact needs your review.');
    expect(f.callAI).not.toHaveBeenCalled(); expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps current sent exchanges protected while stale sent history stays evidence (current=%s)', async current => {
    const now = Math.floor(Date.now() / 1000);
    const f = fixture([email('offer', { date: now }), email('old-sent', { threadId: 'thread-offer', tags: '|INBOX|read|', fromAddress: accounts[0]!.email,
      date: now - (current ? 5 : 365) * 86400, rawBody: 'Thanks for the product information.', contentType: 'text' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]!.recommendation).toBe(current ? 'keep_unread' : 'mark_read');
    expect(f.callAI).toHaveBeenCalledTimes(current ? 0 : 1);
    if (!current) expect(f.callAI.mock.calls[0]![0]).toContain('past_sent_thread_member');
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each([
    ['Newsletter', 'Our invoice software is 50% off. Legal | Password help | Payment methods.'],
    ['Planning an ERP implementation?', 'Does your team still rely on manual reporting? We sell ERP services. Book a demo.'],
    ['Leadership nomination', 'Your profile has been nominated for our awards campaign. Discuss packages with us.'],
  ])('passes advertising with business vocabulary to AI with complete original content: %s', async (subject, rawBody) => {
    const f = fixture([email('offer', { subject, rawBody, contentType: 'text' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'mark_read', protectedReasons: [] });
    expect(f.callAI.mock.calls[0]![0]).toContain(rawBody); expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each(['marketing', 'newsletter', 'vendor', 'business'])('keeps retained marketing folders and %s contact labels eligible for a behavioral AI recommendation', async contactType => {
    const marketing = { ...inbox, id: 'marketing-folder', name: 'Marketing', path: 'Marketing', specialUse: '' };
    const f = fixture([email('campaign', { folderId: marketing.id, tags: '|Marketing|promotions|', manualCategories: ['promotions'],
      subject: 'Business software campaign', rawBody: 'Save 40% on our invoice software. This is a product advertisement. Unsubscribe at any time.', contentType: 'text' })]);
    f.mailboxes.get('a')!.storage.getFolders.mockResolvedValue([inbox, marketing]);
    f.mailboxes.get('a')!.storage.getContacts.mockResolvedValue([{ email: 'offers@newsletter.example', sentCount: 1, contactType }] as never);
    const behavior = 'offers@newsletter.example:deleted=12;markedRead=6;outboundLifetime=1,lastOutboundDaysAgo=500;readThenDeletedFast90d=6;deletedWithoutRead90d=6;recentDeleted30d=8;lastUserAction=delete';
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: async () => ({ text: behavior, available: true, senderCount: 1, omittedSenderCount: 0 }) });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'mark_read', confidence: 0.98, protectedReasons: [] });
    const prompt = f.callAI.mock.calls[0]![0];
    expect(prompt).toContain(behavior); expect(prompt).toContain('pattern can support mark_read confidence >=0.9');
    expect(prompt).toContain('outboundLifetime is sent mail, not verified replies');
    expect(prompt).toContain('Old opens/reads or outbound contact do not cancel repeated dismissal');
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('does not force a mark-read recommendation from no recorded replies or historical outbound contact', async () => {
    const f = fixture([email('uncertain', { subject: 'A possible discussion', rawBody: 'Would you like to discuss the next steps?', contentType: 'text' })]);
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: async () => ({ text: 'sender:replied=0;outboundLifetime=1;no recorded user actions', available: true, senderCount: 1, omittedSenderCount: 0 }) });
    const respond = f.callAI.getMockImplementation()!;
    f.callAI.mockImplementation(async prompt => (await respond(prompt)).replace(/mark_read/g, 'needs_review').replace(/0.98/g, '0.4'));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'needs_review', confidence: 0.4, protectedReasons: [] });
    expect(f.callAI.mock.calls[0]![0]).toContain('Never claim the user never replied');
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each([
    ['Invoice payment due', 'Please settle your invoice.'],
    ['Weekly sales summary', 'New leads: 12. Closed sales: 3.'],
  ])('preserves %s despite repeated dismissal history', async (subject, rawBody) => {
    const f = fixture([email('valuable', { subject, rawBody, contentType: 'text', manualCategories: ['promotions'] })]);
    const history = vi.fn(async () => ({ text: 'sender:deleted=80;readThenDeletedFast90d=70;outboundLifetime=0', available: true, senderCount: 1, omittedSenderCount: 0 }));
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: history });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'keep_unread', confidence: 0 });
    expect(f.callAI).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('reserves prompt room for behavioral policy without skipping large complete conversations', async () => {
    const f = fixture(Array.from({ length: 8 }, (_, index) => email(`long-${index}`, {
      rawBody: `A product newsletter. ${'Detailed product marketing information. '.repeat(280)}`, contentType: 'text',
    })));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items).toHaveLength(8);
    expect(review.items.every(item => item.recommendation === 'mark_read' && !item.needsRetry)).toBe(true);
    expect(f.callAI).toHaveBeenCalledTimes(2);
    expect(f.callAI.mock.calls.every(([prompt]) => prompt.length <= 64_000)).toBe(true);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('keeps the default verified AI action out of human behavioral training', async () => {
    const f = fixture(); const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['one'], true);
    expect(f.setRead.mock.calls[0]).toHaveLength(3);
  });
});

describe('incomplete unread review recovery', () => {
  it('stops repeated calls to an unavailable provider and keeps every unverified conversation for retry', async () => {
    const f = fixture(Array.from({ length: 40 }, (_, index) => email(`offer-${index}`)));
    f.callAI.mockRejectedValue(new Error('Synthetic provider is temporarily unavailable'));
    const progress = vi.fn();
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, progress);
    expect(f.callAI).toHaveBeenCalledTimes(1);
    expect(review.items).toHaveLength(40);
    expect(review.items.every(item => item.needsRetry && item.recommendation === 'needs_review')).toBe(true);
    expect(review.coverage[0]).toMatchObject({ unverifiedRecommendations: 40, aiReviewedThreads: 0 });
    expect(review.coverage[0]!.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/40 conversations did not receive a verified AI recommendation/)]));
    expect(review.status).toBe('partial');
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'complete', status: 'warning' }));
    expect((await applyInboxAssistantReview(review, review.items.map(item => item.id), f.deps)).skippedCount).toBe(40);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('distinguishes missing provider output from a completed uncertain recommendation', async () => {
    const f = fixture([email('omitted'), email('uncertain')]);
    f.callAI.mockImplementation(async prompt => {
      const items = JSON.parse(prompt.split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ id: string }>;
      return JSON.stringify({ recommendations: [{ id: items[1]!.id, recommendation: 'needs_review', confidence: 0.4,
        reason: 'The relevance of this newsletter is uncertain.' }] });
    });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ emailId: 'omitted', needsRetry: true, recommendation: 'needs_review' });
    expect(review.items[1]).toMatchObject({ emailId: 'uncertain', recommendation: 'needs_review' });
    expect(review.items[1]!.needsRetry).toBeUndefined();
    expect(review.coverage[0]).toMatchObject({ unverifiedRecommendations: 1, aiReviewedThreads: 1 });
    expect(f.setRead).not.toHaveBeenCalled();
  });
});

describe('account-local behavior in unread recommendations', () => {
  it('supplies bounded validated account aliases for recipient interpretation without expanding mailbox queries', async () => {
    const f = fixture([email('alias-mail', { toAddress: 'alias@company.example' })]);
    const mailbox = f.mailboxes.get('a')!;
    mailbox.aliases = ['ALIAS@company.example', 'alias@company.example', 'invalid\naddress@example.com', `${'x'.repeat(260)}@example.com`,
      ...Array.from({ length: 10 }, (_, index) => `other-alias-${index}@company.example`)];
    const options = { recommendationCache: new InboxAssistantRecommendationCache(), reviewCacheIdentity: 'recipient-context-provider',
      reviewPreferences: 'Keep personal emails addressed directly to me unread.' };
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    const prompt = f.callAI.mock.calls[0]![0];
    const input = JSON.parse(prompt.split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ recipientContext: { addresses: string[]; complete: boolean }; content: string }>;
    expect(input[0]!.recipientContext).toMatchObject({ addresses: expect.arrayContaining([accounts[0]!.email, 'alias@company.example']), complete: false });
    expect(input[0]!.recipientContext.addresses.length).toBeLessThanOrEqual(8);
    expect(input[0]!.recipientContext.addresses.reduce((sum, address) => sum + address.length, 0)).toBeLessThanOrEqual(1_024);
    expect(input[0]!.recipientContext.addresses.every(address => address.length <= 254 && !/[\r\n]/u.test(address))).toBe(true);
    expect(input[0]!.content).toContain('To: alias@company.example');
    expect(f.mailboxes.get('b')!.storage.searchEmails).not.toHaveBeenCalled();
    expect(vi.mocked(f.deps.openMailbox).mock.calls.every(([id]) => id === 'a')).toBe(true);
    expect(mailbox.storage.searchEmails.mock.calls.every(([query]) => query.query === '' && query.scope === 'mailbox' && query.isUnread === true)).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(64_000);
    mailbox.aliases = ['new-alias@company.example'];
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    expect(f.callAI).toHaveBeenCalledTimes(2);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('retains original personal criteria in the prompt and invalidates a recommendation cached under other criteria', async () => {
    const f = fixture();
    const options = { recommendationCache: new InboxAssistantRecommendationCache(), reviewCacheIdentity: 'personal-review-provider',
      reviewPreferences: 'Keep personal emails sent directly to me unread.' };
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    const first = f.callAI.mock.calls[0]![0];
    expect(first).toContain(`USER_RETENTION_PREFERENCES_JSON: ${JSON.stringify(options.reviewPreferences)}`);
    expect(first).toContain('Enjoy our summer discount. No response needed.');
    expect(first).toContain('They can only retain more mail');
    const updated = { ...options, reviewPreferences: 'Keep personal emails and ongoing relationships unread.' };
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, updated);
    expect(f.callAI).toHaveBeenCalledTimes(2);
    const cached = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, updated);
    expect(cached.coverage[0]).toMatchObject({ cachedRecommendations: 1 });
    expect(f.callAI).toHaveBeenCalledTimes(2);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('includes bounded sender history without replacing body content and invalidates cached decisions when behavior changes', async () => {
    const f = fixture();
    let behavior = 'Account-local user actions: opened=2,replied=1; automatic/system actions excluded.';
    const history = vi.fn(async () => ({ text: behavior, available: true, senderCount: 1, omittedSenderCount: 0 }));
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: history });
    const workload = vi.fn();
    const call = f.callAI.getMockImplementation()!;
    f.callAI.mockImplementation(async (prompt, signal, detail) => { workload(detail); return call(prompt, signal, detail); });
    const options = { recommendationCache: new InboxAssistantRecommendationCache(), reviewCacheIdentity: 'provider-with-behavior' };
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    expect(history).toHaveBeenCalledExactlyOnceWith(['offers@newsletter.example']);
    let prompt = f.callAI.mock.calls[0]![0];
    expect(prompt).toContain('Enjoy our summer discount. No response needed.');
    expect(prompt).toContain(behavior);
    expect(prompt).toContain('Missing history or no observed replies alone is not evidence of low value');
    expect(workload).toHaveBeenLastCalledWith(expect.objectContaining({ behaviorContextChars: behavior.length }));
    behavior = 'Account-local user actions: opened=3,replied=1,keptUnread=1; automatic/system actions excluded.';
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    expect(f.callAI).toHaveBeenCalledTimes(2);
    prompt = f.callAI.mock.calls[1]![0];
    expect(prompt).toContain(behavior);
    const cached = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, options);
    expect(cached.coverage[0]).toMatchObject({ cachedRecommendations: 1 });
    expect(f.callAI).toHaveBeenCalledTimes(2);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('binds each supplied history to its own account and keeps all content under the prompt limit', async () => {
    const f = fixture([email('primary')], [email('secondary', { toAddress: accounts[1]!.email })]);
    for (const [id, mailbox] of f.mailboxes) Object.assign(mailbox, {
      getUnreadReviewBehaviorContext: async () => ({ text: `Recorded user behavior for ${id} only.`, available: true, senderCount: 1, omittedSenderCount: 0 }),
    });
    await prepareInboxAssistantReview(accounts, 'unread', f.deps);
    const prompt = f.callAI.mock.calls[0]![0];
    const input = JSON.parse(prompt.split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ accountEmail: string; behaviorContext: string }>;
    expect(input).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountEmail: accounts[0]!.email, behaviorContext: 'Recorded user behavior for a only.' }),
      expect.objectContaining({ accountEmail: accounts[1]!.email, behaviorContext: 'Recorded user behavior for b only.' }),
    ]));
    expect(prompt.length).toBeLessThanOrEqual(64_000);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'oversized'] as const)('describes %s history as unavailable rather than inventing lack of engagement', async failure => {
    const f = fixture();
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: async () => {
      if (failure === 'unavailable') throw new Error('Synthetic history read failed');
      return { text: 'private history '.repeat(200), available: true, senderCount: 1, omittedSenderCount: 0 };
    } });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const input = JSON.parse(f.callAI.mock.calls[0]![0].split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ content: string; behaviorContext: string }>;
    expect(input[0]!.behaviorContext).toBe('Sender behavior unavailable; missing history is not evidence of low value.');
    expect(input[0]!.content).toContain('Enjoy our summer discount. No response needed.');
    expect(review.items[0]).toMatchObject({ recommendation: 'mark_read', protectedReasons: [] });
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('preserves financial protections even when user behavior often deletes the sender', async () => {
    const f = fixture([email('statement', { subject: 'Your bank statement is ready', rawBody: 'Your monthly statement is available.', contentType: 'text' })]);
    const history = vi.fn(async () => ({ text: 'User deleted90d=99.', available: true, senderCount: 1, omittedSenderCount: 0 }));
    Object.assign(f.mailboxes.get('a')!, { getUnreadReviewBehaviorContext: history });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ recommendation: 'keep_unread' });
    expect(history).not.toHaveBeenCalled();
    expect(f.callAI).not.toHaveBeenCalled();
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });
});

describe('compact complete unread-review input', () => {
  const original = ['A seasonal newsletter with subscriber discounts and product news.',
    'Subscribers receive monthly news, release notes and seasonal offers. '.repeat(15),
    'Regards, Alice\nDesignation: Editor\nPhone: +91 90000 00123'].join('\n');
  const quoted = 'On Thu, 1 Oct 2026 at 10:00, Alice <alice@newsletter.example> wrote:\n';
  const inputRows = (prompt: string) => JSON.parse(prompt.split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!) as Array<{ id: string; accountEmail: string; content: string }>;

  it('sends exact quoted copies once while preserving unique replies, signatures and outer message headers', async () => {
    const rows = [email('original', { threadId: 'shared', tags: '|INBOX|read|', rawBody: original, contentType: 'text', date: 1_791_590_000 }),
      email('later', { threadId: 'shared', rawBody: `The October subscriber news.\n\n${quoted}${original}`, contentType: 'text', ccAddress: 'editor@example.test' }),
      email('latest', { threadId: 'shared', rawBody: `The November subscriber news.\n\n${quoted}${original}`, contentType: 'text' })];
    const f = fixture(rows);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(f.callAI).toHaveBeenCalledTimes(1);
    const [prompt, , workload] = f.callAI.mock.calls[0]!;
    const content = inputRows(prompt)[0]!.content;
    expect(content.split(original)).toHaveLength(2);
    expect(content).toContain('shared with M1, turn 1');
    expect(content).toContain('Message: M1');
    expect(content).toContain('Message: M2');
    expect(content).toContain('Cc: editor@example.test');
    expect(content).toContain('The October subscriber news.');
    expect(content).toContain('The November subscriber news.');
    expect(content).toContain('Designation: Editor\nPhone: +91 90000 00123');
    expect(workload).toMatchObject({ operation: 'unread_review', conversationCount: 1, messageCount: 3, reusedQuotedTurns: 2 });
    expect(workload!.submittedContentChars).toBeLessThan(workload!.originalContentChars * 0.6);
    expect(review.items[0]!.id).not.toBe('C1');
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('keeps references local to their conversation instead of pointing into another batch or account', async () => {
    const f = fixture([email('one', { rawBody: `October subscriber news.\n${quoted}${original}`, contentType: 'text' }),
      email('two', { rawBody: `November subscriber news.\n${quoted}${original}`, contentType: 'text' })],
    [email('one', { rawBody: `December subscriber news.\n${quoted}${original}`, contentType: 'text' })]);
    await prepareInboxAssistantReview(accounts, 'unread', f.deps);
    const records = inputRows(f.callAI.mock.calls[0]![0]);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.content).toContain(original);
      expect(record.content).not.toContain('shared with');
    }
    expect(f.callAI.mock.calls[0]![2]).toMatchObject({ reusedQuotedTurns: 0, conversationCount: 3, messageCount: 3 });
  });

  it('maps compact IDs back to exact host targets when aliases restart in the next call', async () => {
    const f = fixture(Array.from({ length: 17 }, (_, index) => email(`mail-${index}`)));
    f.callAI.mockImplementation(async prompt => JSON.stringify({ recommendations: inputRows(prompt).map(item => ({ id: item.id,
      recommendation: item.id === 'C1' ? 'mark_read' : 'keep_unread', confidence: 0.99, reason: 'Unsolicited subscriber news.' })) }));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(f.callAI).toHaveBeenCalledTimes(2);
    expect(inputRows(f.callAI.mock.calls[0]![0]).map(item => item.id)).toEqual(Array.from({ length: 16 }, (_, index) => `C${index + 1}`));
    expect(inputRows(f.callAI.mock.calls[1]![0]).map(item => item.id)).toEqual(['C1']);
    expect(review.items.filter(item => item.recommendation === 'mark_read').map(item => item.emailId)).toEqual(['mail-0', 'mail-16']);
    expect(new Set(review.items.map(item => item.id)).size).toBe(17);
    await applyInboxAssistantReview(review, [review.items[16]!.id], f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['mail-16'], true);
  });

  it('still protects complete originals above the reading limit even when repeated quotes could pack much smaller', async () => {
    const large = original.repeat(4);
    const f = fixture([email('original', { threadId: 'shared', tags: '|INBOX|read|', rawBody: large, contentType: 'text' }),
      email('later', { threadId: 'shared', rawBody: `October news.\n${quoted}${large}`, contentType: 'text' }),
      email('latest', { threadId: 'shared', rawBody: `November news.\n${quoted}${large}`, contentType: 'text' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]!.recommendation).toBe('keep_unread');
    expect(review.items[0]!.protectedReasons).toContain('The complete conversation exceeds the reading limit.');
    expect(f.callAI).not.toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
  });
});

describe('reusing exact verified unread recommendations safely', () => {
  const options = () => ({ recommendationCache: new InboxAssistantRecommendationCache(), reviewCacheIdentity: 'provider:model:request-policy-v1' });

  it('refreshes unchanged complete mail without another AI call and creates fresh action snapshots', async () => {
    const f = fixture(); const cacheOptions = options();
    const first = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    const second = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(f.callAI).toHaveBeenCalledTimes(1);
    expect(first.coverage[0]).toMatchObject({ cachedRecommendations: 0, aiReviewedThreads: 1 });
    expect(second.coverage[0]).toMatchObject({ cachedRecommendations: 1, aiReviewedThreads: 0 });
    expect(second.id).not.toBe(first.id); expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.items[0]).toMatchObject({ recommendation: 'mark_read', confidence: 0.98 });
    expect(f.setRead).not.toHaveBeenCalled();
    f.data.get('a')!.get('one')!.subject = 'Changed after the cached review';
    expect((await applyInboxAssistantReview(second, [second.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each([
    { rawBody: '<p>A different complete discount announcement.</p>' }, { subject: 'A different sale' },
    { fromAddress: 'different@newsletter.example' }, { toAddress: 'a-new-recipient@example.test' },
    { uid: 11 }, { tags: '|INBOX|custom|' }, { updatedAt: 11 },
  ])('invalidates cached recommendations after exact source state changes: %j', async change => {
    const f = fixture(); const cacheOptions = options();
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    Object.assign(f.data.get('a')!.get('one')!, change);
    const refreshed = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(f.callAI).toHaveBeenCalledTimes(2);
    expect(refreshed.coverage[0]).toMatchObject({ cachedRecommendations: 0, aiReviewedThreads: 1 });
  });

  it('keeps identical IDs/content isolated by account and provider/request policy', async () => {
    const f = fixture([email('one')], [email('one')]); const cacheOptions = options();
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    const otherAccount = await prepareInboxAssistantReview([accounts[1]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(otherAccount.coverage[0]!.cachedRecommendations).toBe(0);
    for (const reviewCacheIdentity of ['provider:new-model:request-policy-v1', 'provider:model:request-policy-v2']) {
      const refreshed = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, { ...cacheOptions, reviewCacheIdentity });
      expect(refreshed.coverage[0]!.cachedRecommendations).toBe(0);
    }
    expect(f.callAI).toHaveBeenCalledTimes(4);
  });

  it('does not reuse decisions without an explicit provider identity or after cache TTL', async () => {
    let now = 0; const f = fixture();
    const cacheOptions = { recommendationCache: new InboxAssistantRecommendationCache({ ttlMs: 100, now: () => now }), reviewCacheIdentity: 'provider:model' };
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    now = 100;
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, { recommendationCache: cacheOptions.recommendationCache });
    expect(f.callAI).toHaveBeenCalledTimes(3);
  });

  it.each(['changed', 'unavailable'] as const)('does not read cached decisions when the live provider policy is %s', async state => {
    const f = fixture(); const cacheOptions = options();
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    const refreshed = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, { ...cacheOptions,
      isCacheCurrent: () => { if (state === 'unavailable') throw new Error('Provider unavailable'); return false; },
    });
    expect(f.callAI).toHaveBeenCalledTimes(2); expect(refreshed.coverage[0]!.cachedRecommendations).toBe(0);
  });

  it('does not cache a response under the old provider identity after a live policy change during the call', async () => {
    const f = fixture(); let current = true; const cacheOptions = { ...options(), isCacheCurrent: () => current };
    const call = f.callAI.getMockImplementation()!;
    f.callAI.mockImplementation(async prompt => { current = false; return call(prompt); });
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    current = true; f.callAI.mockImplementation(call);
    const refreshed = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(f.callAI).toHaveBeenCalledTimes(2); expect(refreshed.coverage[0]!.cachedRecommendations).toBe(0);
    const next = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(f.callAI).toHaveBeenCalledTimes(2); expect(next.coverage[0]!.cachedRecommendations).toBe(1);
  });

  it('rechecks favorite contacts even when the email state and classifier input did not change', async () => {
    const f = fixture(); const cacheOptions = options();
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    f.mailboxes.get('a')!.storage.getContacts.mockResolvedValue([{ email: 'offers@newsletter.example', sentCount: 1, isFavorite: true }] as never);
    const protectedReview = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(protectedReview.items[0]).toMatchObject({ recommendation: 'keep_unread', confidence: 0 });
    expect(protectedReview.items[0]!.protectedReasons.join(' ')).toContain('favorite or VIP contact');
    expect(protectedReview.coverage[0]!.cachedRecommendations).toBe(0);
    expect((await applyInboxAssistantReview(protectedReview, [protectedReview.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled(); expect(f.callAI).toHaveBeenCalledTimes(1);
  });

  it.each(['attachment', 'body', 'star', 'manual-category'] as const)('keeps newly protected %s mail out of cached automatic actions', async protection => {
    const f = fixture(); const cacheOptions = options();
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    const row = f.data.get('a')!.get('one')!;
    if (protection === 'attachment') f.mailboxes.get('a')!.storage.getAttachments.mockResolvedValue([{ filename: 'one.pdf' }] as never);
    if (protection === 'body') { row.rawBody = ''; row.cleanBody = ''; row.hasBody = false; }
    if (protection === 'star') row.tags += 'starred|';
    if (protection === 'manual-category') row.manualCategories = [];
    const protectedReview = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(protectedReview.items[0]!.recommendation).toBe('keep_unread');
    expect(protectedReview.coverage[0]!.cachedRecommendations).toBe(0);
    expect((await applyInboxAssistantReview(protectedReview, [protectedReview.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled(); expect(f.callAI).toHaveBeenCalledTimes(1);
  });

  it.each(['needs_review', 'low-confidence', 'missing', 'invalid', 'error'] as const)('does not cache %s provider results', async response => {
    const f = fixture(); const cacheOptions = options();
    f.callAI.mockImplementation(async prompt => {
      if (response === 'error') throw new Error('Synthetic provider failure');
      const item = JSON.parse(prompt.split('UNTRUSTED_CONVERSATIONS_JSON: ')[1]!)[0];
      if (response === 'invalid') return '{"recommendations":[{"id":"invented"}]}';
      return JSON.stringify({ recommendations: response === 'missing' ? [] : [{ id: item.id,
        recommendation: response === 'needs_review' ? 'needs_review' : 'mark_read', confidence: response === 'low-confidence' ? 0.89 : 0.99, reason: 'Not a verified high-confidence decision.' }] });
    });
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    const refreshed = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(f.callAI).toHaveBeenCalledTimes(2); expect(refreshed.coverage[0]!.cachedRecommendations).toBe(0);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('reuses high-confidence keep-unread decisions without authorizing a read action', async () => {
    const f = fixture(); const cacheOptions = options();
    const call = f.callAI.getMockImplementation()!;
    f.callAI.mockImplementation(async prompt => (await call(prompt)).replace(/mark_read/g, 'keep_unread'));
    await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    const refreshed = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined, cacheOptions);
    expect(f.callAI).toHaveBeenCalledTimes(1); expect(refreshed.coverage[0]!.cachedRecommendations).toBe(1);
    expect((await applyInboxAssistantReview(refreshed, [refreshed.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });
});

describe('explicit reviewed archive and Trash actions', () => {
  it.each(['archive', 'trash'] as const)('moves all trusted members of a manually chosen protected conversation to %s', async action => {
    const f = fixture([
      email('protected', { tags: '|INBOX|important|' }),
      email('read-sibling', { threadId: 'thread-protected', tags: '|INBOX|read|' }),
      email('other'),
    ], [email('protected')]);
    const review = await prepareInboxAssistantReview(accounts, 'unread', f.deps);
    const chosen = review.items.find(item => item.accountId === 'a' && item.emailId === 'protected')!;
    expect(chosen).toMatchObject({ recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true });
    // Display fields are untrusted and cannot expand the host's IDs or owner.
    chosen.unreadEmailIds.push('other'); chosen.targetEmailIds = ['other']; chosen.accountId = 'b';
    const result = await applyInboxAssistantReview(review, [chosen.id], f.deps, undefined, { action, manualSelection: true });
    expect(f.moveMail).toHaveBeenCalledExactlyOnceWith('a', ['protected', 'read-sibling'], action, { source: 'user' });
    expect(f.setRead).not.toHaveBeenCalled();
    expect(result).toMatchObject({ appliedCount: 1, items: [{ action, appliedIds: ['protected', 'read-sibling'], status: 'applied' }] });
    expect(chosen).toMatchObject({ appliedAction: action, undoAvailable: false, mailActionsAllowed: false });
    expect(f.data.get('a')!.get('other')!.tags).toContain('|INBOX|');
    expect(f.data.get('b')!.get('protected')!.tags).toContain('|INBOX|');
    const again = await applyInboxAssistantReview(review, [chosen.id], f.deps, undefined, { action, manualSelection: true });
    expect(again.items).toEqual(result.items);
    expect(f.moveMail).toHaveBeenCalledTimes(1);
    expect((await undoInboxAssistantReview(review, [chosen.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each(['archive', 'trash'] as const)('never lets automatic recommendations invoke %s', async action => {
    const f = fixture();
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    await expect(applyInboxAssistantReview(review, [review.items[0]!.id], f.deps, undefined, { action })).rejects.toThrow('explicit selection');
    expect(f.moveMail).not.toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each(['arrival', 'flag', 'owner', 'expiry', 'incomplete'] as const)('revalidates a manual move against %s', async change => {
    const f = fixture();
    if (change === 'incomplete') Object.assign(f.mailboxes.get('a')!.storage, { getEmailsByThread: undefined });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    if (change === 'arrival') f.data.get('a')!.set('arrival', email('arrival', { threadId: 'thread-one' }));
    if (change === 'flag') f.data.get('a')!.get('one')!.tags += 'starred|';
    if (change === 'owner') f.mailboxes.delete('a');
    if (change === 'expiry') {
      const now = vi.spyOn(Date, 'now').mockReturnValue(review.expiresAt);
      await expect(applyInboxAssistantReview(review, [review.items[0]!.id], f.deps, undefined, { action: 'trash', manualSelection: true })).rejects.toThrow('expired');
      now.mockRestore();
    } else {
      review.items[0]!.mailActionsAllowed = true;
      const result = await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps, undefined, { action: 'trash', manualSelection: true });
      expect(result.appliedCount + result.queuedCount).toBe(0);
    }
    expect(f.moveMail).not.toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each(['archive', 'trash'] as const)('permits %s after an exact acknowledged read snapshot, while retiring read undo', async action => {
    const f = fixture([email('one'), email('read-sibling', { threadId: 'thread-one', tags: '|INBOX|read|' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const item = review.items[0]!;
    await applyInboxAssistantReview(review, [item.id], f.deps);
    expect(item).toMatchObject({ appliedAction: 'mark_read', undoAvailable: true, mailActionsAllowed: true });
    const moved = await applyInboxAssistantReview(review, [item.id], f.deps, undefined, { action, manualSelection: true });
    expect(moved.appliedCount).toBe(1);
    expect(f.moveMail).toHaveBeenCalledExactlyOnceWith('a', ['one', 'read-sibling'], action, { source: 'user' });
    expect(item).toMatchObject({ appliedAction: action, undoAvailable: false, mailActionsAllowed: false });
    await undoInboxAssistantReview(review, [item.id], f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['one'], true);
    expect(item).toMatchObject({ status: 'applied', appliedAction: action });
    const different = await applyInboxAssistantReview(review, [item.id], f.deps, undefined, { action: action === 'archive' ? 'trash' : 'archive', manualSelection: true });
    expect(different.skippedCount).toBe(1);
    expect(f.moveMail).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale post-read snapshot before moving and preserves its read receipt', async () => {
    const f = fixture();
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const id = review.items[0]!.id;
    await applyInboxAssistantReview(review, [id], f.deps);
    f.data.get('a')!.get('one')!.tags += 'starred|';
    expect((await applyInboxAssistantReview(review, [id], f.deps, undefined, { action: 'archive', manualSelection: true })).skippedCount).toBe(1);
    expect(f.moveMail).not.toHaveBeenCalled();
  });

  it('retains read undo if a move failed without acknowledging any mail', async () => {
    const f = fixture();
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const item = review.items[0]!;
    await applyInboxAssistantReview(review, [item.id], f.deps);
    f.moveMail.mockResolvedValue({ appliedIds: [], queuedIds: [], failedIds: ['one'] });
    expect((await applyInboxAssistantReview(review, [item.id], f.deps, undefined, { action: 'trash', manualSelection: true })).failedCount).toBe(1);
    expect(item.undoAvailable).toBe(true);
    await undoInboxAssistantReview(review, [item.id], f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['one'], false, { source: 'user' });
  });

  it('keeps acknowledged move receipts when stopping between conversations and never replays them', async () => {
    const f = fixture([email('one'), email('two')]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const controller = new AbortController();
    f.moveMail.mockImplementation(async (_account, ids) => { controller.abort(); return { appliedIds: [], queuedIds: ids, failedIds: [] }; });
    const ids = review.items.map(item => item.id);
    const result = await applyInboxAssistantReview(review, ids, f.deps, controller.signal, { action: 'trash', manualSelection: true });
    expect(result).toMatchObject({ queuedCount: 1, skippedCount: 1, items: [{ action: 'trash', queuedIds: ['one'], status: 'queued' }, { status: 'skipped' }] });
    await applyInboxAssistantReview(review, [ids[0]!], f.deps, undefined, { action: 'trash', manualSelection: true });
    expect(f.moveMail).toHaveBeenCalledTimes(1);
    expect(review.items[0]).toMatchObject({ appliedAction: 'trash', undoAvailable: false });
  });
});

describe('reviewed Inbox Agent mark-read actions', () => {
  it('prepares all unread threads including already-processed uncategorized mail without mutating anything', async () => {
    const f = fixture([email('old', { aiProcessedAt: 100 }), email('labeled', { tags: '|INBOX|promotions|' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items).toHaveLength(2);
    expect(review.items.find(item => item.emailId === 'old')).toMatchObject({ uncategorized: true, recommendation: 'mark_read', status: 'pending' });
    expect(review.items.find(item => item.emailId === 'labeled')?.categories).toEqual(['promotions']);
    expect(f.mailboxes.get('a')!.storage.searchEmails).toHaveBeenCalledWith(expect.objectContaining({ isUnread: true, collapseThreads: true, scope: 'mailbox' }));
    expect(f.setRead).not.toHaveBeenCalled();
    expect(review.expiresAt).toBeGreaterThan(review.createdAt);
  });

  it('uncategorized review is independent of AI processing state and preserves explicit/manual/provider categories', async () => {
    const f = fixture([email('empty-ai', { aiProcessedAt: 99 }), email('user-clear', { manualCategories: [] }), email('provider', { serverCategories: ['promotions'] }), email('labeled', { tags: '|INBOX|promotions|' }), email('read', { tags: '|INBOX|read|' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'uncategorized', f.deps);
    expect(review.items.map(item => item.emailId)).toEqual(['empty-ai', 'user-clear', 'provider']);
    expect(review.items.find(item => item.emailId === 'user-clear')).toMatchObject({ uncategorized: true, recommendation: 'keep_unread' });
    expect(review.items.find(item => item.emailId === 'provider')).toMatchObject({ uncategorized: true, recommendation: 'keep_unread' });
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('groups unread members once while never changing previously read members', async () => {
    const rows = [email('one'), email('two', { threadId: 'thread-one' }), email('read', { threadId: 'thread-one', tags: '|INBOX|read|' })];
    const f = fixture(rows);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ unreadCount: 2, messageCount: 3 });
    const result = await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(result.appliedCount).toBe(1);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['one', 'two'], true);
  });

  it('keeps duplicate email/thread IDs isolated by owning account', async () => {
    const f = fixture([email('same')], [email('same')]);
    const review = await prepareInboxAssistantReview(accounts, 'unread', f.deps);
    const second = review.items.find(item => item.accountId === 'b')!;
    await applyInboxAssistantReview(review, [second.id], f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('b', ['same'], true);
    expect(f.data.get('a')!.get('same')!.tags).not.toContain('|read|');
  });

  it.each([
    { tags: '|INBOX|important|' }, { tags: '|INBOX|starred|' }, { tags: '|INBOX|needs_response|' }, { tags: '|INBOX|finance|' }, { tags: '|INBOX|invoices|' }, { tags: '|INBOX|meetings|' },
    { fromAddress: accounts[0]!.email }, { fromAddress: 'teammate@company.example' }, { gmailImportant: true }, { subject: 'Invoice payment due' }, { pgpStatus: 'encrypted' as const }, { gmailCategoriesPending: true },
  ])('protects business/action-required mail despite any AI choice: %j', async flags => {
    const f = fixture([email('safe', flags)]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]!.recommendation).toBe('keep_unread');
    expect(f.callAI).not.toHaveBeenCalled();
    await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('protects favorite contacts and unread attachment contents without requesting attachment access', async () => {
    const f = fixture([email('known'), email('attachment', { hasAttachments: true, attachmentNames: '["proposal.xlsx"]' })]);
    f.mailboxes.get('a')!.storage.getContacts.mockResolvedValue([{ email: 'offers@newsletter.example', sentCount: 1, isFavorite: true }] as never);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items.every(item => item.recommendation === 'keep_unread')).toBe(true);
    expect(review.items.find(item => item.emailId === 'attachment')!.attachmentsUnknown).toBe(true);
    expect(f.callAI).not.toHaveBeenCalled();
  });

  it('permits an explicit manual keep-unread selection and undo without changing read siblings or other recommendations', async () => {
    const f = fixture([
      email('important', { tags: '|INBOX|important|' }),
      email('read-sibling', { threadId: 'thread-important', tags: '|INBOX|read|' }),
      email('keep-other', { tags: '|INBOX|finance|' }),
    ]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const chosen = review.items.find(item => item.emailId === 'important')!;
    expect(chosen).toMatchObject({ recommendation: 'keep_unread', manualSelectionAllowed: true });
    const result = await applyInboxAssistantReview(review, [chosen.id], f.deps, undefined, { manualSelection: true });
    expect(result.appliedCount).toBe(1);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['important'], true, { source: 'user' });
    expect(review.items.find(item => item.emailId === 'keep-other')!.status).toBe('pending');
    expect(chosen.undoAvailable).toBe(true);
    await undoInboxAssistantReview(review, [chosen.id], f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['important'], false, { source: 'user' });
    expect(f.data.get('a')!.get('read-sibling')!.tags).toContain('|read|');
  });

  it('allows a manual needs-review selection while the ordinary apply path still requires an eligible recommendation', async () => {
    const f = fixture();
    f.callAI.mockResolvedValue(JSON.stringify({ recommendations: [] }));
    const ordinary = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(ordinary.items[0]).toMatchObject({ recommendation: 'needs_review', manualSelectionAllowed: true });
    expect((await applyInboxAssistantReview(ordinary, [ordinary.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
    const manual = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect((await applyInboxAssistantReview(manual, [manual.items[0]!.id], f.deps, undefined, { manualSelection: true })).appliedCount).toBe(1);
  });

  it('never permits manual overrides of incomplete membership or trusts an edited display permission', async () => {
    const f = fixture([email('incomplete', { tags: '|INBOX|important|' })]);
    Object.assign(f.mailboxes.get('a')!.storage, { getEmailsByThread: undefined });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]!.manualSelectionAllowed).toBe(false);
    review.items[0]!.manualSelectionAllowed = true;
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps, undefined, { manualSelection: true })).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it.each(['arrival', 'flag', 'expiry'])('revalidates manual selections against %s before marking any mail', async change => {
    const f = fixture([email('protected', { tags: '|INBOX|important|' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    if (change === 'arrival') f.data.get('a')!.set('arrival', email('arrival', { threadId: 'thread-protected' }));
    if (change === 'flag') f.data.get('a')!.get('protected')!.tags += 'starred|';
    if (change === 'expiry') {
      const now = vi.spyOn(Date, 'now').mockReturnValue(review.expiresAt);
      await expect(applyInboxAssistantReview(review, [review.items[0]!.id], f.deps, undefined, { manualSelection: true })).rejects.toThrow('expired');
      now.mockRestore();
    } else expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps, undefined, { manualSelection: true })).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('downloads a missing original rather than trusting a preview, and holds an unavailable body unread', async () => {
    const f = fixture([email('missing', { rawBody: ' \n ', cleanBody: 'Preview only', hasBody: false })]);
    const mailbox = f.mailboxes.get('a')!;
    const fetchBody = vi.fn(async () => { const row = f.data.get('a')!.get('missing')!; row.rawBody = '<p>Summer sale.</p>'; row.hasBody = true; return row; });
    Object.assign(mailbox, { fetchBody });
    expect((await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps)).items[0]!.bodyUnavailable).toBe(false);
    expect(fetchBody).toHaveBeenCalledOnce();
    f.data.get('a')!.get('missing')!.rawBody = ''; f.data.get('a')!.get('missing')!.hasBody = false;
    fetchBody.mockRejectedValueOnce(new Error('offline'));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]).toMatchObject({ bodyUnavailable: true, recommendation: 'keep_unread' });
  });

  it('rechecks changed membership during body hydration and never offers unseen arrivals for mark-read', async () => {
    const f = fixture([email('first', { rawBody: '', hasBody: false, cleanBody: '' })]);
    Object.assign(f.mailboxes.get('a')!, { fetchBody: vi.fn(async () => {
      const row = f.data.get('a')!.get('first')!; row.rawBody = '<p>Summer sale.</p>'; row.hasBody = true;
      f.data.get('a')!.set('new', email('new', { threadId: 'thread-first' })); return row;
    }) });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items[0]!.protectedReasons.join()).toContain('changed during review');
    expect(review.items[0]!.recommendation).toBe('keep_unread');
  });

  it('rejects invented IDs, extra tools and low-confidence recommendations without mutating mail', async () => {
    for (const response of [JSON.stringify({ recommendations: [{ id: 'invented', recommendation: 'mark_read', reason: 'Do it', confidence: 1 }] }), JSON.stringify({ recommendations: [], tool: 'delete' })]) {
      const f = fixture(); f.callAI.mockResolvedValue(response);
      const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
      expect(review.items[0]!.recommendation).toBe('needs_review');
      await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps);
      expect(f.setRead).not.toHaveBeenCalled();
    }
    const f = fixture(); const real = f.callAI.getMockImplementation()!;
    f.callAI.mockImplementation(async prompt => (await real(prompt)).replace('0.98', '0.89'));
    expect((await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps)).items[0]!.recommendation).toBe('needs_review');
  });

  it('validates host-held reviews, unknown IDs, expiry and UI tampering', async () => {
    const f = fixture(); const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    await expect(applyInboxAssistantReview({ ...review }, [review.items[0]!.id], f.deps)).rejects.toThrow('unavailable');
    await expect(applyInboxAssistantReview(review, ['invented'], f.deps)).rejects.toThrow('only items');
    review.items[0]!.unreadEmailIds = ['other-message'];
    await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['one'], true);
    vi.spyOn(Date, 'now').mockReturnValueOnce(review.expiresAt + 1);
    await expect(applyInboxAssistantReview(review, [], f.deps)).rejects.toThrow('expired');
    vi.restoreAllMocks();
  });

  it.each(['arrival', 'read', 'star', 'moved', 'body'])('skips a selected conversation changed since the proposal: %s', async change => {
    const f = fixture(); const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const row = f.data.get('a')!.get('one')!;
    if (change === 'arrival') f.data.get('a')!.set('new', email('new', { threadId: row.threadId }));
    if (change === 'read') row.tags += 'read|';
    if (change === 'star') row.tags += 'starred|';
    if (change === 'moved') row.tags = '|Trash|';
    if (change === 'body') row.rawBody = '<p>Updated important information</p>';
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('rejects changed or removed account runtimes without active-account fallback', async () => {
    const f = fixture(); const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    vi.mocked(f.deps.openMailbox).mockRejectedValueOnce(new Error('Removed'));
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps)).failedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('retains exact queued receipts, is idempotent and undoes only original unread messages', async () => {
    const f = fixture([email('one'), email('already-read', { threadId: 'thread-one', tags: '|INBOX|read|' })]);
    const set = f.setRead.getMockImplementation()!;
    f.setRead.mockImplementation(async (account, ids, read) => { await set(account, ids, read); return { appliedIds: [], queuedIds: ids, failedIds: [] }; });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps); const ids = [review.items[0]!.id];
    expect((await applyInboxAssistantReview(review, ids, f.deps)).queuedCount).toBe(1);
    await applyInboxAssistantReview(review, ids, f.deps);
    expect(f.setRead).toHaveBeenCalledOnce();
    await undoInboxAssistantReview(review, ids, f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['one'], false, { source: 'user' });
    await undoInboxAssistantReview(review, ids, f.deps);
    expect(f.setRead).toHaveBeenCalledTimes(2);
    expect(f.data.get('a')!.get('already-read')!.tags).toContain('|read|');
    expect(review.items[0]!.status).toBe('undone');
    expect(review.items[0]!.undoAvailable).toBe(false);
    expect((await applyInboxAssistantReview(review, ids, f.deps)).items[0]!.status).toBe('undone');
    expect(f.setRead).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('keeps undo available when a real storage read derives the Seen flag for targetRead=%s', async targetRead => {
    const f = fixture([email('one', { tags: targetRead ? '|INBOX|' : '|INBOX|read|', flags: targetRead ? [] : ['\\Seen'], fromName: 'BigBlueButton' })]);
    const set = f.setRead.getMockImplementation()!;
    f.setRead.mockImplementation(async (account, ids, desired) => {
      const receipt = await set(account, ids, desired);
      for (const id of ids) f.data.get(account)!.get(id)!.flags = desired ? ['\\Seen'] : [];
      return receipt;
    });
    const review = await prepareInboxAssistantReview([accounts[0]!], targetRead ? 'mark_read' : 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'sender' } });
    const ids = [review.items[0]!.id];
    await applyInboxAssistantReview(review, ids, f.deps);
    expect(review.items[0]!.undoAvailable).toBe(true);
    await undoInboxAssistantReview(review, ids, f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['one'], !targetRead, { source: 'user' });
    expect(f.data.get('a')!.get('one')!.tags.includes('|read|')).toBe(!targetRead);
  });

  it.each(['flag', 'body', 'attachment'])('retains protection for %s changes while ignoring joined thread projections', async change => {
    const f = fixture([email('one', { tags: '|INBOX|read|', flags: ['\\Seen'], fromName: 'BigBlueButton', threadMessageCount: 1 })]);
    const set = f.setRead.getMockImplementation()!;
    f.setRead.mockImplementation(async (account, ids, desired) => {
      const receipt = await set(account, ids, desired);
      for (const id of ids) { const row = f.data.get(account)!.get(id)!; row.flags = desired ? ['\\Seen'] : []; delete row.threadMessageCount; }
      return receipt;
    });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'sender' } });
    const ids = [review.items[0]!.id];
    await applyInboxAssistantReview(review, ids, f.deps);
    expect(review.items[0]!.undoAvailable).toBe(true);
    const row = f.data.get('a')!.get('one')!;
    if (change === 'flag') row.flags = ['\\Flagged'];
    if (change === 'body') row.rawBody = '<p>Changed source body.</p>';
    if (change === 'attachment') row.attachmentNames = '["changed-file.pdf"]';
    expect((await undoInboxAssistantReview(review, ids, f.deps)).skippedCount).toBe(1);
    expect(f.setRead).toHaveBeenCalledOnce();
  });

  it('exposes an undo receipt for a partial success and restores only the acknowledged changed IDs', async () => {
    const f = fixture([email('one'), email('two', { threadId: 'thread-one' })]);
    const set = f.setRead.getMockImplementation()!;
    f.setRead.mockImplementation(async (account, ids, read) => {
      if (!read) return set(account, ids, read);
      await set(account, ['one'], true);
      return { appliedIds: ['one'], queuedIds: [], failedIds: ['two'] };
    });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps); const ids = [review.items[0]!.id];
    const applied = await applyInboxAssistantReview(review, ids, f.deps);
    expect(applied.items[0]).toMatchObject({ status: 'failed', appliedIds: ['one'], failedIds: ['two'] });
    expect(review.items[0]).toMatchObject({ status: 'failed', undoAvailable: true });
    await undoInboxAssistantReview(review, ids, f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['one'], false, { source: 'user' });
    expect(f.data.get('a')!.get('two')!.tags).not.toContain('|read|');
  });

  it('a premature undo cannot consume the future successful receipt', async () => {
    const f = fixture(); const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps); const ids = [review.items[0]!.id];
    expect((await undoInboxAssistantReview(review, ids, f.deps)).skippedCount).toBe(1);
    await applyInboxAssistantReview(review, ids, f.deps);
    await undoInboxAssistantReview(review, ids, f.deps);
    expect(f.setRead).toHaveBeenCalledTimes(2);
  });

  it('excludes Trash-only, Spam and Drafts conversations even if a search adapter returns them', async () => {
    const f = fixture([email('trash', { tags: '|Trash|' }), email('spam', { tags: '|Spam|' }), email('draft', { tags: '|Drafts|draft|' }), email('localized', { tags: '|Corbeille|', folderId: 'localized-trash' }), email('live')]);
    f.mailboxes.get('a')!.storage.getFolders.mockResolvedValue([inbox, { ...inbox, id: 'localized-trash', path: 'Corbeille', specialUse: '\\Trash' }]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items.map(item => item.emailId)).toEqual(['live']);
  });

  it('skips undo after a subsequent flag change or new message', async () => {
    const f = fixture(); const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps); const ids = [review.items[0]!.id];
    await applyInboxAssistantReview(review, ids, f.deps);
    f.data.get('a')!.get('one')!.tags += 'starred|';
    expect((await undoInboxAssistantReview(review, ids, f.deps)).skippedCount).toBe(1);
    expect(f.setRead).toHaveBeenCalledOnce();
  });

  it('retains completed receipts when cancellation arrives during a write and stops the remaining selection', async () => {
    const f = fixture([email('one'), email('two')]); const controller = new AbortController();
    const set = f.setRead.getMockImplementation()!;
    f.setRead.mockImplementation(async (account, ids, read) => { const receipt = await set(account, ids, read); controller.abort(); return receipt; });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const result = await applyInboxAssistantReview(review, review.items.map(item => item.id), f.deps, controller.signal);
    expect(result.appliedCount).toBe(1); expect(result.skippedCount).toBe(1);
    expect(review.items[1]!.status).toBe('skipped');
    expect(f.setRead).toHaveBeenCalledOnce();
    await undoInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(f.setRead).toHaveBeenCalledTimes(2);
  });

  it('pages beyond25 messages, caps at200 threads per account and reports continuation', async () => {
    const f = fixture(Array.from({ length: 205 }, (_, index) => email(`m${index}`, { tags: '|INBOX|important|' })));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect(review.items).toHaveLength(200);
    expect(review.coverage[0]).toMatchObject({ hasMore: true, truncated: true, nextOffset: 225 });
    expect(review.truncated).toBe(true);
    expect(f.mailboxes.get('a')!.storage.searchEmails).toHaveBeenCalledTimes(9);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  // These exercise hundreds of complete body reviews. Coverage instrumentation
  // and other parallel CI suites need more than the default single-test budget.
  it('continues past200 unchanged protected threads without revisiting or counting them in the next batch', async () => {
    const f = fixture(Array.from({ length: 400 }, (_, index) => email(`m${index}`, { tags: '|INBOX|important|' })));
    const first = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    const second = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined,
      { excludeThreadIds: { a: first.items.map(item => item.threadId) } });
    expect(first.items).toHaveLength(200);
    expect(second.items.map(item => item.emailId)).toEqual(Array.from({ length: 200 }, (_, index) => `m${index + 200}`));
    expect(second.coverage[0]).toMatchObject({ hasMore: false, truncated: false, reviewedThreads: 200, scannedThreads: 400 });
    expect(second.items.every(item => item.recommendation === 'keep_unread')).toBe(true);
    expect(f.setRead).not.toHaveBeenCalled();
  }, 20_000);

  it('rescans current headers after prior read actions remove rows instead of resuming a stale offset', async () => {
    const f = fixture(Array.from({ length: 400 }, (_, index) => email(`m${index}`)));
    const first = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    expect((await applyInboxAssistantReview(first, first.items.map(item => item.id), f.deps)).appliedCount).toBe(200);
    f.mailboxes.get('a')!.storage.searchEmails.mockClear();
    const second = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined,
      { excludeThreadIds: { a: first.items.map(item => item.threadId) } });
    expect(second.items.map(item => item.emailId)).toEqual(Array.from({ length: 200 }, (_, index) => `m${index + 200}`));
    expect(f.mailboxes.get('a')!.storage.searchEmails).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }));
    expect(second.coverage[0]).toMatchObject({ hasMore: false, truncated: false, scannedThreads: 200 });
  }, 20_000);

  it('scopes continuation exclusions by account even when thread IDs collide', async () => {
    const f = fixture([email('same')], [email('same')]);
    const review = await prepareInboxAssistantReview(accounts, 'unread', f.deps, undefined, undefined,
      { excludeThreadIds: { a: ['thread-same'] } });
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ accountId: 'b', threadId: 'thread-same' });
    expect(review.coverage.map(value => value.hasMore)).toEqual([false, false]);
  });

  it('reaches all500 remaining kept conversations beyond a known2,000-thread prefix', async () => {
    const f = fixture(Array.from({ length: 2_500 }, (_, index) => email(`m${index}`, { tags: '|INBOX|important|' })));
    const excluded = Array.from({ length: 2_000 }, (_, index) => `thread-m${index}`);
    const found: string[] = [];
    for (const count of [200, 200, 100]) {
      const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined,
        { excludeThreadIds: { a: [...excluded] } });
      expect(review.items).toHaveLength(count);
      expect(review.coverage[0]).toMatchObject({ reviewedThreads: count, scannedThreads: excluded.length + count, hasMore: count === 200 });
      found.push(...review.items.map(item => item.emailId));
      excluded.push(...review.items.map(item => item.threadId));
    }
    expect(found).toEqual(Array.from({ length: 500 }, (_, index) => `m${index + 2_000}`));
    expect(f.callAI).not.toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
  }, 20_000);

  it('bounds NEW uncategorized candidates independently of exclusions and reports incomplete coverage', async () => {
    const f = fixture(Array.from({ length: 2_001 }, (_, index) => email(`m${index}`, { tags: '|INBOX|promotions|' })));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined,
      { excludeThreadIds: { a: Array.from({ length: 2_000 }, (_, index) => `thread-m${index}`) } });
    expect(review.items.map(item => item.emailId)).toEqual(['m2000']);
    expect(review.coverage[0]).toMatchObject({ hasMore: false, truncated: false, reviewedThreads: 1, scannedThreads: 2_001 });
    const unclassified = await prepareInboxAssistantReview([accounts[0]!], 'uncategorized', f.deps);
    expect(unclassified.items).toHaveLength(0);
    expect(unclassified.coverage[0]).toMatchObject({ hasMore: true, truncated: true, reviewedThreads: 0, scannedThreads: 2_000 });
    expect(unclassified.coverage[0]!.warnings.join()).toContain('header scan reached its limit');
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('keeps an honest absolute page bound for an unusually large excluded-only continuation', async () => {
    const f = fixture();
    f.mailboxes.get('a')!.storage.searchEmails.mockImplementation(async query => Array.from({ length: 25 }, (_, index) => email(`m${(query.offset ?? 0) + index}`)));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, undefined, undefined,
      { excludeThreadIds: { a: Array.from({ length: 20_000 }, (_, index) => `thread-m${index}`) } });
    expect(review.items).toHaveLength(0);
    expect(review.coverage[0]).toMatchObject({ hasMore: true, truncated: true, reviewedThreads: 0, scannedThreads: 20_000 });
    expect(review.coverage[0]!.warnings.join()).toContain('header scan reached its limit');
    expect(f.mailboxes.get('a')!.storage.searchEmails).toHaveBeenCalledTimes(800);
    expect(f.callAI).not.toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('cancels preparation or apply before any mutation', async () => {
    const f = fixture(); const cancelled = new AbortController(); cancelled.abort(new Error('Cancelled'));
    await expect(prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps, cancelled.signal)).rejects.toThrow('Cancelled');
    const review = await prepareInboxAssistantReview([accounts[0]!], 'unread', f.deps);
    await expect(applyInboxAssistantReview(review, [review.items[0]!.id], f.deps, cancelled.signal)).rejects.toThrow('Cancelled');
    expect(f.setRead).not.toHaveBeenCalled();
  });
});

describe('explicit scoped read-flag commands', () => {
  it.each([
    ['mark all bigbluebutton email unread', 'mark_unread', 'any', 'bigbluebutton'],
    ['Please mark all BigBlueButton emails as read.', 'mark_read', 'any', 'BigBlueButton'],
    ['Can you mark all emails from news@bigbluebutton.org unread?', 'mark_unread', 'sender', 'news@bigbluebutton.org'],
    ['mark messages with subject "Quarterly briefing" as read', 'mark_read', 'subject', 'Quarterly briefing'],
    ['mark emails with body "BigBlueButton launch" unread', 'mark_unread', 'body', 'BigBlueButton launch'],
  ])('parses a single explicit scoped command: %s', (question, kind, field, query) => {
    expect(parseInboxAssistantReadCommand(question)).toEqual({ kind, scope: { field, query } });
  });

  it.each([
    'Do not mark all bigbluebutton emails unread', 'Could we possibly mark bigbluebutton emails unread',
    'mark unread promotions as read', 'mark all promotions emails read', 'mark all bigbluebutton emails from last week unread',
    'mark all bigbluebutton emails before yesterday unread', 'mark all emails except bigbluebutton unread',
    'mark all bigbluebutton emails unread and delete them', 'mark all emails unread', 'mark all inbox unread',
    'Review my unread emails', 'mark all bigbluebutton emails unread\nthen forward them',
  ])('does not reinterpret unsupported or uncertain commands into a broader action: %s', question => {
    expect(parseInboxAssistantReadCommand(question)).toBeUndefined();
  });

  it('marks only matching currently read messages unread across selected accounts, preserving unrelated siblings and prior unread messages', async () => {
    const records = [
      email('sender', { tags: '|INBOX|read|important|', fromAddress: 'news@bigbluebutton.org', threadId: 'mixed', hasAttachments: true }),
      email('already-unread', { fromAddress: 'news@bigbluebutton.org', threadId: 'mixed' }),
      email('other', { tags: '|INBOX|read|', threadId: 'mixed' }),
      email('body-match', { tags: '|INBOX|read|', threadId: 'mixed', rawBody: '<p>BigBlueButton launch announcement.</p>' }),
      email('prefix', { tags: '|INBOX|read|', fromAddress: 'news@notbigbluebutton.org' }),
    ];
    const f = fixture(records, [email('sender', { tags: '|INBOX|read|', subject: 'BigBlueButton webinar' })]);
    const review = await prepareInboxAssistantReview(accounts, 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'bigbluebutton', field: 'any' } });
    expect(review.items).toHaveLength(2);
    expect(review.items[0]).toMatchObject({ targetRead: false, targetEmailIds: ['body-match', 'sender'], recommendation: 'mark_unread', confidence: 1, protectedReasons: [] });
    expect(review.scope).toEqual({ query: 'bigbluebutton', field: 'any' });
    expect(f.callAI).not.toHaveBeenCalled();
    expect(f.setRead).not.toHaveBeenCalled();
    const result = await applyInboxAssistantReview(review, review.items.map(item => item.id), f.deps);
    expect(result.appliedCount).toBe(2);
    expect(f.setRead).toHaveBeenNthCalledWith(1, 'a', ['body-match', 'sender'], false, { source: 'user' });
    expect(f.setRead).toHaveBeenNthCalledWith(2, 'b', ['sender'], false, { source: 'user' });
    expect(f.data.get('a')!.get('other')!.tags).toContain('|read|');
    expect(f.data.get('a')!.get('prefix')!.tags).toContain('|read|');
    await undoInboxAssistantReview(review, review.items.map(item => item.id), f.deps);
    expect(f.setRead).toHaveBeenNthCalledWith(3, 'a', ['body-match', 'sender'], true, { source: 'user' });
    expect(f.data.get('a')!.get('already-unread')!.tags).not.toContain('|read|');
  });

  it.each(['sender', 'subject', 'body'] as const)('enforces the requested %s field rather than matching another field', async field => {
    const f = fixture([
      email('sender', { tags: '|INBOX|read|', fromName: 'BigBlueButton' }),
      email('subject', { tags: '|INBOX|read|', subject: 'BigBlueButton announcement' }),
      email('body', { tags: '|INBOX|read|', rawBody: '<p>BigBlueButton announcement.</p>' }),
    ]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'bigbluebutton', field } });
    expect(review.items.map(item => item.emailId)).toEqual([field]);
    await applyInboxAssistantReview(review, review.items.map(item => item.id), f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', [field], false, { source: 'user' });
    expect(f.callAI).not.toHaveBeenCalled();
  });

  it('marks a precise explicit business scope read and undoes only its original unread matches', async () => {
    const f = fixture([
      email('match', { subject: 'BigBlueButton invoice', tags: '|INBOX|finance|' }),
      email('other', { threadId: 'thread-match' }),
      email('already-read', { subject: 'BigBlueButton invoice', threadId: 'thread-match', tags: '|INBOX|read|' }),
    ]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_read', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'subject' } });
    expect(review.items[0]).toMatchObject({ targetRead: true, targetEmailIds: ['match'], recommendation: 'mark_read', confidence: 1 });
    // Public display data cannot substitute unrelated messages or the flag.
    review.items[0]!.targetEmailIds = ['other']; review.items[0]!.targetRead = false;
    await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['match'], true, { source: 'user' });
    await undoInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['match'], false, { source: 'user' });
    expect(f.data.get('a')!.get('other')!.tags).not.toContain('|read|');
    expect(f.data.get('a')!.get('already-read')!.tags).toContain('|read|');
  });

  it('checks complete raw originals with a bounded fallback when the cleaned search index omitted the body match', async () => {
    const f = fixture([email('raw', { tags: '|INBOX|read|', cleanBody: 'A stripped preview', rawBody: '<p>Original complete BigBlueButton details.</p>' })]);
    const realSearch = f.mailboxes.get('a')!.storage.searchEmails.getMockImplementation()!;
    f.mailboxes.get('a')!.storage.searchEmails.mockImplementation(async query => query.query ? [] : realSearch(query));
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'bigbluebutton', field: 'body' } });
    expect(review.items[0]!.targetEmailIds).toEqual(['raw']);
    expect(f.mailboxes.get('a')!.storage.searchEmails).toHaveBeenCalledWith(expect.objectContaining({ query: '', isUnread: false }));
  });

  it('downloads missing originals to verify body matches and never selects an unverifiable message', async () => {
    const f = fixture([email('missing', { tags: '|INBOX|read|', rawBody: '', cleanBody: 'BigBlueButton preview', hasBody: false }), email('offline', { tags: '|INBOX|read|', rawBody: '', cleanBody: '', hasBody: false })]);
    const fetchBody = vi.fn(async (record: EmailRecord) => {
      if (record.id === 'offline') throw new Error('Offline');
      const row = f.data.get('a')!.get(record.id)!; row.rawBody = '<p>BigBlueButton original.</p>'; row.hasBody = true; return row;
    });
    Object.assign(f.mailboxes.get('a')!, { fetchBody });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'body' } });
    expect(review.items.map(item => item.emailId)).toEqual(['missing']);
    expect(fetchBody).toHaveBeenCalledTimes(2);
    expect(review.truncated).toBe(true);
    expect(review.coverage[0]!.warnings.join()).toContain('could not be verified');
  });

  it.each(['any', 'body'] as const)('never downloads unrelated uncached originals in the broad %s fallback', async field => {
    const f = fixture([
      email('cached-match', { tags: '|INBOX|read|', cleanBody: 'Short stripped preview', rawBody: '<p>Complete BigBlueButton original.</p>' }),
      email('random-missing', { tags: '|INBOX|read|', rawBody: '', cleanBody: '', hasBody: false }),
    ]);
    const real = f.mailboxes.get('a')!.storage.searchEmails.getMockImplementation()!;
    f.mailboxes.get('a')!.storage.searchEmails.mockImplementation(async query => query.query ? [] : real(query));
    const fetchBody = vi.fn(async () => { throw new Error('No speculative downloads'); });
    Object.assign(f.mailboxes.get('a')!, { fetchBody });
    const onProgress = vi.fn();
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, onProgress, { scope: { query: 'BigBlueButton', field } });
    expect(review.items.map(item => item.emailId)).toEqual(['cached-match']);
    expect(fetchBody).not.toHaveBeenCalled();
    expect(review.truncated).toBe(true);
    expect(review.coverage[0]).toMatchObject({ skippedUncachedBodies: 1, hasMore: false, reviewedThreads: 1 });
    expect(review.coverage[0]!.warnings.join()).toContain('1 uncached message original was skipped');
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'body', status: 'warning', message: expect.stringContaining('1 uncached') }));
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('downloads only actual indexed message IDs while checking cached siblings and skipping their unrelated missing bodies', async () => {
    const f = fixture([
      email('indexed', { tags: '|INBOX|read|', rawBody: '', cleanBody: 'BigBlueButton preview', hasBody: false }),
      email('cached-sibling', { tags: '|INBOX|read|', threadId: 'thread-indexed', rawBody: '<p>Complete BigBlueButton sibling.</p>' }),
      email('missing-sibling', { tags: '|INBOX|read|', threadId: 'thread-indexed', rawBody: '', cleanBody: '', hasBody: false }),
    ]);
    const real = f.mailboxes.get('a')!.storage.searchEmails.getMockImplementation()!;
    f.mailboxes.get('a')!.storage.searchEmails.mockImplementation(async query => query.query ? [f.data.get('a')!.get('indexed')!] : real(query));
    const fetchBody = vi.fn(async (record: EmailRecord) => {
      if (record.id !== 'indexed') throw new Error('Unrelated sibling download');
      const row = f.data.get('a')!.get(record.id)!; row.rawBody = '<p>Complete BigBlueButton indexed original.</p>'; row.hasBody = true; return row;
    });
    Object.assign(f.mailboxes.get('a')!, { fetchBody });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'any' } });
    expect(fetchBody).toHaveBeenCalledOnce();
    expect(fetchBody.mock.calls[0]![0].id).toBe('indexed');
    expect(review.items[0]!.targetEmailIds).toEqual(['cached-sibling', 'indexed']);
    expect(review.coverage[0]).toMatchObject({ skippedUncachedBodies: 1, hasMore: false });
    await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps);
    expect(f.setRead).toHaveBeenCalledExactlyOnceWith('a', ['cached-sibling', 'indexed'], false, { source: 'user' });
    expect(f.data.get('a')!.get('missing-sibling')!.tags).toContain('|read|');
  });

  it.each(['read', 'body', 'arrival'])('revalidates scoped membership and original state before applying: %s', async change => {
    const f = fixture([email('match', { tags: '|INBOX|read|', rawBody: '<p>BigBlueButton original.</p>' })]);
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'body' } });
    const row = f.data.get('a')!.get('match')!;
    if (change === 'read') row.tags = '|INBOX|';
    if (change === 'body') row.rawBody = '<p>Other content.</p>';
    if (change === 'arrival') f.data.get('a')!.set('new', email('new', { threadId: row.threadId }));
    expect((await applyInboxAssistantReview(review, [review.items[0]!.id], f.deps)).skippedCount).toBe(1);
    expect(f.setRead).not.toHaveBeenCalled();
  });

  it('keeps partial mark-unread receipts reversible for only acknowledged original read messages', async () => {
    const f = fixture([email('one', { tags: '|INBOX|read|', fromName: 'BigBlueButton' }), email('two', { tags: '|INBOX|read|', fromName: 'BigBlueButton', threadId: 'thread-one' })]);
    const set = f.setRead.getMockImplementation()!;
    f.setRead.mockImplementation(async (account, ids, desired) => {
      if (desired) return set(account, ids, desired);
      await set(account, ['one'], false); return { appliedIds: [], queuedIds: ['one'], failedIds: ['two'] };
    });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'sender' } });
    const ids = [review.items[0]!.id];
    expect((await applyInboxAssistantReview(review, ids, f.deps)).failedCount).toBe(1);
    expect(review.items[0]!.undoAvailable).toBe(true);
    await undoInboxAssistantReview(review, ids, f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['one'], true, { source: 'user' });
    expect(f.data.get('a')!.get('two')!.tags).toContain('|read|');
  });

  it('retains a completed mark-unread receipt after cancellation and never repeats its write', async () => {
    const f = fixture([email('one', { tags: '|INBOX|read|', fromName: 'BigBlueButton' }), email('two', { tags: '|INBOX|read|', fromName: 'BigBlueButton' })]);
    const controller = new AbortController();
    const set = f.setRead.getMockImplementation()!;
    f.setRead.mockImplementation(async (account, ids, desired) => { const receipt = await set(account, ids, desired); controller.abort(); return receipt; });
    const review = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope: { query: 'BigBlueButton', field: 'sender' } });
    const result = await applyInboxAssistantReview(review, review.items.map(item => item.id), f.deps, controller.signal);
    expect(result).toMatchObject({ appliedCount: 1, skippedCount: 1 });
    const first = [review.items[0]!.id];
    expect((await applyInboxAssistantReview(review, first, f.deps)).appliedCount).toBe(1);
    expect(f.setRead).toHaveBeenCalledOnce();
    await undoInboxAssistantReview(review, first, f.deps);
    expect(f.setRead).toHaveBeenLastCalledWith('a', ['one'], true, { source: 'user' });
    expect(f.data.get('a')!.get('two')!.tags).toContain('|read|');
  });

  it('continues scoped mark-unread matching after the previous batch leaves the read search', async () => {
    const f = fixture(Array.from({ length: 400 }, (_, index) => email(`m${index}`, { tags: '|INBOX|read|', fromName: 'BigBlueButton' })));
    const scope = { query: 'BigBlueButton', field: 'sender' } as const;
    const first = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined, { scope });
    expect(first.items).toHaveLength(200);
    expect(first.coverage[0]!.hasMore).toBe(true);
    await applyInboxAssistantReview(first, first.items.map(item => item.id), f.deps);
    const second = await prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps, undefined, undefined,
      { scope, excludeThreadIds: { a: first.items.map(item => item.threadId) } });
    expect(second.items.map(item => item.emailId)).toEqual(Array.from({ length: 200 }, (_, index) => `m${index + 200}`));
    expect(second.coverage[0]).toMatchObject({ hasMore: false, reviewedThreads: 200, truncated: false });
    expect(f.callAI).not.toHaveBeenCalled();
  });

  it('requires a specific typed scope and refuses empty/all-mail scope', async () => {
    const f = fixture();
    await expect(prepareInboxAssistantReview([accounts[0]!], 'mark_unread', f.deps)).rejects.toThrow('Specify');
    await expect(prepareInboxAssistantReview([accounts[0]!], 'mark_read', f.deps, undefined, undefined, { scope: { field: 'any', query: '' } })).rejects.toThrow('Specify');
    await expect(prepareInboxAssistantReview([accounts[0]!], 'mark_read', f.deps, undefined, undefined, { scope: { field: 'any', query: 'all' } })).rejects.toThrow('Specify');
    expect(f.setRead).not.toHaveBeenCalled();
  });
});
