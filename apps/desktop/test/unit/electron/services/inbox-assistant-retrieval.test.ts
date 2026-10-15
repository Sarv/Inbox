import type { EmailRecord, FolderRecord, SearchQuery } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import type { AssistantAttachmentRef, AssistantAttachmentResult } from '../../../../electron/services/assistant-attachment-types';
import type { InboxAssistantSearchPlan } from '../../../../electron/services/inbox-assistant-answer';
import { researchInboxAssistant, type AssistantResearchMailbox, type AssistantResearchStorage } from '../../../../electron/services/inbox-assistant-retrieval';
import type { InboxAssistantAccount, InboxAssistantProgress } from '../../../../src/types/inbox-assistant';
import { emailRecord } from '../../../helpers/email-fixtures';

const ACCOUNTS: InboxAssistantAccount[] = [
  { id: 'primary', email: 'rc@sarv.example' },
  { id: 'secondary', email: 'sales@sarv.example' },
];
const PLAN: InboxAssistantSearchPlan = {
  queries: ['TCS', 'quotation'], entityTerms: ['TCS'], intent: 'sent', quoteIntent: true, filters: {},
};
const SENT: FolderRecord = {
  id: 'f-sent', name: 'Sent', path: 'Sent', specialUse: '\\Sent', parentId: null, uidValidity: 1,
  lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, subscribed: true, createdAt: 0, updatedAt: 0,
};

function sentEmail(id: string, overrides: Partial<EmailRecord> = {}): EmailRecord {
  return emailRecord({
    id, threadId: `t-${id}`, folderId: SENT.id, tags: '|Sent|', fromAddress: ACCOUNTS[0]!.email,
    toAddress: 'buyer@tcs.example', subject: 'TCS quotation', date: 1_791_600_000,
    cleanBody: 'TCS quotation total INR 90,000.', rawBody: '<p>TCS quotation total INR 90,000.</p>', ...overrides,
  });
}

/** SQL scope is covered by real migrated repository/service tests; this isolates bounded research ordering. */
function mailbox(records: EmailRecord[]): AssistantResearchMailbox {
  const byId = new Map(records.map(email => [email.id, email]));
  const storage: AssistantResearchStorage = {
    getFolders: vi.fn(async () => [SENT]),
    getContacts: vi.fn(async () => []),
    getEmail: vi.fn(async (id: string) => byId.get(id) ?? null),
    getAttachments: vi.fn(async () => []),
    searchEmails: vi.fn(async (request: SearchQuery) => records.filter(email => {
      const text = `${email.subject} ${email.cleanBody} ${email.fromAddress} ${email.toAddress} ${email.attachmentNames ?? ''}`.toLowerCase();
      return (!request.query || text.includes(request.query.toLowerCase()))
        && (!request.folderPath || email.tags.includes(`|${request.folderPath}|`))
        && (!request.from || email.fromAddress.includes(request.from))
        && (!request.to || email.toAddress?.includes(request.to));
    }).sort((a, b) => b.date - a.date).slice(0, request.limit)),
  };
  return { storage, aliases: [] };
}

function ready(ref: AssistantAttachmentRef, text = 'TCS quotation total INR 90,000.'): AssistantAttachmentResult {
  return { ref, status: 'ready', truncated: false, segments: [{ text, locator: { kind: 'page', label: 'page 1', page: 1 } }] };
}

describe('Inbox Agent bounded retrieval priorities', () => {
  it('automatically downloads missing bodies, refreshes discovered attachments and reports real work', async () => {
    let current = sentEmail('headers-only', { cleanBody: '', rawBody: '', attachmentNames: null });
    const primary = mailbox([current]);
    vi.mocked(primary.storage.getEmail).mockImplementation(async () => current);
    const fetchBody = vi.fn(async (_email, _folder, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      current = { ...current, cleanBody: 'The latest TCS quote is attached.', rawBody: '<p>Attached</p>', attachmentNames: '["TCS-final.pdf"]' };
      return current;
    });
    primary.fetchBody = fetchBody;
    const activities: InboxAssistantProgress[] = [];
    const readAttachment = vi.fn(async ref => ready(ref, 'Final quotation INR 82,000.'));
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment }, undefined, { onProgress: activity => activities.push(activity) });
    expect(fetchBody).toHaveBeenCalledOnce();
    expect(result.coverage[0]).toMatchObject({ missingBodies: 0, attachmentsRead: 1 });
    expect(result.evidence.some(source => source.kind === 'attachment' && source.filename === 'TCS-final.pdf')).toBe(true);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'search', status: 'running', accountId: 'primary' }),
      expect.objectContaining({ stage: 'body', status: 'running', message: 'Downloading missing email content' }),
      expect.objectContaining({ stage: 'body', status: 'done', message: 'Email content ready' }),
      expect.objectContaining({ stage: 'attachment', status: 'done', filename: 'TCS-final.pdf' }),
    ]));
  });

  it('waits for a queued download that takes longer than the old twelve-second cutoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let current = sentEmail('slow-body', { cleanBody: '', rawBody: '' });
      const primary = mailbox([current]);
      vi.mocked(primary.storage.getEmail).mockImplementation(async () => current);
      primary.fetchBody = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 15_000));
        current = { ...current, cleanBody: 'TCS quotation INR 82,000.' };
        return current;
      });
      const result = researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment: vi.fn(async ref => ready(ref)) });
      await vi.waitFor(() => expect(primary.fetchBody).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await result).coverage[0]?.missingBodies).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('reopens prior cited messages and their attachments for a vague follow-up within account scope', async () => {
    const previous = sentEmail('earlier-source', { subject: 'Annual service', cleanBody: 'Please find the file attached.', attachmentNames: '["final.pdf"]' });
    const primary = mailbox([previous]);
    const vague = { ...PLAN, queries: ['read attached document'], entityTerms: [], intent: 'all' as const };
    const readAttachment = vi.fn(async ref => ready(ref, 'TCS FINAL-104 INR 82,000.'));
    const result = await researchInboxAssistant([ACCOUNTS[0]!], vague, { openMailbox: vi.fn(async () => primary), readAttachment }, undefined, {
      sourceRefs: [{ accountId: 'primary', emailId: previous.id }, { accountId: 'secondary', emailId: 'must-not-open' }],
    });
    expect(result.evidence.some(source => source.emailId === previous.id && source.kind === 'attachment')).toBe(true);
    expect(primary.storage.getEmail).not.toHaveBeenCalledWith('must-not-open');
    expect(readAttachment).toHaveBeenCalledOnce();
  });

  it('keeps pinned context within new date, recipient and attachment filters', async () => {
    const previous = sentEmail('old-source', { date: Date.parse('2025-09-01T12:00:00Z') / 1000 });
    const primary = mailbox([previous]);
    const filtered = { ...PLAN, queries: ['read document'], entityTerms: [], filters: { after: '2026-10-01', to: 'someone@other.example', hasAttachment: true } };
    const readAttachment = vi.fn(async ref => ready(ref));
    const result = await researchInboxAssistant([ACCOUNTS[0]!], filtered, { openMailbox: vi.fn(async () => primary), readAttachment }, undefined, {
      sourceRefs: [{ accountId: 'primary', emailId: previous.id }],
    });
    expect(result.evidence).toEqual([]);
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it('discards a message moved into Trash while the body is downloading', async () => {
    let current = sentEmail('moved-source', { cleanBody: '', rawBody: '', attachmentNames: '["quote.pdf"]' });
    const primary = mailbox([current]);
    vi.mocked(primary.storage.getEmail).mockImplementation(async () => current);
    primary.fetchBody = vi.fn(async () => {
      current = { ...current, cleanBody: 'TCS quotation INR 80,000', tags: '|Trash|' };
      return current;
    });
    const readAttachment = vi.fn(async ref => ready(ref));
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment });
    expect(result.evidence).toEqual([]);
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it('cancels a pending body download without reading attachments or reporting a stale answer', async () => {
    const header = sentEmail('cancel-body', { cleanBody: '', rawBody: '', attachmentNames: '["quote.pdf"]' });
    const primary = mailbox([header]);
    primary.fetchBody = vi.fn(() => new Promise<EmailRecord | null>(() => {}));
    const readAttachment = vi.fn(async ref => ready(ref));
    const controller = new AbortController();
    const result = researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment }, controller.signal);
    await vi.waitFor(() => expect(primary.fetchBody).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).rejects.toThrow('Search cancelled');
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it('continues to a healthy account after one account exhausts its shared download budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const stalled = mailbox([
        sentEmail('stalled-one', { cleanBody: '', rawBody: '' }),
        sentEmail('stalled-two', { cleanBody: '', rawBody: '' }),
      ]);
      stalled.fetchBody = vi.fn(() => new Promise<EmailRecord | null>(() => {}));
      const healthy = mailbox([sentEmail('healthy-quote', { fromAddress: ACCOUNTS[1]!.email, cleanBody: 'TCS supported quotation Q-104 total INR 80,000.' })]);
      const result = researchInboxAssistant(ACCOUNTS, PLAN, {
        openMailbox: vi.fn(async id => id === 'primary' ? stalled : healthy), readAttachment: vi.fn(async ref => ready(ref)),
      });
      await vi.waitFor(() => expect(stalled.fetchBody).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(120_000);
      const researched = await result;
      expect(stalled.fetchBody).toHaveBeenCalledOnce();
      expect(researched.evidence.some(source => source.accountId === 'secondary' && source.text.includes('Q-104'))).toBe(true);
      expect(researched.coverage[0]).toMatchObject({ truncated: true, missingBodies: 2 });
      expect(researched.coverage[0]?.warnings.join(' ')).toContain('download time limit');
      expect(researched.coverage[1]).toMatchObject({ status: 'searched', reviewedMessages: 1, missingBodies: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('reads legacy comma-separated attachment metadata using the shared filename parser', async () => {
    const filename = 'TCS-quotation.pdf';
    const primary = mailbox([sentEmail('legacy', { attachmentNames: `logo.png, ${filename}`, hasAttachments: true })]);
    const readAttachment = vi.fn(async ref => ready(ref));
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment });
    expect(readAttachment).toHaveBeenCalledExactlyOnceWith({ accountId: 'primary', emailId: 'legacy', filename }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.evidence.some(source => source.filename === filename)).toBe(true);
  });
  it('retains an older matching TCS sent quote when generic quotation queries return 25 newer unrelated quotes', async () => {
    const target = sentEmail('old-tcs', { date: 1_790_000_000, cleanBody: 'TCS quotation Q-104 total INR 90,000.' });
    const unrelated = Array.from({ length: 25 }, (_, index) => sentEmail(`new-acme-${index}`, {
      subject: `Acme quotation ${index}`, toAddress: 'buyer@acme.example', date: 1_791_000_000 + index,
      cleanBody: 'Acme quotation total INR 10,000.', rawBody: '<p>Acme quotation</p>',
    }));
    const primary = mailbox([target, ...unrelated]);
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, {
      openMailbox: vi.fn(async () => primary), readAttachment: vi.fn(async ref => ready(ref)),
    });
    expect(result.evidence.some(source => source.emailId === 'old-tcs' && source.text.includes('Q-104'))).toBe(true);
    expect(result.evidence[0]?.emailId).toBe('old-tcs');
    expect(result.coverage[0]).toMatchObject({ matchedMessages: 26, reviewedMessages: 24, truncated: true });
  });

  it('extracts a quotation PDF after six inline logos without spending document slots on images', async () => {
    const filename = 'TCS-quotation.pdf';
    const logos = Array.from({ length: 6 }, (_, index) => `signature-logo-${index}.png`);
    const primary = mailbox([sentEmail('quote-with-logos', {
      hasAttachments: true, attachmentCount: 7, attachmentNames: JSON.stringify([...logos, filename]),
      cleanBody: 'Our TCS quotation is attached.',
    })]);
    const readAttachment = vi.fn(async (ref: AssistantAttachmentRef) => ready(ref));
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, {
      openMailbox: vi.fn(async () => primary), readAttachment,
    });
    expect(readAttachment).toHaveBeenCalledExactlyOnceWith({ accountId: 'primary', emailId: 'quote-with-logos', filename }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment', emailId: 'quote-with-logos', filename, location: 'page 1' }),
    ]));
    expect(result.coverage[0]).toMatchObject({ attachmentsRead: 1, attachmentsSkipped: 6 });
  });

  it('reserves both document extraction and text budget for a second account when the first is busy', async () => {
    const firstFiles = Array.from({ length: 12 }, (_, index) => `TCS-pricing-${index}.pdf`);
    const busy = mailbox(Array.from({ length: 15 }, (_, index) => sentEmail(`busy-${index}`, {
      date: 1_791_000_100 - index, cleanBody: `TCS quotation ${'Details '.repeat(2_000)}`,
      hasAttachments: index === 0, attachmentNames: index === 0 ? JSON.stringify(firstFiles) : null,
    })));
    const secondary = mailbox([sentEmail('second-account-quote', {
      fromAddress: ACCOUNTS[1]!.email, cleanBody: 'Please review the attached TCS quotation.',
      hasAttachments: true, attachmentNames: JSON.stringify(['TCS-final-quote.pdf']),
    })]);
    const readAttachment = vi.fn(async (ref: AssistantAttachmentRef) => ready(ref,
      ref.accountId === 'secondary' ? 'TCS final quotation reference FINAL-104 total INR 80,000.' : `TCS quotation ${'Price details '.repeat(80)}`));
    const result = await researchInboxAssistant(ACCOUNTS, PLAN, {
      openMailbox: vi.fn(async accountId => accountId === 'primary' ? busy : secondary), readAttachment,
    });
    expect(readAttachment.mock.calls.filter(([ref]) => ref.accountId === 'primary')).toHaveLength(6);
    expect(readAttachment.mock.calls.filter(([ref]) => ref.accountId === 'secondary')).toHaveLength(1);
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment', accountId: 'secondary', emailId: 'second-account-quote', filename: 'TCS-final-quote.pdf', text: expect.stringContaining('FINAL-104') }),
    ]));
    expect(result.coverage).toEqual([
      expect.objectContaining({ accountId: 'primary', truncated: true, attachmentsRead: 6 }),
      expect.objectContaining({ accountId: 'secondary', status: 'searched', reviewedMessages: 1, attachmentsRead: 1 }),
    ]);
    const firstText = result.evidence.filter(source => source.accountId === 'primary').reduce((sum, source) => sum + source.text.length, 0);
    expect(firstText).toBeLessThanOrEqual(55_000);
  });
});
