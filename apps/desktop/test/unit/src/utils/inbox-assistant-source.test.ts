import { describe, expect, it, vi } from 'vitest';

import type { InboxAssistantAPI } from '../../../../src/types/inbox-assistant';
import { resolveInboxAssistantSource } from '../../../../src/utils/inbox-assistant-source';

const source = { accountId: 'sales-account', emailId: 'shared-email-id', filename: 'TCS-quotation.pdf' };
type SourceAPI = Pick<InboxAssistantAPI, 'source'>;

describe('Inbox Agent source navigation', () => {
  it('resolves the cited account, sent-message thread and exact attachment without using the visible mailbox', async () => {
    const api: SourceAPI = { source: vi.fn(async () => ({ success: true as const, data: { emailId: source.emailId, threadId: 'sent-quote-thread', filename: source.filename } })) };
    expect(await resolveInboxAssistantSource(source, api)).toEqual({ accountId: 'sales-account', emailId: 'shared-email-id', threadId: 'sent-quote-thread', filename: 'TCS-quotation.pdf' });
    expect(api.source).toHaveBeenCalledExactlyOnceWith(source);
  });

  it('resolves a message-only source without inventing an attachment name', async () => {
    const api: SourceAPI = { source: vi.fn(async () => ({ success: true as const, data: { emailId: source.emailId, threadId: 'sent-quote-thread' } })) };
    const target = await resolveInboxAssistantSource({ accountId: source.accountId, emailId: source.emailId }, api);
    expect(api.source).toHaveBeenCalledWith({ accountId: source.accountId, emailId: source.emailId, filename: undefined });
    expect(target).toEqual({ accountId: source.accountId, emailId: source.emailId, threadId: 'sent-quote-thread' });
  });

  it.each([
    { emailId: 'another-email', threadId: 'sent-quote-thread', filename: source.filename },
    { emailId: source.emailId, threadId: '', filename: source.filename },
    { emailId: source.emailId, threadId: 'sent-quote-thread', filename: 'another-file.pdf' },
    { emailId: source.emailId, threadId: 'sent-quote-thread' },
  ])('rejects a resolved target that no longer matches the citation: %j', async data => {
    const api: SourceAPI = { source: vi.fn(async () => ({ success: true as const, data })) };
    await expect(resolveInboxAssistantSource(source, api)).rejects.toThrow('no longer matches the original message');
  });

  it('surfaces source-account or attachment availability errors for the user', async () => {
    const api: SourceAPI = { source: vi.fn(async () => ({ success: false as const, error: 'This source is no longer available in its original account.' })) };
    await expect(resolveInboxAssistantSource(source, api)).rejects.toThrow('no longer available in its original account');
    expect(api.source).toHaveBeenCalledOnce();
  });
});
