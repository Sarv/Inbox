import { createHmac, randomBytes } from 'node:crypto';

import { effectiveAIBaseUrl, hasTag, parseAttachmentNames } from '@sarvinbox/core';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import type { InboxAssistantActivity, InboxAssistantAIUsage } from '../../src/types/inbox-assistant';
import { requireAccountStorage, resolveNamedOrActiveAccountTarget } from '../services/account-target';
import { readRegistryAccounts, resolveAccountIdentity } from '../services/accounts-registry';
import { readAssistantAttachment } from '../services/assistant-attachment-reader';
import { changeAssistantReadFlags, changeAssistantStarFlags } from '../services/assistant-mail-actions';
import { changeAssistantMailLocation } from '../services/assistant-mail-moves';
import { fetchAssistantMessageBody } from '../services/assistant-mailbox-download';
import { changeEmailCategory } from '../services/classification-actions';
import { readBlob, setBlob } from '../services/core-db';
import { agentSpamVerdicts, createAgentLabel, dropAgentLabel, labelAgentEmails, revertAgentSpamVerdicts, snoozeAgentEmails } from '../services/inbox-agent-mail-actions';
import { createAgentSettingActions } from '../services/inbox-agent-setting-host';
import { createInboxAgentChangeJournal } from '../services/inbox-assistant-change-journal';
import { buildInboxAssistantDashboard } from '../services/inbox-assistant-dashboard';
import { inboxAssistantHistory } from '../services/inbox-assistant-history';
import { InboxAssistantService } from '../services/inbox-assistant-service';
import { callInboxAssistantAI, callInboxAssistantChat, INBOX_ASSISTANT_SYSTEM_PROMPT } from '../services/inbox-assistant-usage';
import { getLocalCalendarService } from '../services/local-calendar-service';
import { getPipelineAIConfig } from '../services/unified-pipeline-service';
import { getMainWindow } from '../shared';

import { logUserAction } from './agent-handlers';
import { restoreEmailsFromTrash } from './email-handlers';
import { verdictDepsOf } from './spam-handlers';

/** The core-DB blob that holds the Inbox Agent's open change cards. */
const CHANGE_JOURNAL_KEY = 'inbox-agent-change-journal';

/**
 * Keys the provider identity below. Per process and never stored: what it
 * guards (how the agent last managed to call the provider) is memory-only, so
 * the identity only has to stay stable for this run.
 */
const PROVIDER_IDENTITY_KEY = randomBytes(32);

/**
 * The named account's storage and queue for a mail action, checked again
 * before every write: a removed or replaced account must not receive a change
 * prepared for the one it replaced.
 */
async function namedAccountTarget(accountId: string) {
  const assertRegistered = () => {
    if (!readRegistryAccounts().some(account => account.id === accountId)) throw new Error('The account is no longer connected.');
  };
  assertRegistered();
  const storage = await requireAccountStorage(accountId);
  const target = await resolveNamedOrActiveAccountTarget(accountId);
  if (target.storage !== storage) throw new Error('The account changed.');
  return {
    storage, engine: target.syncEngine,
    assertCurrent: async () => {
      assertRegistered();
      if (await requireAccountStorage(accountId) !== storage) throw new Error('The account changed.');
    },
  };
}

type AccountStorage = Awaited<ReturnType<typeof requireAccountStorage>>;

/** Record a flag change the user approved on an agent card in the learning history, as the mail view does. */
function flagLogger(storage: AccountStorage, [onAction, offAction]: ['read', 'unread'] | ['star', 'unstar']) {
  return async (emailId: string, on: boolean) => {
    const email = await storage.getEmail(emailId);
    await logUserAction(emailId, on ? onAction : offAction, {
      source: 'agent_approved', threadId: email?.threadId, senderAddress: email?.fromAddress,
    }, storage);
  };
}

function moveLogger(storage: AccountStorage) {
  return async (emailId: string, action: 'archive' | 'trash' | 'move', destination: string) => {
    const email = await storage.getEmail(emailId);
    await logUserAction(emailId, action === 'trash' ? 'delete' : action, {
      source: 'agent_approved', threadId: email?.threadId, senderAddress: email?.fromAddress,
      actionValue: JSON.stringify({ destination }),
    }, storage);
  };
}

const service = new InboxAssistantService({
  accounts: () => readRegistryAccounts().map(({ id, email, name }) => ({ id, email, name })),
  history: inboxAssistantHistory,
  calendar: {
    preferences: () => getLocalCalendarService().getPreferences(),
    availability: request => getLocalCalendarService().availability(request),
  },
  providerIdentity: () => {
    const config = getPipelineAIConfig();
    const identity = config as (typeof config & { providerId?: string; authMethod?: string; oauthProvider?: string; oauthEmail?: string });
    // The host retains only this opaque digest. Changing provider credentials,
    // model or endpoint makes the agent learn again how to call it, without exposing a key.
    // A change detector, not password storage: it is compared, never verified
    // against a guess, so a slow KDF would only slow every request. Keyed, so
    // the digest cannot confirm a guessed API key (a short custom-endpoint key
    // could otherwise be brute-forced from it) should it ever leave memory.
    return createHmac('sha256', PROVIDER_IDENTITY_KEY).update(JSON.stringify(config ? {
      type: config.type, model: config.model, baseUrl: effectiveAIBaseUrl(config), apiKey: config.apiKey,
      providerId: identity?.providerId, authMethod: identity?.authMethod,
      oauthProvider: identity?.oauthProvider, oauthEmail: identity?.oauthEmail,
    } : null)).digest('hex');
  },
  callAI: async (prompt, signal, onUsage?: (usage: InboxAssistantAIUsage) => void, options?: { maxOutputTokens?: number }) => {
    signal.throwIfAborted();
    const config = getPipelineAIConfig();
    if (!config) throw new Error('Choose an AI provider in AI → Providers before asking the Inbox Agent.');
    const callConfig = options?.maxOutputTokens === undefined ? config : { ...config, maxOutputTokens: options.maxOutputTokens };
    return callInboxAssistantAI(callConfig, INBOX_ASSISTANT_SYSTEM_PROMPT, prompt, signal, onUsage);
  },
  callAIChat: async (request, signal, onUsage) => {
    signal.throwIfAborted();
    const config = getPipelineAIConfig();
    if (!config) throw new Error('Choose an AI provider in AI → Providers before asking the Inbox Agent.');
    return callInboxAssistantChat(config, request, signal, onUsage);
  },
  openMailbox: async accountId => {
    const storage = await requireAccountStorage(accountId);
    return {
      storage, aliases: resolveAccountIdentity(storage).aliases,
      fetchBody: async (email, _folder, options) => {
        // Retrieval has checked completeness; bypass a legacy clean preview
        // rather than letting the download helper treat it as the full body.
        const downloaded = await fetchAssistantMessageBody(accountId, email.id, options?.signal, { force: true });
        if (await requireAccountStorage(accountId) !== storage) throw new Error('The source account changed during download.');
        return downloaded;
      },
    };
  },
  readAttachment: readAssistantAttachment,
  // Open cards survive a restart: one blob in the encrypted core database. A
  // read that fails throws (readBlob), so the journal is then left alone.
  changeJournal: createInboxAgentChangeJournal({
    read: () => readBlob(CHANGE_JOURNAL_KEY)?.toString('utf8') ?? null,
    write: value => setBlob(CHANGE_JOURNAL_KEY, Buffer.from(value, 'utf8')),
  }),
  // The agent's approved setting changes (inbox-assistant-setting-changes.ts):
  // the Filters page's records and the spam filter's own sender lists.
  settingActions: createAgentSettingActions(namedAccountTarget),
  // The agent's approved change sets (inbox-assistant-change-sets.ts), through
  // the durable, receipt-returning mail-action paths.
  mailActions: {
    setRead: async (accountId, emailIds, read) => {
      const target = await namedAccountTarget(accountId);
      return changeAssistantReadFlags({ ...target, onChanged: flagLogger(target.storage, ['read', 'unread']) }, emailIds, read);
    },
    setStarred: async (accountId, emailIds, starred) => {
      const target = await namedAccountTarget(accountId);
      return changeAssistantStarFlags({ ...target, onChanged: flagLogger(target.storage, ['star', 'unstar']) }, emailIds, starred);
    },
    move: async (accountId, emailIds, to) => {
      const target = await namedAccountTarget(accountId);
      return changeAssistantMailLocation({ ...target, onChanged: moveLogger(target.storage) }, emailIds, to);
    },
    restore: async (accountId, emailIds) => {
      const target = await namedAccountTarget(accountId);
      await target.assertCurrent();
      const { restoredIds, failedIds } = await restoreEmailsFromTrash(target.storage, target.engine, emailIds);
      return { appliedIds: restoredIds, queuedIds: [], failedIds };
    },
    setCategory: async (accountId, emailIds, slug, on) => {
      const target = await namedAccountTarget(accountId);
      const receipt = { appliedIds: [] as string[], queuedIds: [] as string[], failedIds: [] as string[] };
      for (const emailId of emailIds) {
        try {
          await target.assertCurrent();
          const before = await target.storage.getEmail(emailId);
          if (!before) { receipt.failedIds.push(emailId); continue; }
          // Already as asked: in no list, as the other receipts report it.
          if (hasTag(before.tags || '||', slug) === on) continue;
          const result = await changeEmailCategory(target.storage, target.engine, emailId, slug, on);
          (result.syncStatus === 'queued' ? receipt.queuedIds : receipt.appliedIds).push(emailId);
          if (slug === 'important') {
            try { await logUserAction(emailId, on ? 'important' : 'unimportant', { source: 'agent_approved', threadId: before.threadId, senderAddress: before.fromAddress }, target.storage); } catch { /* Learning only. */ }
          }
          const after = await target.storage.getEmail(emailId);
          if (after) getMainWindow()?.webContents.send('emails:tags-updated', { emailId, tags: after.tags, accountId });
        } catch { receipt.failedIds.push(emailId); }
      }
      return receipt;
    },
    setLabel: async (accountId, emailIds, name, on) => labelAgentEmails(await agentTarget(accountId), emailIds, name, on),
    createLabel: async (accountId, name) => createAgentLabel(await agentTarget(accountId), name),
    dropLabel: async (accountId, name) => dropAgentLabel(await agentTarget(accountId), name),
    setSnooze: async (accountId, emailIds, until) => snoozeAgentEmails(await agentTarget(accountId), emailIds, until),
    spamVerdict: async (accountId, emailIds, verdict) => {
      const target = await agentTarget(accountId);
      return agentSpamVerdicts(target, verdictDepsOf(target.storage, target.engine), emailIds, verdict, async email => {
        if (verdict === 'spam') await logUserAction(email.id, 'spam', { source: 'agent_approved', threadId: email.threadId, senderAddress: email.fromAddress }, target.storage);
      });
    },
    revertSpamVerdict: async (accountId, rows) => {
      const target = await agentTarget(accountId);
      return revertAgentSpamVerdicts(target, verdictDepsOf(target.storage, target.engine), rows);
    },
  },
});

/** The named account as an agent mail target: checked before every write, and the mail list told of each change. */
async function agentTarget(accountId: string) {
  const target = await namedAccountTarget(accountId);
  return { ...target, onWritten: (emailId: string, tags: string) => getMainWindow()?.webContents.send('emails:tags-updated', { emailId, tags, accountId }) };
}

export function registerInboxAssistantHandlers(): void {
  const register = (channel: string, run: (value: unknown, event: IpcMainInvokeEvent) => unknown) => {
    ipcMain.handle(channel, async (event, value: unknown) => {
      const window = getMainWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        return { success: false, error: 'Inbox Agent requests must come from the main app window.' };
      }
      try { return { success: true, data: await run(value, event) }; }
      catch (error) { return { success: false, error: (error as Error).message || 'Inbox Agent could not complete the request.' }; }
    });
  };
  // A run's activity goes to the requesting app frame only; never broadcast mailbox details.
  const forward = (event: IpcMainInvokeEvent) => (activity: InboxAssistantActivity) => {
    if (getMainWindow()?.webContents === event.sender && !event.sender.isDestroyed()
      && event.senderFrame === event.sender.mainFrame) {
      try { event.sender.send('inboxAssistant:activity', activity); } catch { /* Window closed during the request. */ }
    }
  };
  register('inboxAssistant:accounts', () => service.accounts());
  register('inboxAssistant:dashboard', value => buildInboxAssistantDashboard(value, {
    accounts: () => service.accounts(), storage: requireAccountStorage,
    calendar: { preferences: () => getLocalCalendarService().getPreferences(), snapshot: range => getLocalCalendarService().snapshot(range) },
  }));
  register('inboxAssistant:chats', () => service.chats());
  register('inboxAssistant:chat', value => service.chat(value));
  register('inboxAssistant:createChat', () => service.createChat());
  register('inboxAssistant:renameChat', value => service.renameChat(value));
  register('inboxAssistant:updateChat', value => service.updateChat(value));
  register('inboxAssistant:deleteChat', value => service.deleteChat(value));
  register('inboxAssistant:rewindChat', value => service.rewindChat(value));
  register('inboxAssistant:restoreRewindChat', value => service.restoreRewindChat(value));
  register('inboxAssistant:draftEmail', (value, event) => service.draftEmail(value, forward(event)));
  register('inboxAssistant:history', () => service.history());
  register('inboxAssistant:changeSet', (value, event) => service.decideChangeSet(value, forward(event)));
  register('inboxAssistant:ask', (value, event) => service.ask(value, forward(event)));
  register('inboxAssistant:cancel', value => service.cancel(value));
  register('inboxAssistant:clearHistory', () => { service.clearHistory(); return null; });
  register('inboxAssistant:source', async value => {
    const ref = value as { accountId?: unknown; emailId?: unknown; filename?: unknown } | null;
    if (!ref || typeof ref.accountId !== 'string' || !ref.accountId || ref.accountId.length > 500
      || typeof ref.emailId !== 'string' || !ref.emailId || ref.emailId.length > 500
      || (ref.filename !== undefined && (typeof ref.filename !== 'string' || !ref.filename || ref.filename.length > 1024))) {
      throw new Error('Invalid source reference.');
    }
    if (!readRegistryAccounts().some(account => account.id === ref.accountId)) throw new Error('The source account is no longer connected.');
    const storage = await requireAccountStorage(ref.accountId);
    const email = await storage.getEmail(ref.emailId);
    if (!email) throw new Error('This source is no longer available in its original account.');
    if (ref.filename) {
      const names = parseAttachmentNames(email.attachmentNames);
      const attachments = await storage.getAttachments(email.id);
      if (!names.includes(ref.filename) && !attachments.some(item => item.filename === ref.filename)) {
        throw new Error('This attachment is no longer available on the source message.');
      }
    }
    if (!readRegistryAccounts().some(account => account.id === ref.accountId) || await requireAccountStorage(ref.accountId) !== storage) {
      throw new Error('The source account is no longer connected.');
    }
    return { emailId: email.id, threadId: email.threadId || email.id, filename: ref.filename };
  });
}
