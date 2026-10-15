import type { InboxAssistantAPI, InboxAssistantSource } from '../types/inbox-assistant';

export interface InboxAssistantSourceTarget {
  accountId: string;
  emailId: string;
  threadId: string;
  filename?: string;
}

/** Resolve against the owner in main; never guess from the visible inbox list. */
export async function resolveInboxAssistantSource(
  source: Pick<InboxAssistantSource, 'accountId' | 'emailId' | 'filename'>,
  api: Pick<InboxAssistantAPI, 'source'> = window.electronAPI.inboxAssistant,
): Promise<InboxAssistantSourceTarget> {
  const result = await api.source({ accountId: source.accountId, emailId: source.emailId, filename: source.filename });
  if (!result.success) throw new Error(result.error);
  if (result.data.emailId !== source.emailId || !result.data.threadId || result.data.filename !== source.filename) {
    throw new Error('This source no longer matches the original message.');
  }
  return { ...result.data, accountId: source.accountId };
}
