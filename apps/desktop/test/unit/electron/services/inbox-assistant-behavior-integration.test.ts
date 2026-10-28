import type { FolderRecord, SearchQuery, UserActionType } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRepository } from '../../../../../../packages/storage-node/src/repositories/agent-repository';
import { newMigratedDb } from '../../../../../../packages/storage-node/src/test-support/test-db';
import { prepareInboxAssistantReview, type InboxAssistantActionDeps } from '../../../../electron/services/inbox-assistant-actions';
import { InboxAssistantRecommendationCache } from '../../../../electron/services/inbox-assistant-recommendation-cache';
import { createUnreadReviewBehaviorContext } from '../../../../electron/services/inbox-assistant-review-behavior';
import { emailRecord } from '../../../helpers/email-fixtures';

const DAY = 86400;
const databases: ReturnType<typeof newMigratedDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('sender decisions reach unread review across mail deletion', () => {
  it('passes real durable human dispositions into AI and invalidates a cached recommendation after another deletion', async () => {
    const now = Math.floor(Date.now() / 1000);
    const sender = 'offers@vendor.example';
    const db = newMigratedDb(); databases.push(db);
    const agent = new AgentRepository(() => db);
    db.prepare('INSERT INTO folders (id, name, path) VALUES (?, ?, ?)').run('inbox', 'Inbox', 'INBOX');
    const seed = (id: string) => {
      db.prepare('INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date) VALUES (?, ?, ?, ?, ?)')
        .run(`thread-${id}`, 'Historical private subject', `<${id}@vendor.example>`, `<${id}@vendor.example>`, now - 7 * DAY);
      db.prepare(`INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, to_address, date, content_type, content_hash, clean_body, raw_body)
        VALUES (?, ?, ?, 'inbox', ?, '|INBOX|', 'Historical private subject', ?, 'owner@company.example', ?, 'text', ?, 'Private historical body', 'Private historical body')`)
        .run(id, `<${id}@vendor.example>`, `thread-${id}`, Number(id.replace(/\D/gu, '')) || 1, sender, now - 7 * DAY, `hash-${id}`);
    };
    const log = (id: string, type: UserActionType, timestamp: number, source: 'user' | 'agent_auto' = 'user') => {
      agent.logAction({ id: `${id}-${type}`, emailId: id, threadId: null, actionType: type, actionValue: null,
        source, senderAddress: sender, timestamp, createdAt: timestamp });
    };
    for (const id of ['old1', 'old2', 'old3', 'auto4', 'current5']) seed(id);
    log('old1', 'read', now - DAY - 5); log('old1', 'delete', now - DAY);
    log('old2', 'delete', now - DAY);
    log('old3', 'read', now - 4 * DAY);
    log('auto4', 'read', now - DAY, 'agent_auto'); log('auto4', 'delete', now - DAY, 'agent_auto');
    db.prepare("DELETE FROM emails WHERE id IN ('old1','old2','auto4')").run();

    const evidence = agent.getUnreadReviewSenderContextBatch([sender], now)[sender]!;
    expect(evidence).toMatchObject({ received90d: 4, markedRead90d: 2, deleted90d: 2,
      readThenDeleted90d: 1, readThenDeletedFast90d: 1, readAndKept90d: 1, deletedWithoutRead90d: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_action_log').get()).toEqual({ n: 1 });

    const current = emailRecord({ id: 'current5', messageId: '<current5@vendor.example>', accountId: 'account',
      folderId: 'inbox', threadId: 'thread-current', fromAddress: sender, toAddress: 'owner@company.example',
      subject: 'Seasonal business software offers', date: now, manualCategories: ['promotions'], tags: '|INBOX|promotions|',
      rawBody: 'Explore our seasonal software offers. This is an unsolicited newsletter. Unsubscribe at any time.', contentType: 'text', hasBody: true });
    const folder = { id: 'inbox', path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' } as FolderRecord;
    const storage = {
      getFolders: async () => [folder], getContacts: async () => [], getAttachments: async () => [],
      getCategoryDefinitions: () => [{ slug: 'promotions' }], getEmail: async () => current,
      getEmailsByThread: async () => [current],
      searchEmails: async (query: SearchQuery) => (query.offset ?? 0) === 0 ? [current] : [],
    };
    const openMailbox = () => Promise.resolve({ storage: storage as never, aliases: [],
      getUnreadReviewBehaviorContext: createUnreadReviewBehaviorContext((senders, timestamp) => agent.getUnreadReviewSenderContextBatch(senders, timestamp), () => now * 1000) });
    const callAI = vi.fn(async (prompt: string) => {
      const line = prompt.split('\n').find(value => value.startsWith('UNTRUSTED_CONVERSATIONS_JSON: '))!;
      const rows = JSON.parse(line.slice('UNTRUSTED_CONVERSATIONS_JSON: '.length)) as Array<{ id: string }>;
      return JSON.stringify({ recommendations: rows.map(row => ({ id: row.id, recommendation: 'mark_read', confidence: 0.98,
        reason: 'Unsolicited advertising from a sender with repeated human deletions.' })) });
    });
    const deps: InboxAssistantActionDeps = { openMailbox, callAI, setRead: vi.fn() };
    const options = { recommendationCache: new InboxAssistantRecommendationCache(), reviewCacheIdentity: 'test-provider' };
    const account = { id: 'account', email: 'owner@company.example' };
    const first = await prepareInboxAssistantReview([account], 'unread', deps, undefined, undefined, options);
    expect(first.items[0]).toMatchObject({ recommendation: 'mark_read', protectedReasons: [] });
    const firstPrompt = callAI.mock.calls[0]![0];
    expect(firstPrompt).toContain('deleted=2');
    expect(firstPrompt).toContain('readThenDeleted90d=1,readThenDeletedFast90d=1,readAndKept90d=1');
    expect(firstPrompt).not.toContain('Historical private subject');
    const cached = await prepareInboxAssistantReview([account], 'unread', deps, undefined, undefined, options);
    expect(cached.coverage[0]!.cachedRecommendations).toBe(1);
    expect(callAI).toHaveBeenCalledTimes(1);

    seed('new6'); log('new6', 'delete', now - 60); db.prepare('DELETE FROM emails WHERE id = ?').run('new6');
    await prepareInboxAssistantReview([account], 'unread', deps, undefined, undefined, options);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(callAI.mock.calls[1]![0]).toContain('deleted=3');
    expect(deps.setRead).not.toHaveBeenCalled();
  });
});
