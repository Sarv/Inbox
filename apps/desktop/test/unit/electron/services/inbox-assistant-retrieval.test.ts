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
    getEmailsByThread: vi.fn(async (threadId: string) => records.filter(email => email.threadId === threadId)),
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
  it('reads a complete HTML quotation when the persisted clean body is a legacy preview', async () => {
    const preview = 'Dear customer, please find our User Directory licensing proposal for your existing deployment. '.repeat(2).slice(0, 181);
    const primary = mailbox([sentEmail('full-html', {
      cleanBody: preview,
      rawBody: `<p>${preview}</p><p>The total commercial value is ₹7.25 Cr.</p>`,
    })]);
    const fetchBody = vi.fn();
    primary.fetchBody = fetchBody;
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment: vi.fn() });
    expect(result.evidence.find(source => source.emailId === 'full-html')?.text).toContain('₹7.25 Cr');
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it.each(['', ' \n '])('downloads a nonempty preview when the original body is absent (%j)', async rawBody => {
    let current = sentEmail('preview-only', { cleanBody: 'TCS proposal preview', rawBody, hasBody: false });
    const primary = mailbox([current]);
    vi.mocked(primary.storage.getEmail).mockImplementation(async () => current);
    primary.fetchBody = vi.fn(async () => {
      current = { ...current, rawBody: '<p>TCS complete proposal total INR 82,000.</p>', hasBody: true };
      return current;
    });
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment: vi.fn() });
    expect(primary.fetchBody).toHaveBeenCalledOnce();
    expect(result.evidence[0]?.text).toContain('INR 82,000');
  });

  it('reports an unavailable original instead of calling a retained preview complete', async () => {
    const primary = mailbox([sentEmail('offline-preview', { cleanBody: 'TCS proposal preview', rawBody: '', hasBody: false })]);
    primary.fetchBody = vi.fn(async () => { throw new Error('offline'); });
    const activities: InboxAssistantProgress[] = [];
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment: vi.fn() }, undefined, { onProgress: value => activities.push(value) });
    expect(result.coverage[0]?.missingBodies).toBe(1);
    expect(result.evidence[0]?.text).toContain('only a preview');
    expect(activities.some(value => value.stage === 'body' && value.status === 'done')).toBe(false);
  });

  it('does not download input tender files or incidental acronym matches while finding an outgoing quotation', async () => {
    const primary = mailbox([
      sentEmail('offer', { cleanBody: 'TCS final offer total INR 90,000.' }),
      sentEmail('input-rfp', { subject: 'TCS project opportunity', cleanBody: 'Please review the incoming tender.', attachmentNames: '["Tender Document.pdf"]' }),
      sentEmail('bank-notice', { subject: 'Credit report notification', toAddress: 'private@example.com', cleanBody: 'An incidental TCS reference in the report.', rawBody: '', attachmentNames: '["883059_signed.pdf"]' }),
    ]);
    const readAttachment = vi.fn();
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment });
    expect(result.evidence.some(source => source.emailId === 'offer' && source.text.includes('INR 90,000'))).toBe(true);
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it('expands a relevant thread to team replies without allowing unrelated people or excluded messages to crowd them out', async () => {
    const seed = sentEmail('demo', { subject: 'EPFO demo coordination', threadId: 'epfo-thread', cleanBody: 'Prakash will handle the project.' });
    const reply = sentEmail('team-response', {
      subject: 'Technical response', threadId: 'epfo-thread', fromAddress: 'prakash@sarv.example',
      fromName: 'Prakash', toAddress: 'buyer@infosys.example', folderId: 'f-inbox', tags: '|INBOX|',
      cleanBody: 'Attached technical response', rawBody: '<p>Technical response: GPU sizing and deployment are provided.</p>', date: seed.date + 1,
    });
    const trash = { ...reply, id: 'trashed-team-response', tags: '|Trash|' };
    const unrelated = Array.from({ length: 30 }, (_, index) => ({ ...reply, id: `other-${index}`, threadId: `other-${index}`, subject: 'Other customer proposal', rawBody: '', cleanBody: 'Please review another tender.', date: seed.date + 10 + index }));
    const primary = mailbox([seed, reply, trash, ...unrelated]);
    const plan: InboxAssistantSearchPlan = { queries: ['proposal', 'Prakash'], entityTerms: ['Prakash'], topicTerms: ['EPFO'], participantTerms: ['Prakash'], intent: 'all', quoteIntent: true, filters: {} };
    const result = await researchInboxAssistant([ACCOUNTS[0]!], plan, { openMailbox: vi.fn(async () => primary), readAttachment: vi.fn() });
    expect(result.evidence.some(source => source.emailId === reply.id && source.text.includes('GPU sizing'))).toBe(true);
    expect(result.evidence.some(source => source.emailId === trash.id || source.emailId.startsWith('other-'))).toBe(false);
    expect(primary.storage.getEmailsByThread).toHaveBeenCalledWith('epfo-thread');
    const strict = await researchInboxAssistant([ACCOUNTS[0]!], { ...plan, intent: 'sent' }, { openMailbox: vi.fn(async () => primary), readAttachment: vi.fn() });
    expect(strict.evidence.some(source => source.emailId === reply.id)).toBe(false);
  });

  it('preserves forwarded commercial history and CC recipients as explicitly attributed evidence', async () => {
    const primary = mailbox([sentEmail('forward', {
      cleanBody: 'Forwarded message', ccAddress: 'buyer@tcs.example',
      rawBody: '<p>Forwarded message</p><p>From: Prakash</p><p>Date: August 6, 2026</p><p>Please find the updated TCS price bid attached.</p>',
    })]);
    const result = await researchInboxAssistant([ACCOUNTS[0]!], PLAN, { openMailbox: vi.fn(async () => primary), readAttachment: vi.fn() });
    expect(result.evidence[0]?.text).toContain('From: Prakash');
    expect(result.evidence[0]?.text).toContain('August 6, 2026');
    expect(result.evidence[0]?.text).toContain('CC: buyer@tcs.example');
  });

  it('retains a useful contiguous latest reply in a crowded account alongside older forwarded proposals', async () => {
    const responseLead = `${'Deployment sizing details. '.repeat(36)}For 50 concurrent sessions use MXFP4.\n\n`;
    const response = `${responseLead}${'Further capacity explanation. '.repeat(72)}Deploy four GPU servers for recovery capacity.\n\n`;
    const rows = Array.from({ length: 24 }, (_, index) => sentEmail(`project-${index}`, {
      subject: index === 2 ? 'Re: ProjectX technical response' : 'ProjectX proposal discussion',
      fromAddress: 'prakash@sarv.example', fromName: 'Prakash', folderId: 'inbox', tags: '|INBOX|',
      date: Date.parse('2026-10-13T12:00:00Z') / 1000 - index * 86400,
      cleanBody: 'ProjectX correspondence preview',
      rawBody: index === 2 ? `${response}On Tuesday, Buyer wrote:\n${'Older ProjectX proposal history. '.repeat(300)}` : 'ProjectX correspondence.',
      contentType: 'text', attachmentNames: index < 4 ? '["ProjectX-proposal.pdf"]' : null,
    }));
    const primary = mailbox(rows);
    const accounts = [...ACCOUNTS, { id: 'third', email: 'other@example.com' }];
    const plan: InboxAssistantSearchPlan = {
      queries: ['ProjectX'], entityTerms: ['ProjectX', 'Prakash'], topicTerms: ['ProjectX'], participantTerms: ['Prakash'],
      intent: 'all', quoteIntent: true, filters: {},
    };
    const result = await researchInboxAssistant(accounts, plan, {
      openMailbox: vi.fn(async id => id === 'primary' ? primary : mailbox([])),
      readAttachment: vi.fn(async ref => ({ ref, status: 'unavailable' as const, segments: [], truncated: false })),
    });
    const direct = result.evidence.find(source => source.emailId === 'project-2');
    expect(direct?.text).toContain(responseLead.trim());
    expect(direct?.text).toContain('Deploy four GPU servers for recovery capacity.');
    expect(direct?.from).toBe('prakash@sarv.example');
    expect(direct?.date).toBe(rows[2]!.date);
    expect(result.coverage[0]?.reviewedMessages).toBe(24);
    expect(result.evidence.filter(source => source.accountId === 'primary').reduce((sum, source) => sum + source.text.length, 0)).toBeLessThanOrEqual(Math.floor(110_000 / 3));
  });
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

  it('does not spend the network budget while the user is deciding an attachment security prompt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const primary = mailbox([sentEmail('approval-wait', { attachmentNames: '["TCS-final.pdf"]' })]);
      const readAttachment = vi.fn(async (ref, options): Promise<AssistantAttachmentResult> => {
        options.onApprovalWait(true);
        await new Promise(resolve => setTimeout(resolve, 100_000));
        options.onApprovalWait(false);
        return ready(ref, 'TCS final offer INR 82,000.');
      });
      const result = researchInboxAssistant([...ACCOUNTS, { id: 'third', email: 'third@example.com' }], PLAN, {
        openMailbox: vi.fn(async id => id === 'primary' ? primary : mailbox([])), readAttachment,
      });
      await vi.waitFor(() => expect(readAttachment).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(100_000);
      expect((await result).coverage[0]).toMatchObject({ attachmentsRead: 1, attachmentsSkipped: 0 });
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
    expect(result.coverage[0]).toMatchObject({ matchedMessages: 1, reviewedMessages: 1 });
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

  it('keeps a workbook total together with dummy-volume and actual-payment qualifications under a busy account budget', async () => {
    const busy = mailbox(Array.from({ length: 24 }, (_, index) => sentEmail(`project-${index}`, {
      date: 1_791_000_100 - index, cleanBody: 'TCS proposal and project update.',
      hasAttachments: index % 6 === 0, attachmentNames: index % 6 === 0 ? `["TCS-pricing-${index}.xlsx"]` : null,
    })));
    const segments: AssistantAttachmentResult['segments'] = [
      ...Array.from({ length: 100 }, (_, index) => ({ text: `INR component ${index} details ${'detail '.repeat(100)}`, locator: { kind: 'sheet' as const, label: `Costs!A${index + 1}:B${index + 1}`, sheet: 'Costs' } })),
      { text: 'A17: Total Bid Value including GST | B17: INR 90,000 (saved formula value)', locator: { kind: 'sheet', label: 'Cost Summary!A17:B17', sheet: 'Cost Summary' } },
      { text: 'A14: Seat quantities are dummy evaluation inputs.', locator: { kind: 'sheet', label: 'Call Centre!A14', sheet: 'Call Centre' } },
      { text: 'C9: Actual effort determines payment; this evaluation figure is not the total contract value.', locator: { kind: 'sheet', label: 'Read Me!C9', sheet: 'Read Me' } },
    ];
    const result = await researchInboxAssistant([...ACCOUNTS, { id: 'third', email: 'other@example.com' }], PLAN, {
      openMailbox: vi.fn(async id => id === 'primary' ? busy : mailbox([])),
      readAttachment: vi.fn(async (ref): Promise<AssistantAttachmentResult> => ({ ref, status: 'ready', truncated: false, segments, message: 'Saved values; formulas were not recalculated.' })),
    });
    const selected = result.evidence.filter(source => source.filename === 'TCS-pricing-0.xlsx');
    const text = selected.map(source => source.text).join('\n');
    expect(text).toContain('INR 90,000');
    expect(text).toContain('dummy evaluation inputs');
    expect(text).toContain('Actual effort determines payment');
    expect(result.coverage[0]?.warnings.join(' ')).toContain('formulas were not recalculated');
    expect(selected.reduce((sum, source) => sum + source.text.length, 0)).toBeLessThanOrEqual(4_000);
  });
});
