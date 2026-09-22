// Electron preload script - exposes safe IPC methods to renderer

// Sets up the internal IPC bridge the renderer-process Sentry SDK uses to send
// events to the main process. Required because the renderer runs with
// contextIsolation enabled; must be imported for its side effects in every
// preload script. Safe/no-op when Sentry has no DSN configured.
import '@sentry/electron/preload';

import type { IMAPConfig, SyncEngineOptions, SyncStatus, RealtimeEvent, SMTPConfig, SendEmailOptions, FilterRule, FilterRuleInput, FilterCondition, Label, LabelInput, EmailRecord, ViewFilter , SpamUserVerdict, AvailablePanel, PanelResponse } from '@sarvinbox/core';
import { contextBridge, ipcRenderer } from 'electron';

import type { DomainIdentityRow } from './services/domain-identity-store';
import type { SenderIdentity, SenderIdentityPolicy } from './services/sender-identity-service';
import type { SpamReputationPolicy, SpamReputationState } from './services/spam-reputation-service';

/**
 * A toast mirrored into the renderer when native OS notifications can't be
 * shown (dev, or a platform with no notification daemon). Mirrors the payload
 * built by notification-service's sendInApp().
 */
interface InAppToast {
  id: string;
  title: string;
  body: string;
  subtitle?: string;
  accountId?: string;
  emailId?: string;
}

/** Per-account secrets kept in the main-process vault (never renderer disk). */
interface SecureAccountSecrets {
  imap?: { password?: string; accessToken?: string; refreshToken?: string };
  smtp?: { password?: string; accessToken?: string; refreshToken?: string };
}

/**
 * The persisted (non-secret) account shape exchanged with the durable accounts
 * registry. Mirrors the renderer's `StoredAccount`; secrets are always stripped
 * before crossing this boundary (main strips again defensively).
 */
interface RegistryAccountDTO {
  id: string;
  email: string;
  name?: string;
  imapConfig: Record<string, any> | null;
  smtpConfig: Record<string, any> | null;
  smtpConfigured: boolean;
  color?: string;
  includeInUnified?: boolean;
  backgroundSync?: boolean;
  notify?: boolean;
}

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  },

  // System power-state events from Electron's powerMonitor.
  // Used by the renderer to gate IMAP reconnects: after a resume or
  // unlock, network reattach (DHCP + DNS) takes 1-3 seconds, so the
  // renderer waits before triggering a reconnect to avoid burning
  // through the connection manager's retry cap on ENOTFOUND errors.
  system: {
    onSuspend: (callback: () => void) => {
      ipcRenderer.on('system:suspend', () => callback());
    },
    onResume: (callback: () => void) => {
      ipcRenderer.on('system:resume', () => callback());
    },
    onLock: (callback: () => void) => {
      ipcRenderer.on('system:lock', () => callback());
    },
    onUnlock: (callback: () => void) => {
      ipcRenderer.on('system:unlock', () => callback());
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('system:suspend');
      ipcRenderer.removeAllListeners('system:resume');
      ipcRenderer.removeAllListeners('system:lock');
      ipcRenderer.removeAllListeners('system:unlock');
    },
  },

  // IMAP operations
  imap: {
    connect: (config: IMAPConfig, accountId?: string) => ipcRenderer.invoke('imap:connect', config, accountId),
    probeCredentials: (config: IMAPConfig) => ipcRenderer.invoke('imap:probeCredentials', config),
    disconnect: () => ipcRenderer.invoke('imap:disconnect'),
    getSavedConfig: () => ipcRenderer.invoke('imap:getSavedConfig'),
    clearSavedConfig: () => ipcRenderer.invoke('imap:clearSavedConfig'),
    sync: (options?: SyncEngineOptions) => ipcRenderer.invoke('imap:sync', options),
    backfillChunk: (folderPath: string) => ipcRenderer.invoke('imap:backfillChunk', folderPath),
    stopSync: () => ipcRenderer.invoke('imap:stopSync'),
    getStatus: () => ipcRenderer.invoke('imap:status'),
    isConnected: () => ipcRenderer.invoke('imap:isConnected'),
    ensureConnection: () => ipcRenderer.invoke('imap:ensureConnection'),
    resetAndReconnect: () => ipcRenderer.invoke('imap:resetAndReconnect'),
    onSyncProgress: (callback: (status: SyncStatus) => void) => {
      ipcRenderer.on('sync:progress', (_event, status) => callback(status));
    },
    removeSyncProgressListener: () => {
      ipcRenderer.removeAllListeners('sync:progress');
    },
    // IDLE (real-time updates)
    startIdle: (folderPath: string) => ipcRenderer.invoke('imap:startIdle', folderPath),
    stopIdle: () => ipcRenderer.invoke('imap:stopIdle'),
    isIdleActive: () => ipcRenderer.invoke('imap:isIdleActive'),
    refreshFlags: (folderPath: string) => ipcRenderer.invoke('imap:refreshFlags', folderPath),
    onRealtimeEvent: (callback: (event: RealtimeEvent) => void) => {
      ipcRenderer.on('idle:event', (_event, idleEvent) => callback(idleEvent));
    },
    removeRealtimeEventListener: () => {
      ipcRenderer.removeAllListeners('idle:event');
    },
    // Coalesced "folder counts changed" signal from the main-process background
    // schedulers (backfill / gap-drain), which insert mail WITHOUT per-email IDLE
    // events. Lets the sidebar unread badge update live during a download instead
    // of only on the next user-driven folders reload.
    // `folderPath`, when present, means main reconciled THAT folder's flags
    // against the server (the non-INBOX sweep — IDLE watches INBOX only), so the
    // renderer must re-run its list query too, not just reload the badges.
    onFoldersUpdated: (callback: (info: { accountId?: string; folderPath?: string }) => void) => {
      const handler = (_event: unknown, info: { accountId?: string; folderPath?: string }) => callback(info);
      ipcRenderer.on('folders:updated', handler);
      return () => ipcRenderer.removeListener('folders:updated', handler);
    },
    removeFoldersUpdatedListener: () => {
      ipcRenderer.removeAllListeners('folders:updated');
    },
    onDisconnected: (callback: () => void) => {
      ipcRenderer.on('imap:disconnected', () => callback());
    },
    removeDisconnectedListener: () => {
      ipcRenderer.removeAllListeners('imap:disconnected');
    },
    onReconnected: (callback: () => void) => {
      ipcRenderer.on('imap:reconnected', () => callback());
    },
    removeReconnectedListener: () => {
      ipcRenderer.removeAllListeners('imap:reconnected');
    },
    onReconnecting: (callback: () => void) => {
      ipcRenderer.on('imap:reconnecting', () => callback());
    },
    removeReconnectingListener: () => {
      ipcRenderer.removeAllListeners('imap:reconnecting');
    },
    onAuthError: (callback: () => void) => {
      ipcRenderer.on('imap:auth-error', () => callback());
    },
    removeAuthErrorListener: () => {
      ipcRenderer.removeAllListeners('imap:auth-error');
    },
  },

  // Folder operations
  folders: {
    list: () => ipcRenderer.invoke('folders:list'),
    setSyncPolicy: (folderId: string, policy: { syncEnabled?: boolean; syncMode?: 'full' | 'headers' | null }) =>
      ipcRenderer.invoke('folders:setSyncPolicy', folderId, policy),
  },

  // Email operations
  emails: {
    list: (folderId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('emails:list', folderId, limit, offset),
    get: (emailId: string) => ipcRenderer.invoke('emails:get', emailId),
    getThread: (threadId: string, accountId?: string) => ipcRenderer.invoke('emails:thread', threadId, accountId),
    rebuildThreads: () => ipcRenderer.invoke('threads:rebuild'),
    repairThreading: (options?: { dryRun?: boolean }) => ipcRenderer.invoke('threads:repair', options || {}),
    search: (query: string) => ipcRenderer.invoke('emails:search', query),
    // Server-side search escalation — pulls the newest server matches the local
    // index is missing into the DB, then the caller re-runs its local search.
    searchServer: (params: { query: any; folderId?: string; accountId?: string; maxFetch?: number }) =>
      ipcRenderer.invoke('emails:searchServer', params),
    getAll: (limit?: number, offset?: number) =>
      ipcRenderer.invoke('emails:getAll', limit, offset),
    // Unified Virtual Folder Methods (Single Source of Truth)
    getImportant: (limit?: number, offset?: number) =>
      ipcRenderer.invoke('emails:getImportant', limit, offset),
    getStarred: (limit?: number, offset?: number) =>
      ipcRenderer.invoke('emails:getStarred', limit, offset),
    getVirtualFolderCounts: (keys?: Array<'all' | 'starred' | 'important' | 'snoozed'>) =>
      ipcRenderer.invoke('emails:getVirtualFolderCounts', keys),
    getRecent: (options?: { minutes?: number; limit?: number }) =>
      ipcRenderer.invoke('emails:getRecent', options),
    listBySection: (filter: string, limit: number, offset: number, folderPath?: string, viewFilter?: any) =>
      ipcRenderer.invoke('emails:listBySection', filter, limit, offset, folderPath, viewFilter),
    sectionCounts: (filters: string[], folderPath?: string, viewFilter?: any) =>
      ipcRenderer.invoke('emails:sectionCounts', filters, folderPath, viewFilter),
    folderThreadCount: (folderPath?: string, viewFilter?: any) =>
      ipcRenderer.invoke('emails:folderThreadCount', folderPath, viewFilter),
    // On-demand body loading
    fetchBody: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:fetchBody', emailId, accountId),
    startBodyDownload: (target: number) =>
      ipcRenderer.invoke('emails:startBodyDownload', target),
    stopBodyDownload: () => ipcRenderer.invoke('emails:stopBodyDownload'),
    getBodyDownloadState: () => ipcRenderer.invoke('emails:getBodyDownloadState'),
    onBodyDownloadProgress: (cb: (state: BodyDownloadState) => void) => {
      const listener = (_e: unknown, state: BodyDownloadState) => cb(state);
      ipcRenderer.on('body-download:progress', listener);
      return () => ipcRenderer.removeListener('body-download:progress', listener);
    },
    getRawSource: (emailId: string) =>
      ipcRenderer.invoke('emails:getRawSource', emailId),
    fetchBodiesBatch: (emailIds: string[]) =>
      ipcRenderer.invoke('emails:fetchBodiesBatch', emailIds),
    downloadBodies: (limit?: number) =>
      ipcRenderer.invoke('emails:downloadBodies', limit),
    onBodyFetched: (callback: (email: any) => void) => {
      // Per-listener unsubscribe (same pattern as contactEnrichment.onRunBatch)
      // so overlapping batch fetches don't kill each other's listener.
      const handler = (_event: unknown, email: any) => callback(email);
      ipcRenderer.on('body:fetched', handler);
      return () => ipcRenderer.removeListener('body:fetched', handler);
    },
    removeBodyFetchedListener: () => {
      ipcRenderer.removeAllListeners('body:fetched');
    },
    downloadAttachment: (emailId: string, filename: string, accountId?: string) =>
      ipcRenderer.invoke('emails:downloadAttachment', emailId, filename, accountId),
    getAttachmentBase64: (emailId: string, filename: string, accountId?: string) =>
      ipcRenderer.invoke('emails:getAttachmentBase64', emailId, filename, accountId),
    previewAttachment: (emailId: string, filename: string, accountId?: string) =>
      ipcRenderer.invoke('emails:previewAttachment', emailId, filename, accountId),
    getCalendarInvite: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:getCalendarInvite', emailId, accountId),
    openCalendarInvite: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:openCalendarInvite', emailId, accountId),
    setCalendarAdded: (emailId: string, added: boolean, accountId?: string) =>
      ipcRenderer.invoke('emails:setCalendarAdded', emailId, added, accountId),
    markRead: (emailId: string, read: boolean, accountId?: string) =>
      ipcRenderer.invoke('emails:markRead', emailId, read, accountId),
    markStarred: (emailId: string, starred: boolean, accountId?: string) =>
      ipcRenderer.invoke('emails:markStarred', emailId, starred, accountId),
    markImportant: (emailId: string, important: boolean) =>
      ipcRenderer.invoke('emails:markImportant', emailId, important),
    syncStarred: () => ipcRenderer.invoke('emails:syncStarred'),
    moveToFolder: (emailId: string, folderId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:moveToFolder', emailId, folderId, accountId),
    copyToFolder: (emailId: string, folderId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:copyToFolder', emailId, folderId, accountId),
    bulkMoveToFolder: (emailIds: string[], folderId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:bulkMoveToFolder', emailIds, folderId, accountId),
    bulkCopyToFolder: (emailIds: string[], folderId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:bulkCopyToFolder', emailIds, folderId, accountId),
    getQuota: (accountId?: string) =>
      ipcRenderer.invoke('account:getQuota', accountId),
    moveToTrash: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:moveToTrash', emailId, accountId),
    moveToSpam: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:moveToSpam', emailId, accountId),
    moveFromSpam: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:moveFromSpam', emailId, accountId),
    archive: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:archive', emailId, accountId),
    delete: (emailId: string, accountId?: string) =>
      ipcRenderer.invoke('emails:delete', emailId, accountId),
    bulkAction: (emailIds: string[], action: string, accountId?: string, allowPermanent?: boolean) =>
      ipcRenderer.invoke('emails:bulkAction', emailIds, action, accountId, allowPermanent),
    // Remote-image sender allowlist (per active account).
    allowImagesForSender: (address: string) => ipcRenderer.invoke('images:allowSender', address),
    getImageAllowedSenders: () => ipcRenderer.invoke('images:getAllowedSenders'),
    disallowImagesForSender: (address: string) => ipcRenderer.invoke('images:disallowSender', address),
  },

  // Security: the user's link trust/block rules (see Security page).
  security: {
    listLinkRules: () => ipcRenderer.invoke('security:listLinkRules'),
    addLinkRule: (rule: { senderDomain: string; shownDomain: string; actualDomain: string; verdict: 'trust' | 'block' }) =>
      ipcRenderer.invoke('security:addLinkRule', rule),
    removeLinkRule: (id: number) => ipcRenderer.invoke('security:removeLinkRule', id),
    getHeaderBackfillState: () => ipcRenderer.invoke('security:getHeaderBackfillState'),
    kickHeaderBackfill: () => ipcRenderer.invoke('security:kickHeaderBackfill'),
    onHeaderBackfillProgress: (cb: (state: HeaderBackfillState) => void) => {
      const listener = (_e: unknown, state: HeaderBackfillState) => cb(state);
      ipcRenderer.on('header-backfill:progress', listener);
      return () => ipcRenderer.removeListener('header-backfill:progress', listener);
    },
  },

  // Sender identity: the domain's BIMI logo / verified mark, its favicon, and the
  // contact's confirmed photo — cached in main, never fetched by the renderer.
  identity: {
    getSender: (address: string) => ipcRenderer.invoke('identity:getSender', address),
    getPolicy: () => ipcRenderer.invoke('identity:getPolicy'),
    setPolicy: (policy: SenderIdentityPolicy) => ipcRenderer.invoke('identity:setPolicy', policy),
    list: (limit?: number) => ipcRenderer.invoke('identity:list', limit),
    refresh: (domain: string) => ipcRenderer.invoke('identity:refresh', domain),
    forget: (domain: string) => ipcRenderer.invoke('identity:forget', domain),
    onUpdated: (cb: (event: { domain: string }) => void) => {
      const listener = (_e: unknown, payload: { domain: string }) => cb(payload);
      ipcRenderer.on('identity:updated', listener);
      return () => ipcRenderer.removeListener('identity:updated', listener);
    },
  },

  // Spam filter, reputation stage: which provider judges senders, and its progress.
  spam: {
    getReputationPolicy: () => ipcRenderer.invoke('spam:getReputationPolicy'),
    setReputationPolicy: (policy: SpamReputationPolicy) => ipcRenderer.invoke('spam:setReputationPolicy', policy),
    getReputationState: () => ipcRenderer.invoke('spam:getReputationState'),
    kickReputation: () => ipcRenderer.invoke('spam:kickReputation'),
    listJudged: (limit?: number, accountId?: string) => ipcRenderer.invoke('spam:listJudged', limit, accountId),
    setUserVerdict: (emailId: string, verdict: SpamUserVerdict, accountId?: string) =>
      ipcRenderer.invoke('spam:setUserVerdict', emailId, verdict, accountId),
    onReputationProgress: (cb: (state: SpamReputationState) => void) => {
      const listener = (_e: unknown, state: SpamReputationState) => cb(state);
      ipcRenderer.on('spam:reputation-progress', listener);
      return () => ipcRenderer.removeListener('spam:reputation-progress', listener);
    },
  },

  // Storage operations
  storage: {
    getStats: () => ipcRenderer.invoke('storage:stats'),
    // Per-account file size and reclaimable (freelist) space.
    getUsage: () => ipcRenderer.invoke('storage:usage'),
    // Runs VACUUM. Minutes on a large account, and mail sync is paused for it.
    compact: (accountId?: string) => ipcRenderer.invoke('storage:compact', accountId),
  },

  // Contacts operations
  contacts: {
    list: (options: { limit: number; offset: number; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc'; contactType?: string }) =>
      ipcRenderer.invoke('contacts:list', options),
    get: (id: string, accountId?: string) => ipcRenderer.invoke('contacts:get', id, accountId),
    update: (id: string, updates: any) => ipcRenderer.invoke('contacts:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('contacts:delete', id),
    scan: () => ipcRenderer.invoke('contacts:scan'),
    // v39 enrichment (accountId optional — targets a specific account's DB when
    // enriching a background account; omitted = active account, legacy behavior)
    recentInbound: (contactId: string, limit?: number, accountId?: string) =>
      ipcRenderer.invoke('contacts:recentInbound', contactId, limit, accountId),
    applyEnrichment: (input: any) => ipcRenderer.invoke('contacts:applyEnrichment', input),
    recordEnrichmentWatermark: (contactId: string, throughEmailAt: number, accountId?: string) =>
      ipcRenderer.invoke('contacts:recordEnrichmentWatermark', contactId, throughEmailAt, accountId),
    // Confirm-gated avatars: approve / decline a discovered candidate photo.
    confirmAvatar: (contactId: string, accountId?: string) =>
      ipcRenderer.invoke('contacts:confirmAvatar', contactId, accountId),
    rejectAvatar: (contactId: string, accountId?: string) =>
      ipcRenderer.invoke('contacts:rejectAvatar', contactId, accountId),
    // Fired by the background avatar discovery when new candidate photos land,
    // so the Contacts view can refresh and surface the "use this photo?" prompt.
    onAvatarsUpdated: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('contacts:avatars-updated', handler);
      return () => ipcRenderer.removeListener('contacts:avatars-updated', handler);
    },
    getEnrichmentHistory: (contactId: string) =>
      ipcRenderer.invoke('contacts:getEnrichmentHistory', contactId),
    getRelatedByPerson: (contactId: string) =>
      ipcRenderer.invoke('contacts:getRelatedByPerson', contactId),
  },

  // Contact enrichment scheduler bridge — main drives the queue, renderer
  // does the LLM calls one-at-a-time.
  contactEnrichment: {
    onRunBatch: (callback: (payload: { contactIds: string[]; accountId?: string }) => void) => {
      const handler = (_e: unknown, payload: { contactIds: string[]; accountId?: string }) => callback(payload);
      ipcRenderer.on('contact-enrichment:run-batch', handler);
      return () => ipcRenderer.removeListener('contact-enrichment:run-batch', handler);
    },
    reportProgress: (payload: { contactId: string; ok: boolean; reason?: string | null }) =>
      ipcRenderer.invoke('contact-enrichment:report-progress', payload),
    reportBatchDone: () => ipcRenderer.invoke('contact-enrichment:report-batch-done'),
    triggerNow: () => ipcRenderer.invoke('contact-enrichment:trigger-now'),
  },

  // SMTP operations (sending emails)
  smtp: {
    connect: (config: SMTPConfig) => ipcRenderer.invoke('smtp:connect', config),
    // Connect a specific account's SMTP on demand (send-as another account).
    connectFor: (accountId: string, config: SMTPConfig) => ipcRenderer.invoke('smtp:connectFor', accountId, config),
    disconnect: () => ipcRenderer.invoke('smtp:disconnect'),
    isConnected: () => ipcRenderer.invoke('smtp:isConnected'),
    send: (options: SendEmailOptions) => ipcRenderer.invoke('smtp:send', options),
    // Persist-first undo-send: enqueue held (durable) → commit when the undo
    // window elapses, or cancel on Undo. See smtp-handlers for the crash-safety.
    sendWithUndo: (options: SendEmailOptions, undoDelayMs: number) => ipcRenderer.invoke('smtp:sendWithUndo', options, undoDelayMs),
    commitSend: (id: number, accountId?: string) => ipcRenderer.invoke('smtp:commitSend', id, accountId),
    cancelSend: (id: number, accountId?: string) => ipcRenderer.invoke('smtp:cancelSend', id, accountId),
  },

  // Dialog operations
  dialog: {
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  },

  // Signature patterns (cached signatures for AI detection - stores HTML selectors)
  signatures: {
    list: (options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('signatures:list', options),
    getByEmail: (email: string) => ipcRenderer.invoke('signatures:getByEmail', email),
    getBySelector: (selector: string) => ipcRenderer.invoke('signatures:getBySelector', selector),
    save: (pattern: { email: string; htmlSelector: string; sampleHtml?: string; emailId?: string; confidence: 'high' | 'medium' | 'low' }) =>
      ipcRenderer.invoke('signatures:save', pattern),
    delete: (id: string) => ipcRenderer.invoke('signatures:delete', id),
    clear: () => ipcRenderer.invoke('signatures:clear'),
  },

  // Email importance processor
  processor: {
    processEmails: (options?: { limit?: number; emailIds?: string[] }) =>
      ipcRenderer.invoke('processor:processEmails', options),
    processEmail: (emailId: string, userEmail: string, userDomain: string) =>
      ipcRenderer.invoke('processor:processEmail', emailId, userEmail, userDomain),
  },

  // Sender statistics and management
  sender: {
    getStats: (email: string) => ipcRenderer.invoke('sender:getStats', email),
    setVip: (email: string, isVip: boolean) => ipcRenderer.invoke('sender:setVip', email, isVip),
    setBlocked: (email: string, isBlocked: boolean) => ipcRenderer.invoke('sender:setBlocked', email, isBlocked),
    listVip: () => ipcRenderer.invoke('sender:listVip'),
    listBlocked: () => ipcRenderer.invoke('sender:listBlocked'),
  },

  // Snooze operations
  snooze: {
    set: (emailId: string, snoozeUntil: number) =>
      ipcRenderer.invoke('snooze:set', emailId, snoozeUntil),
    remove: (emailId: string) => ipcRenderer.invoke('snooze:remove', emailId),
    list: (options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('snooze:list', options),
    listEmails: (options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('snooze:listEmails', options),
    get: (emailId: string) => ipcRenderer.invoke('snooze:get', emailId),
    count: () => ipcRenderer.invoke('snooze:count'),
    checkDue: () => ipcRenderer.invoke('snooze:checkDue'),
    onWakeup: (callback: (data: { count: number; emailIds: string[] }) => void) => {
      ipcRenderer.on('snooze:wakeup', (_event, data) => callback(data));
    },
    removeWakeupListener: () => {
      ipcRenderer.removeAllListeners('snooze:wakeup');
    },
  },

  // AI Box operations
  ai: {
    getByCategory: (category: string, limit?: number, offset?: number, folderId?: string) =>
      ipcRenderer.invoke('ai:getByCategory', category, limit, offset, folderId),
    getCategoryCounts: (folderId?: string, mode?: 'unread' | 'total') => ipcRenderer.invoke('ai:getCategoryCounts', folderId, mode),
    getCategoryDefinitions: () => ipcRenderer.invoke('ai:getCategoryDefinitions'),
    getEmailCategoriesBatch: (emailIds: string[]) => ipcRenderer.invoke('ai:getEmailCategoriesBatch', emailIds),
    upsertCategoryDefinition: (def: any) => ipcRenderer.invoke('ai:upsertCategoryDefinition', def),
    deleteCategoryDefinition: (slug: string) => ipcRenderer.invoke('ai:deleteCategoryDefinition', slug),
    toggleCategoryDefinition: (slug: string, enabled: boolean) => ipcRenderer.invoke('ai:toggleCategoryDefinition', slug, enabled),
    getThreadSummary: (threadId: string) =>
      ipcRenderer.invoke('ai:getThreadSummary', threadId),
    saveThreadSummary: (summary: any) =>
      ipcRenderer.invoke('ai:saveThreadSummary', summary),
    getConversation: (threadId: string) =>
      ipcRenderer.invoke('ai:getConversation', threadId),
    saveConversation: (conversation: any) =>
      ipcRenderer.invoke('ai:saveConversation', conversation),
    clearAllConversations: () =>
      ipcRenderer.invoke('ai:clearAllConversations'),
    saveCategory: (category: any) =>
      ipcRenderer.invoke('ai:saveCategory', category),
    removeCategory: (emailId: string) =>
      ipcRenderer.invoke('ai:removeCategory', emailId),
    getUnprocessedEmails: (limit?: number) =>
      ipcRenderer.invoke('ai:getUnprocessedEmails', limit),
    getUnprocessedEmailCount: (limit?: number, skipRead?: boolean) =>
      ipcRenderer.invoke('ai:getUnprocessedEmailCount', limit, skipRead ?? true),
    getProcessingBreakdown: () => ipcRenderer.invoke('ai:getProcessingBreakdown'),
    setBacklogCap: (cap: number) => ipcRenderer.invoke('ai:setBacklogCap', cap),
    getBacklogCap: () => ipcRenderer.invoke('ai:getBacklogCap'),
    saveCategoriesBatch: (categories: any[]) =>
      ipcRenderer.invoke('ai:saveCategoriesBatch', categories),
    search: (searchQuery: SearchQuery) =>
      ipcRenderer.invoke('ai:search', searchQuery),
    searchCount: (searchQuery: SearchQuery) =>
      ipcRenderer.invoke('ai:searchCount', searchQuery),
    searchSuggest: (partial: string) =>
      ipcRenderer.invoke('search:suggest', partial),
    updateThreadExtraction: (threadId: string, emailCount: number) =>
      ipcRenderer.invoke('ai:updateThreadExtraction', threadId, emailCount),
    setProviderConfigured: (configured: boolean) =>
      ipcRenderer.invoke('ai:setProviderConfigured', configured),
    listPromptTemplates: () => ipcRenderer.invoke('ai:listPromptTemplates'),
    updatePromptTemplate: (id: string, content: string) =>
      ipcRenderer.invoke('ai:updatePromptTemplate', id, content),
    resetPromptTemplate: (id: string) =>
      ipcRenderer.invoke('ai:resetPromptTemplate', id),
    onExtractionBatch: (callback: (data: { threads: { id: string; messageCount: number }[] }) => void) => {
      ipcRenderer.on('conversation:extract-batch', (_event, data) => callback(data));
    },
    removeExtractionBatchListener: () => {
      ipcRenderer.removeAllListeners('conversation:extract-batch');
    },
  },

  // Spammer management operations
  spammers: {
    add: (spammer: { email: string; name?: string; reason?: string }) =>
      ipcRenderer.invoke('spammers:add', spammer),
    remove: (email: string) => ipcRenderer.invoke('spammers:remove', email),
    isSpammer: (email: string) => ipcRenderer.invoke('spammers:isSpammer', email),
    list: (options?: { limit?: number; offset?: number; search?: string }) =>
      ipcRenderer.invoke('spammers:list', options),
    count: () => ipcRenderer.invoke('spammers:count'),
  },

  // Outbox (SMTP send retry queue) + IMAP operation dead-letter queue
  outbox: {
    list: () => ipcRenderer.invoke('outbox:list'),
    get: (id: number) => ipcRenderer.invoke('outbox:get', id),
    counts: () => ipcRenderer.invoke('outbox:counts'),
    retry: (id: number) => ipcRenderer.invoke('outbox:retry', id),
    retryAll: () => ipcRenderer.invoke('outbox:retryAll'),
    delete: (id: number) => ipcRenderer.invoke('outbox:delete', id),
    discardAll: () => ipcRenderer.invoke('outbox:discardAll'),
    // Live signal that the outbox changed (enqueue/sent/failed/drained/deleted).
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('outbox:changed', handler);
      return () => { ipcRenderer.removeListener('outbox:changed', handler); };
    },
  },
  opQueue: {
    counts: () => ipcRenderer.invoke('opqueue:counts'),
    failed: () => ipcRenderer.invoke('opqueue:failed'),
    retry: () => ipcRenderer.invoke('opqueue:retry'),
    retryOne: (id: number) => ipcRenderer.invoke('opqueue:retryOne', id),
    delete: (id: number) => ipcRenderer.invoke('opqueue:delete', id),
    discardAll: () => ipcRenderer.invoke('opqueue:discardAll'),
  },

  // Multi-account: flip the active account (main resolves storage/sync/SMTP to it)
  accounts: {
    setActive: (accountId: string) => ipcRenderer.invoke('accounts:setActive', accountId),
    rekey: (oldId: string, newId: string) => ipcRenderer.invoke('accounts:rekey', oldId, newId),
    remove: (accountId: string) => ipcRenderer.invoke('accounts:remove', accountId),
    // Durable DB-backed registry (source of truth). list → hydrate on startup;
    // save → mirror the renderer's snapshot (upsert-only); get/setActivePointer
    // → the persisted active-account id.
    list: () => ipcRenderer.invoke('accounts:list'),
    save: (accounts: any[]) => ipcRenderer.invoke('accounts:save', accounts),
    getActive: () => ipcRenderer.invoke('accounts:getActive'),
    setActivePointer: (accountId: string | null) => ipcRenderer.invoke('accounts:setActivePointer', accountId),
    // Merged INBOX across accounts (unified "All Inboxes"), rows tagged accountId.
    unifiedInbox: (opts: { accountIds: string[]; limit?: number; offset?: number; filter?: ViewFilter; aiCategory?: string }) =>
      ipcRenderer.invoke('accounts:unifiedInbox', opts),
    // Merged AI-category counts across accounts for the All-Inboxes category tabs.
    unifiedCategoryCounts: (accountIds: string[], mode?: 'unread' | 'total') => ipcRenderer.invoke('accounts:unifiedCategoryCounts', accountIds, mode),
    // Full-text search across every opted-in account's INBOX (All-Inboxes search).
    unifiedSearch: (opts: { accountIds: string[]; searchQuery: any; limit?: number; offset?: number }) => ipcRenderer.invoke('accounts:unifiedSearch', opts),
    // Per-account INBOX unread counts for the sidebar badges.
    unreadSummary: (accountIds: string[]) => ipcRenderer.invoke('accounts:unreadSummary', accountIds),
    // Tier B: sync one inactive account's INBOX in the background (renderer-driven).
    backgroundSync: (opts: { accountId: string; config: any }) =>
      ipcRenderer.invoke('accounts:backgroundSync', opts),
  },

  // Durable global app settings (mirror of localStorage in the core DB).
  // getAllSync is SYNCHRONOUS (sendSync) so the renderer can restore settings
  // into localStorage during its earliest bootstrap, before anything reads them.
  appSettings: {
    getAllSync: (): Record<string, string> => {
      try { return ipcRenderer.sendSync('appSettings:getAllSync') || {}; }
      catch { return {}; }
    },
    set: (key: string, value: string) => ipcRenderer.invoke('appSettings:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('appSettings:delete', key),
  },

  // Secure per-account credential vault (safeStorage, main process). Renderer
  // uses this instead of persisting IMAP/SMTP passwords in plaintext localStorage.
  secureCreds: {
    set: (accountId: string, secrets: SecureAccountSecrets) => ipcRenderer.invoke('secureCreds:set', accountId, secrets),
    get: (accountId: string) => ipcRenderer.invoke('secureCreds:get', accountId),
    delete: (accountId: string) => ipcRenderer.invoke('secureCreds:delete', accountId),
    has: (accountId: string) => ipcRenderer.invoke('secureCreds:has', accountId),
    hasPassword: (accountId: string, kind?: 'imap' | 'smtp') => ipcRenderer.invoke('secureCreds:hasPassword', accountId, kind),
    reveal: (accountId: string, kind?: 'imap' | 'smtp') => ipcRenderer.invoke('secureCreds:reveal', accountId, kind),
    available: () => ipcRenderer.invoke('secureCreds:available'),
  },

  // New-mail OS notifications. The renderer pushes the live config (mode, sound,
  // per-account notify flags, current view); the main process owns the firing.
  // onOpenEmail wires a notification CLICK back to open that mail.
  notifications: {
    setConfig: (config: unknown) => ipcRenderer.invoke('notifications:setConfig', config),
    test: () => ipcRenderer.invoke('notifications:test'),
    onOpenEmail: (cb: (data: { accountId: string; emailId: string }) => void) => {
      const handler = (_e: unknown, data: { accountId: string; emailId: string }) => cb(data);
      ipcRenderer.on('notifications:open-email', handler);
      return () => ipcRenderer.removeListener('notifications:open-email', handler);
    },
    // In-app toast mirror — fired when native OS toasts can't be shown (dev, or a
    // platform with no notification daemon) so notifications are still visible.
    onInApp: (cb: (data: InAppToast) => void) => {
      const handler = (_e: unknown, data: InAppToast) => cb(data);
      ipcRenderer.on('notifications:in-app', handler);
      return () => ipcRenderer.removeListener('notifications:in-app', handler);
    },
    // An OAuth account's token could not be refreshed (revoked/expired refresh
    // token, or persistent failures) — the user must sign in again. Fired by the
    // refresh scheduler the moment it gives up, so the in-app banner appears
    // even if the OS notification never does. Does NOT navigate on its own.
    onReauthRequired: (cb: (data: { provider: string; email: string; reason: string }) => void) => {
      const handler = (_e: unknown, data: { provider: string; email: string; reason: string }) => cb(data);
      ipcRenderer.on('oauth:reauth-required', handler);
      return () => ipcRenderer.removeListener('oauth:reauth-required', handler);
    },
    // The account works again (a refresh succeeded, the user signed back in, or
    // the account was removed) — take the banner down without a reload.
    onReauthResolved: (cb: (data: { provider: string; email: string }) => void) => {
      const handler = (_e: unknown, data: { provider: string; email: string }) => cb(data);
      ipcRenderer.on('oauth:reauth-resolved', handler);
      return () => ipcRenderer.removeListener('oauth:reauth-resolved', handler);
    },
    // The user CLICKED the "Sign in again" OS notification — an explicit
    // request to be taken to Settings -> Accounts. Separate from the event
    // above precisely so the failure itself never navigates.
    onReauthOpenSettings: (cb: (data: { provider: string; email: string }) => void) => {
      const handler = (_e: unknown, data: { provider: string; email: string }) => cb(data);
      ipcRenderer.on('oauth:reauth-open-settings', handler);
      return () => ipcRenderer.removeListener('oauth:reauth-open-settings', handler);
    },
  },

  // AI-provider API keys kept in the main-process safeStorage vault (never in
  // renderer localStorage). Renderer holds only non-secret provider metadata.
  aiSecrets: {
    getAll: () => ipcRenderer.invoke('aiSecrets:getAll'),
    set: (providerId: string, apiKey: string) => ipcRenderer.invoke('aiSecrets:set', providerId, apiKey),
    delete: (providerId: string) => ipcRenderer.invoke('aiSecrets:delete', providerId),
  },

  // User-defined inbox filter rules
  filters: {
    list: () => ipcRenderer.invoke('filters:list'),
    create: (input: FilterRuleInput) => ipcRenderer.invoke('filters:create', input),
    update: (id: string, updates: Partial<FilterRuleInput>) => ipcRenderer.invoke('filters:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('filters:delete', id),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke('filters:reorder', orderedIds),
    applyToExisting: (id: string) => ipcRenderer.invoke('filters:applyToExisting', id),
    countMatches: (rule: { matchType: 'all' | 'any'; conditions: FilterCondition[] }) =>
      ipcRenderer.invoke('filters:countMatches', rule),
  },

  // User-defined labels
  labels: {
    list: (accountId?: string) => ipcRenderer.invoke('labels:list', accountId),
    create: (input: LabelInput, accountId?: string) => ipcRenderer.invoke('labels:create', input, accountId),
    update: (id: string, updates: Partial<LabelInput>) => ipcRenderer.invoke('labels:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('labels:delete', id),
    setOnEmail: (emailId: string, label: string, on: boolean, accountId?: string) =>
      ipcRenderer.invoke('emails:setLabel', emailId, label, on, accountId),
  },

  // AI Categorization (main process service)
  aiCategorization: {
    start: (config: any, mode: string, options?: any) =>
      ipcRenderer.invoke('ai-categorization:start', config, mode, options),
    stop: () => ipcRenderer.invoke('ai-categorization:stop'),
    startAuto: (config: any, options?: any) =>
      ipcRenderer.invoke('ai-categorization:startAuto', config, options),
    stopAuto: () => ipcRenderer.invoke('ai-categorization:stopAuto'),
    getStatus: () => ipcRenderer.invoke('ai-categorization:status'),
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('ai-categorization:progress', (_event, data) => callback(data));
    },
    onComplete: (callback: (data: any) => void) => {
      ipcRenderer.on('ai-categorization:complete', (_event, data) => callback(data));
    },
    onError: (callback: (data: any) => void) => {
      ipcRenderer.on('ai-categorization:error', (_event, data) => callback(data));
    },
    onLog: (callback: (data: { level: 'info' | 'warn' | 'error'; message: string; ts: number }) => void) => {
      ipcRenderer.on('ai-categorization:log', (_event, data) => callback(data));
    },
    removeListeners: () => {
      ipcRenderer.removeAllListeners('ai-categorization:progress');
      ipcRenderer.removeAllListeners('ai-categorization:complete');
      ipcRenderer.removeAllListeners('ai-categorization:error');
      ipcRenderer.removeAllListeners('ai-categorization:log');
    },
  },

  // Draft operations (auto-save to IMAP Drafts)
  drafts: {
    save: (draft: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; htmlBody?: string; inReplyTo?: string; threadId?: string; accountEmail?: string; accountId?: string }) =>
      ipcRenderer.invoke('drafts:save', draft),
    delete: (options: { messageId?: string; subject?: string; to?: string; threadId?: string; accountId?: string; savedAt?: number }) =>
      ipcRenderer.invoke('drafts:delete', options),
    getFolder: (accountId?: string) => ipcRenderer.invoke('drafts:get-folder', accountId),
    findForThread: (messageIds: string[], accountId?: string) =>
      ipcRenderer.invoke('drafts:find-for-thread', messageIds, accountId),
    debug: (event: string, data?: Record<string, unknown>) => ipcRenderer.invoke('drafts:debug', event, data),
    cleanup: (opts: { sinceMs?: number; beforeMs?: number; accountId?: string }) => ipcRenderer.invoke('drafts:cleanup', opts),
    // Main deleted draft(s) (e.g. the thread's lingering draft after a reply was
    // sent) — drop them from any open view.
    onRemoved: (callback: (data: { threadId: string; messageIds: string[] }) => void) => {
      const handler = (_e: unknown, data: { threadId: string; messageIds: string[] }) => callback(data);
      ipcRenderer.on('drafts:removed', handler);
      return () => ipcRenderer.removeListener('drafts:removed', handler);
    },
  },

  // Email Agent operations (behavior tracking, decisions, learning)
  agent: {
    logAction: (emailId: string, actionType: string, options?: {
      threadId?: string; actionValue?: string; source?: string; senderAddress?: string;
    }) => ipcRenderer.invoke('agent:logAction', emailId, actionType, options),
    logActionBatch: (actions: Array<{
      emailId: string; actionType: string; threadId?: string; actionValue?: string; source?: string; senderAddress?: string;
    }>) => ipcRenderer.invoke('agent:logActionBatch', actions),
    getRecentActions: (limit?: number, since?: number) =>
      ipcRenderer.invoke('agent:getRecentActions', limit, since),
    getActionsByEmail: (emailId: string) =>
      ipcRenderer.invoke('agent:getActionsByEmail', emailId),
    getActionStats: (since?: number) =>
      ipcRenderer.invoke('agent:getActionStats', since),
    // Agent decisions
    getPendingDecisions: () => ipcRenderer.invoke('agent:getPendingDecisions'),
    resolveDecision: (decisionId: string, status: string, actualAction?: string, feedback?: string) =>
      ipcRenderer.invoke('agent:resolveDecision', decisionId, status, actualAction, feedback),
    getDecisionHistory: (limit?: number, offset?: number) =>
      ipcRenderer.invoke('agent:getDecisionHistory', limit, offset),
    getDecisionAccuracy: (since?: number) =>
      ipcRenderer.invoke('agent:getDecisionAccuracy', since),
    // Behavior analysis
    getSenderPattern: (senderEmail: string) =>
      ipcRenderer.invoke('agent:getSenderPattern', senderEmail),
    getSenderTiers: () => ipcRenderer.invoke('agent:getSenderTiers'),
    getPeakHours: () => ipcRenderer.invoke('agent:getPeakHours'),
    predictAction: (senderAddress: string) =>
      ipcRenderer.invoke('agent:predictAction', senderAddress),
    // Sender metrics
    getSenderMetrics: (senderEmail: string, days?: number) =>
      ipcRenderer.invoke('agent:getSenderMetrics', senderEmail, days),
    getTopSenders: (actionType: string, limit?: number, since?: number) =>
      ipcRenderer.invoke('agent:getTopSenders', actionType, limit, since),
    // Pipeline events
    getPipelineEvents: (eventType?: string, limit?: number, since?: number) =>
      ipcRenderer.invoke('agent:getPipelineEvents', eventType, limit, since),
    // Historical learning
    backfillHistory: () => ipcRenderer.invoke('agent:backfillHistory'),
    isBackfilled: () => ipcRenderer.invoke('agent:isBackfilled'),
    getLearningSummary: () => ipcRenderer.invoke('agent:getLearningSummary'),
    // Contact classification
    setContactType: (email: string, contactType: string, source?: string) =>
      ipcRenderer.invoke('agent:setContactType', email, contactType, source),
    autoClassifyContacts: (userEmail: string) =>
      ipcRenderer.invoke('agent:autoClassifyContacts', userEmail),
    getContactsByType: (contactType: string, options?: { limit?: number; offset?: number; search?: string }) =>
      ipcRenderer.invoke('agent:getContactsByType', contactType, options),
    getContactTypeCounts: () => ipcRenderer.invoke('agent:getContactTypeCounts'),
    getContactsNeedingResponse: (limit?: number) =>
      ipcRenderer.invoke('agent:getContactsNeedingResponse', limit),
    refreshNeedsResponse: () => ipcRenderer.invoke('agent:refreshNeedsResponse'),
    // Agent activity + undo
    getAgentActions: (limit?: number) =>
      ipcRenderer.invoke('agent:getAgentActions', limit),
    undoAction: (actionId: string) =>
      ipcRenderer.invoke('agent:undoAction', actionId),
    // Contact notes (knowledge base)
    getNotes: (email: string, limit?: number) =>
      ipcRenderer.invoke('agent:getNotes', email, limit),
    addNote: (email: string, note: string, category: string) =>
      ipcRenderer.invoke('agent:addNote', email, note, category),
    editNote: (id: number, note: string) =>
      ipcRenderer.invoke('agent:editNote', id, note),
    deleteNote: (id: number) =>
      ipcRenderer.invoke('agent:deleteNote', id),
    getNotesCount: (email: string) =>
      ipcRenderer.invoke('agent:getNotesCount', email),
    // Agentic reply drafting
    draftReply: (emailId: string) =>
      ipcRenderer.invoke('agent:draftReply', emailId),
    // Pipeline control
    setAIConfig: (config: { type: string; apiKey: string; model: string; baseUrl?: string; authMethod?: 'apiKey' | 'oauth'; oauthProvider?: 'sarv'; oauthEmail?: string }) =>
      ipcRenderer.invoke('pipeline:setAIConfig', config),
    setCategoryLabels: (cfg: { enabled: boolean; folderMode: 'copy' | 'move' }) =>
      ipcRenderer.invoke('pipeline:setCategoryLabels', cfg),
    syncCategoryLabels: (limit?: number) => ipcRenderer.invoke('pipeline:syncCategoryLabels', limit),
    removeCategoryLabels: () => ipcRenderer.invoke('pipeline:removeCategoryLabels'),
    // Live per-email categorization result from the unified pipeline (any
    // account). Lets the UI show category badges/counts without a refresh.
    onEmailProcessed: (callback: (data: { emailId: string; categories?: string[] }) => void) => {
      const handler = (_e: unknown, data: { emailId: string; categories?: string[] }) => callback(data);
      ipcRenderer.on('pipeline:email-processed', handler);
      return () => { ipcRenderer.removeListener('pipeline:email-processed', handler); };
    },
    // Whether the BACKGROUND pipeline currently has a usable AI provider. Lets
    // the renderer surface an "AI paused" banner (and attempt a self-heal
    // re-push) instead of the pipeline silently skipping every mail.
    onPipelineAIStatus: (callback: (data: { available: boolean; reason: string }) => void) => {
      const handler = (_e: unknown, data: { available: boolean; reason: string }) => callback(data);
      ipcRenderer.on('ai:pipeline-status', handler);
      return () => { ipcRenderer.removeListener('ai:pipeline-status', handler); };
    },
    // Pipeline stats
    getPipelineStats: () => ipcRenderer.invoke('agent:getPipelineStats'),
    getCategoryReadiness: () => ipcRenderer.invoke('agent:getCategoryReadiness'),
    getEmailsByPriority: (limit?: number, minScore?: number) =>
      ipcRenderer.invoke('agent:getEmailsByPriority', limit, minScore),
    // Priority scoring
    scoreEmail: (emailId: string) => ipcRenderer.invoke('agent:scoreEmail', emailId),
    scoreWaitingEmails: (limit?: number) => ipcRenderer.invoke('agent:scoreWaitingEmails', limit),
    // Waiting actions
    getWaitingActions: (limit?: number) =>
      ipcRenderer.invoke('agent:getWaitingActions', limit),
    // Agent service (autonomous agent)
    getConfig: () => ipcRenderer.invoke('agent:getConfig'),
    setConfig: (config: any) => ipcRenderer.invoke('agent:setConfig', config),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('agent:setEnabled', enabled),
    isReady: () => ipcRenderer.invoke('agent:isReady'),
    getBehaviorProfile: () => ipcRenderer.invoke('agent:getBehaviorProfile'),
    getReplyStyleProfile: () => ipcRenderer.invoke('agent:getReplyStyleProfile'),
    generateReply: (emailId: string) => ipcRenderer.invoke('agent:generateReply', emailId),
    getProposals: () => ipcRenderer.invoke('agent:getProposals'),
    resolveProposal: (proposalId: string, approved: boolean, actualAction?: string, feedback?: string) =>
      ipcRenderer.invoke('agent:resolveProposal', proposalId, approved, actualAction, feedback),
    getAccuracyMetrics: (days?: number) => ipcRenderer.invoke('agent:getAccuracyMetrics', days),
    // Agent event listeners
    onNewProposal: (callback: (proposal: any) => void) => {
      ipcRenderer.on('agent:new-proposal', (_event, proposal) => callback(proposal));
    },
    onExecuteAction: (callback: (data: { emailId: string; action: string; value?: string }) => void) => {
      ipcRenderer.on('agent:execute-action', (_event, data) => callback(data));
    },
    onDraftReady: (callback: (data: { emailId: string; decisionId: string; draftBody: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('agent:draft-ready', handler);
      return () => ipcRenderer.removeListener('agent:draft-ready', handler);
    },
    // Live pipeline backlog counters (extraction/agent pending) every tick.
    onPipelineStats: (callback: (data: { extractionPending?: number; agentPending?: number }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('pipeline:stats', handler);
      return () => ipcRenderer.removeListener('pipeline:stats', handler);
    },
    removeAgentListeners: () => {
      ipcRenderer.removeAllListeners('agent:new-proposal');
      ipcRenderer.removeAllListeners('agent:execute-action');
      ipcRenderer.removeAllListeners('agent:draft-ready');
    },
  },

  // OAuth (Google/Microsoft/Yahoo/Sarv) sign-in flow
  oauth: {
    listProviders: () => ipcRenderer.invoke('oauth:listProviders'),
    startFlow: (providerId: 'gmail' | 'microsoft' | 'yahoo' | 'sarv') =>
      ipcRenderer.invoke('oauth:startFlow', providerId),
    cancel: () => ipcRenderer.invoke('oauth:cancel'),
    listAccounts: () => ipcRenderer.invoke('oauth:listAccounts'),
    // Accounts already known to need re-authentication. Pulled on mount so a
    // window that opened after the failure still shows the banner.
    listReauthRequired: () => ipcRenderer.invoke('oauth:listReauthRequired'),
    signOut: (providerId: 'gmail' | 'microsoft' | 'yahoo' | 'sarv', email: string) =>
      ipcRenderer.invoke('oauth:signOut', providerId, email),
    getAccessToken: (providerId: 'gmail' | 'microsoft' | 'yahoo' | 'sarv', email: string) =>
      ipcRenderer.invoke('oauth:getAccessToken', providerId, email),
  },

  // Extension management operations
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list'),
    getInfo: (extensionId: string) => ipcRenderer.invoke('extensions:getInfo', extensionId),
    enable: (extensionId: string) => ipcRenderer.invoke('extensions:enable', extensionId),
    disable: (extensionId: string) => ipcRenderer.invoke('extensions:disable', extensionId),
    uninstall: (extensionId: string) => ipcRenderer.invoke('extensions:uninstall', extensionId),
    selectAndInstall: () => ipcRenderer.invoke('extensions:selectAndInstall'),
    getWorkflows: () => ipcRenderer.invoke('extensions:getWorkflows'),
    browse: (options?: { force?: boolean }) => ipcRenderer.invoke('extensions:browse', options),
    registryDetail: (extensionId: string) =>
      ipcRenderer.invoke('extensions:registryDetail', extensionId),
    installFromRegistry: (extensionId: string, permissions: string[]) =>
      ipcRenderer.invoke('extensions:installFromRegistry', extensionId, permissions),
    getRegistries: () => ipcRenderer.invoke('extensions:getRegistries'),
    // Panels. `listPanels` is re-read whenever extensions change: a disabled
    // extension's panel has to disappear straight away.
    listPanels: () => ipcRenderer.invoke('extensions:listPanels'),
    // One request from a panel iframe, relayed verbatim. The renderer must not
    // interpret it — main re-validates and permission-checks every field.
    panelRequest: (
      extensionId: string,
      payload: unknown,
      context?: { currentMessageId?: string },
    ) => ipcRenderer.invoke('extensions:panelRequest', extensionId, payload, context),
    // Cards an extension asked to show. The payload is already sanitised in the
    // main process (capped strings, namespaced id, malformed fields dropped) —
    // the renderer never sees what an extension literally passed.
    onNotify: (callback: (card: ExtensionNotificationCard) => void) => {
      const listener = (_event: unknown, card: ExtensionNotificationCard) => callback(card);
      ipcRenderer.on('extensions:notify', listener);
      return () => ipcRenderer.removeListener('extensions:notify', listener);
    },
    onDismiss: (callback: (payload: { id: string; extensionId: string }) => void) => {
      const listener = (_event: unknown, payload: { id: string; extensionId: string }) =>
        callback(payload);
      ipcRenderer.on('extensions:dismiss', listener);
      return () => ipcRenderer.removeListener('extensions:dismiss', listener);
    },
    // An extension asked for one of its own panels to be shown. The renderer
    // still decides whether it can honour it right now.
    onOpenPanel: (callback: (payload: { extensionId: string; panelId: string }) => void) => {
      const listener = (_event: unknown, payload: { extensionId: string; panelId: string }) =>
        callback(payload);
      ipcRenderer.on('extensions:openPanel', listener);
      return () => ipcRenderer.removeListener('extensions:openPanel', listener);
    },
    onOpenMessage: (
      callback: (payload: { extensionId: string; emailId: string; accountId?: string }) => void,
    ) => {
      const listener = (
        _event: unknown,
        payload: { extensionId: string; emailId: string; accountId?: string },
      ) => callback(payload);
      ipcRenderer.on('extensions:openMessage', listener);
      return () => ipcRenderer.removeListener('extensions:openMessage', listener);
    },
    // A reader acted on a card. Reporting is fire-and-await: whether an
    // extension is listening is the main process's business, not the UI's.
    cardAction: (
      notificationId: string,
      action: {
        action: 'copy' | 'dismiss' | 'expire' | 'open';
        fieldIndex?: number;
        fieldLabel?: string;
        emailId?: string;
        accountId?: string;
      },
    ) => ipcRenderer.invoke('extensions:cardAction', notificationId, action),
    // Capabilities. The app asks for a JOB by name and takes whichever
    // extension serves it; nothing in the renderer names an extension.
    invoke: (capability: string, ...args: unknown[]) =>
      ipcRenderer.invoke('extensions:invoke', capability, args),
    capabilities: () => ipcRenderer.invoke('extensions:capabilities'),
    isAvailable: (extensionId: string) => ipcRenderer.invoke('extension:isAvailable', extensionId),
    // Listen for AI complete requests from main process (for extension AI backend)
    onAICompleteRequest: (callback: (request: { requestId: string; systemPrompt: string; userPrompt: string; maxTokens?: number }) => void) => {
      ipcRenderer.on('ai:complete-request', (_event, request) => callback(request));
    },
    sendAICompleteResponse: (response: { requestId: string; success: boolean; result?: string; error?: string }) => {
      ipcRenderer.send('ai:complete-response', response);
    },
    removeAICompleteListener: () => {
      ipcRenderer.removeAllListeners('ai:complete-request');
    },
  },
  // Renderer → main log forwarding, so renderer log lines land in the same
  // app.log as the main process. Fire-and-forget (send, not invoke) so logging
  // never blocks on an IPC round-trip; redaction happens in the main process.
  log: {
    forward: (record: { level: string; name: string; text: string }) =>
      ipcRenderer.send('log:forward', record),
  },
});

// Type definitions for the exposed API
/** A row of the Security page's Spam tab: what the filter had an opinion on. */
export interface SpamJudgedRow {
  id: string;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  date: number;
  folderPath: string;
  tags: string;
  spamScore: number | null;
  spamReasons: string | null;
  spamUserVerdict: SpamUserVerdict | null;
}

/** Progress of the header backfill over older mail (see header-backfill.ts). */
export interface HeaderBackfillState {
  /** Messages still missing an authentication verdict or a spam score. */
  remaining: number;
  /** Verdicts written since the app started. */
  done: number;
  /** A tick is currently fetching. */
  running: boolean;
  /** Nothing left to fetch. */
  drained: boolean;
}

/** Progress of a manual body download (see `emails:startBodyDownload`). */
export interface BodyDownloadState {
  active: boolean;
  target: number;
  downloaded: number;
  remaining: number;
}

export interface ElectronAPI {
  app: {
    getVersion: () => Promise<{ success: boolean; data?: string; error?: string }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  };
  system: {
    onSuspend: (callback: () => void) => void;
    onResume: (callback: () => void) => void;
    onLock: (callback: () => void) => void;
    onUnlock: (callback: () => void) => void;
    removeAllListeners: () => void;
  };
  imap: {
    /** `healedAuthMethod` is set when main repaired an account that was marked
     *  oauth2 but whose server rejected the token; persist it to make it stick. */
    connect: (config: IMAPConfig, accountId?: string) => Promise<{ success: boolean; error?: string; healedAuthMethod?: 'password' }>;
    /** Verify credentials against the server without touching the active
     *  connection or any stored account. Used to gate account overwrites. */
    probeCredentials: (config: IMAPConfig) => Promise<{ success: boolean; error?: string }>;
    disconnect: () => Promise<{ success: boolean; error?: string }>;
    getSavedConfig: () => Promise<{ success: boolean; data?: any; error?: string }>;
    clearSavedConfig: () => Promise<{ success: boolean; error?: string }>;
    sync: (options?: SyncEngineOptions) => Promise<{ success: boolean; error?: string }>;
    /** Pull one bounded chunk of older mail for a folder via the background
     *  backfill (used by scroll-to-bottom instead of a growing full sync).
     *  `data` is null when it couldn't run (disconnected / a sync is in flight). */
    backfillChunk: (folderPath: string) => Promise<{ success: boolean; data?: { fetched: number; inserted: number; done: boolean } | null; error?: string }>;
    stopSync: () => Promise<{ success: boolean; error?: string }>;
    getStatus: () => Promise<{ success: boolean; data?: SyncStatus; error?: string }>;
    isConnected: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    ensureConnection: () => Promise<{ success: boolean; data?: { connected: boolean; reconnected: boolean }; error?: string }>;
    resetAndReconnect: () => Promise<{ success: boolean; data?: { connected: boolean }; error?: string }>;
    onSyncProgress: (callback: (status: SyncStatus) => void) => void;
    removeSyncProgressListener: () => void;
    // IDLE (real-time updates)
    startIdle: (folderPath: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    stopIdle: () => Promise<{ success: boolean; error?: string }>;
    isIdleActive: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    refreshFlags: (folderPath: string) => Promise<{ success: boolean; data?: number; error?: string }>;
    onRealtimeEvent: (callback: (event: RealtimeEvent) => void) => void;
    removeRealtimeEventListener: () => void;
    onFoldersUpdated: (callback: (info: { accountId?: string; folderPath?: string }) => void) => () => void;
    removeFoldersUpdatedListener: () => void;
    onDisconnected: (callback: () => void) => void;
    removeDisconnectedListener: () => void;
    onReconnected: (callback: () => void) => void;
    removeReconnectedListener: () => void;
    onReconnecting: (callback: () => void) => void;
    removeReconnectingListener: () => void;
    onAuthError: (callback: () => void) => void;
    removeAuthErrorListener: () => void;
  };
  folders: {
    list: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
    setSyncPolicy: (folderId: string, policy: { syncEnabled?: boolean; syncMode?: 'full' | 'headers' | null }) => Promise<{ success: boolean; error?: string }>;
  };
  emails: {
    list: (
      folderId: string,
      limit?: number,
      offset?: number
    ) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    get: (emailId: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    getThread: (
      threadId: string,
      accountId?: string
    ) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    rebuildThreads: () => Promise<{ success: boolean; data?: { emailsUpdated: number; threadsCreated: number }; error?: string }>;
    repairThreading: (options?: { dryRun?: boolean }) => Promise<{
      success: boolean;
      data?: {
        totalEmails: number;
        iterations: number;
        emailsRetargeted: number;
        threadsBefore: number;
        threadsAfter: number;
        sample: Array<{ id: string; from: string; subject: string | null; oldThread: string; newThread: string; via: string }>;
      };
      error?: string;
    }>;
    search: (query: string) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    searchServer: (params: { query: any; folderId?: string; accountId?: string; maxFetch?: number }) => Promise<{
      success: boolean;
      data?: { skipped: boolean; matched: number; alreadyLocal: number; inserted: number; folderPath: string };
      error?: string;
    }>;
    getAll: (limit?: number, offset?: number) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    getImportant: (limit?: number, offset?: number) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    getStarred: (limit?: number, offset?: number) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    getVirtualFolderCounts: (keys?: Array<'all' | 'starred' | 'important' | 'snoozed'>) => Promise<{ success: boolean; data?: Partial<Record<'important' | 'starred' | 'all' | 'snoozed', number>>; error?: string }>;
    getRecent: (options?: { minutes?: number; limit?: number }) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    listBySection: (filter: string, limit: number, offset: number, folderPath?: string, viewFilter?: any) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    sectionCounts: (filters: string[], folderPath?: string, viewFilter?: any) => Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
    folderThreadCount: (folderPath?: string, viewFilter?: any) => Promise<{ success: boolean; data?: number | null; error?: string }>;
    fetchBody: (emailId: string, accountId?: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    startBodyDownload: (target: number) =>
      Promise<{ success: boolean; data?: BodyDownloadState; error?: string }>;
    stopBodyDownload: () =>
      Promise<{ success: boolean; data?: BodyDownloadState; error?: string }>;
    getBodyDownloadState: () =>
      Promise<{ success: boolean; data?: BodyDownloadState; error?: string }>;
    /** Subscribe to manual body-download progress. Returns an unsubscribe fn. */
    onBodyDownloadProgress: (cb: (state: BodyDownloadState) => void) => () => void;
    getRawSource: (emailId: string) => Promise<{ success: boolean; data?: string; error?: string }>;
    fetchBodiesBatch: (emailIds: string[]) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    downloadBodies: (limit?: number) => Promise<{ success: boolean; data?: { downloaded: number }; error?: string }>;
    onBodyFetched: (callback: (email: any) => void) => () => void;
    removeBodyFetchedListener: () => void;
    downloadAttachment: (emailId: string, filename: string, accountId?: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    getAttachmentBase64: (emailId: string, filename: string, accountId?: string) => Promise<{ success: boolean; base64?: string; error?: string }>;
    previewAttachment: (emailId: string, filename: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    getCalendarInvite: (emailId: string, accountId?: string) => Promise<{ success: boolean; ics?: string | null; error?: string }>;
    openCalendarInvite: (emailId: string, accountId?: string) => Promise<{ success: boolean; noHandler?: boolean; error?: string }>;
    setCalendarAdded: (emailId: string, added: boolean, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    markRead: (emailId: string, read: boolean, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    markStarred: (emailId: string, starred: boolean, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    markImportant: (emailId: string, important: boolean) => Promise<{ success: boolean; error?: string }>;
    syncStarred: () => Promise<{ success: boolean; data?: { synced: number; total: number }; error?: string }>;
    moveToFolder: (emailId: string, folderId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    copyToFolder: (emailId: string, folderId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    bulkMoveToFolder: (emailIds: string[], folderId: string, accountId?: string) => Promise<{ success: boolean; data?: { moved: number }; error?: string }>;
    bulkCopyToFolder: (emailIds: string[], folderId: string, accountId?: string) => Promise<{ success: boolean; data?: { copied: number }; error?: string }>;
    getQuota: (accountId?: string) => Promise<{ success: boolean; data?: { used: number; limit: number } | null; error?: string }>;
    moveToTrash: (emailId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    moveToSpam: (emailId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    moveFromSpam: (emailId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    archive: (emailId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    delete: (emailId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    bulkAction: (emailIds: string[], action: string, accountId?: string, allowPermanent?: boolean) => Promise<{ success: boolean; error?: string }>;
    allowImagesForSender: (address: string) => Promise<{ success: boolean; error?: string }>;
    getImageAllowedSenders: () => Promise<{ success: boolean; data?: string[]; error?: string }>;
    disallowImagesForSender: (address: string) => Promise<{ success: boolean; error?: string }>;
  };
  security: {
    listLinkRules: () => Promise<{ success: boolean; data?: Array<{ id: number; senderDomain: string; shownDomain: string; actualDomain: string; verdict: 'trust' | 'block'; createdAt: number }>; error?: string }>;
    addLinkRule: (rule: { senderDomain: string; shownDomain: string; actualDomain: string; verdict: 'trust' | 'block' }) => Promise<{ success: boolean; error?: string }>;
    removeLinkRule: (id: number) => Promise<{ success: boolean; error?: string }>;
    getHeaderBackfillState: () => Promise<{ success: boolean; data?: HeaderBackfillState; error?: string }>;
    kickHeaderBackfill: () => Promise<{ success: boolean; data?: HeaderBackfillState; error?: string }>;
    /** Subscribe to backfill progress. Returns an unsubscribe fn. */
    onHeaderBackfillProgress: (cb: (state: HeaderBackfillState) => void) => () => void;
  };
  identity: {
    getSender: (address: string) => Promise<{ success: boolean; data?: SenderIdentity; error?: string }>;
    getPolicy: () => Promise<{ success: boolean; data?: SenderIdentityPolicy; error?: string }>;
    setPolicy: (policy: SenderIdentityPolicy) => Promise<{ success: boolean; data?: SenderIdentityPolicy; error?: string }>;
    list: (limit?: number) => Promise<{ success: boolean; data?: DomainIdentityRow[]; error?: string }>;
    refresh: (domain: string) => Promise<{ success: boolean; data?: DomainIdentityRow | null; error?: string }>;
    forget: (domain: string) => Promise<{ success: boolean; error?: string }>;
    /** Fired when a domain's lookup lands. Returns an unsubscribe fn. */
    onUpdated: (cb: (event: { domain: string }) => void) => () => void;
  };
  spam: {
    getReputationPolicy: () => Promise<{ success: boolean; data?: SpamReputationPolicy; error?: string }>;
    setReputationPolicy: (policy: SpamReputationPolicy) => Promise<{ success: boolean; data?: SpamReputationPolicy; error?: string }>;
    getReputationState: () => Promise<{ success: boolean; data?: SpamReputationState; error?: string }>;
    kickReputation: () => Promise<{ success: boolean; data?: SpamReputationState; error?: string }>;
    listJudged: (limit?: number, accountId?: string) => Promise<{ success: boolean; data?: SpamJudgedRow[]; error?: string }>;
    setUserVerdict: (emailId: string, verdict: SpamUserVerdict, accountId?: string) => Promise<{ success: boolean; data?: { moved: boolean }; error?: string }>;
    /** Subscribe to reputation-pass progress. Returns an unsubscribe fn. */
    onReputationProgress: (cb: (state: SpamReputationState) => void) => () => void;
  };
  storage: {
    getStats: () => Promise<{ success: boolean; data?: any; error?: string }>;
    getUsage: () => Promise<{
      success: boolean;
      data?: Array<{
        accountId: string;
        email: string;
        host: string;
        fileBytes: number;
        freeBytes: number;
        liveBytes: number;
        freeRatio: number;
        worthwhile: boolean;
      }>;
      error?: string;
    }>;
    compact: (accountId?: string) => Promise<{
      success: boolean;
      data?: {
        accountId: string;
        beforeBytes: number;
        afterBytes: number;
        reclaimedBytes: number;
        elapsedMs: number;
        emailCount: number | null;
        rowsPreserved: boolean;
        autoVacuumEnabled: boolean;
      };
      error?: string;
    }>;
  };
  contacts: {
    list: (options: { limit: number; offset: number; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc'; contactType?: string }) =>
      Promise<{ success: boolean; data?: { contacts: any[]; total: number }; error?: string }>;
    get: (id: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    update: (id: string, updates: any) => Promise<{ success: boolean; data?: any; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    confirmAvatar: (contactId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    rejectAvatar: (contactId: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
    onAvatarsUpdated: (cb: () => void) => () => void;
    scan: () => Promise<{ success: boolean; data?: { scanned: boolean; totalContacts: number }; error?: string }>;
    recentInbound: (contactId: string, limit?: number) =>
      Promise<{ success: boolean; data?: Array<{ id: string; date: number; subject: string; cleanBody: string | null; plainBody: string | null; htmlBody: string | null }>; error?: string }>;
    applyEnrichment: (input: {
      contactId: string;
      enrichment: any;
      kind?: 'individual' | 'company';
      mobileE164?: string | null;
      enrichedThroughEmailAt: number;
      sourceEmailId?: string | null;
      source?: 'llm' | 'user';
    }) => Promise<{ success: boolean; data?: any; error?: string }>;
    recordEnrichmentWatermark: (contactId: string, throughEmailAt: number) =>
      Promise<{ success: boolean; error?: string }>;
    getEnrichmentHistory: (contactId: string) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getRelatedByPerson: (contactId: string) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
  };
  contactEnrichment: {
    onRunBatch: (callback: (payload: { contactIds: string[] }) => void) => () => void;
    reportProgress: (payload: { contactId: string; ok: boolean; reason?: string | null }) =>
      Promise<{ success: boolean }>;
    reportBatchDone: () => Promise<{ success: boolean }>;
    triggerNow: () => Promise<{ success: boolean; data?: { queued: number }; error?: string }>;
  };
  smtp: {
    connect: (config: SMTPConfig) => Promise<{ success: boolean; error?: string }>;
    connectFor: (accountId: string, config: SMTPConfig) => Promise<{ success: boolean; error?: string }>;
    disconnect: () => Promise<{ success: boolean; error?: string }>;
    isConnected: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    send: (options: SendEmailOptions) => Promise<{ success: boolean; queued?: boolean; messageId?: string; error?: string }>;
    sendWithUndo: (options: SendEmailOptions, undoDelayMs: number) => Promise<{ success: boolean; id?: number; error?: string }>;
    commitSend: (id: number, accountId?: string) => Promise<{ success: boolean; failed?: number; deferred?: boolean }>;
    cancelSend: (id: number, accountId?: string) => Promise<{ success: boolean; cancelled: boolean; error?: string }>;
  };
  dialog: {
    pickFiles: () => Promise<{ success: boolean; data?: Array<{ filename: string; content: string; contentType: string; encoding: 'base64'; size: number }>; error?: string }>;
  };
  signatures: {
    list: (options?: { limit?: number; offset?: number }) =>
      Promise<{ success: boolean; data?: { patterns: SignaturePattern[]; total: number }; error?: string }>;
    getByEmail: (email: string) => Promise<{ success: boolean; data?: SignaturePattern | null; error?: string }>;
    getBySelector: (selector: string) => Promise<{ success: boolean; data?: SignaturePattern | null; error?: string }>;
    save: (pattern: { email: string; htmlSelector: string; sampleHtml?: string; emailId?: string; confidence: 'high' | 'medium' | 'low' }) =>
      Promise<{ success: boolean; data?: SignaturePattern; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    clear: () => Promise<{ success: boolean; error?: string }>;
  };
  processor: {
    processEmails: (options?: { limit?: number; emailIds?: string[] }) =>
      Promise<{ success: boolean; data?: { processed: number }; error?: string }>;
    processEmail: (emailId: string, userEmail: string, userDomain: string) =>
      Promise<{ success: boolean; data?: ImportanceResult; error?: string }>;
  };
  sender: {
    getStats: (email: string) => Promise<{ success: boolean; data?: SenderStats | null; error?: string }>;
    setVip: (email: string, isVip: boolean) => Promise<{ success: boolean; error?: string }>;
    setBlocked: (email: string, isBlocked: boolean) => Promise<{ success: boolean; error?: string }>;
    listVip: () => Promise<{ success: boolean; data?: SenderStats[]; error?: string }>;
    listBlocked: () => Promise<{ success: boolean; data?: SenderStats[]; error?: string }>;
  };
  snooze: {
    set: (emailId: string, snoozeUntil: number) => Promise<{ success: boolean; data?: SnoozedEmail; error?: string }>;
    remove: (emailId: string) => Promise<{ success: boolean; error?: string }>;
    list: (options?: { limit?: number; offset?: number }) =>
      Promise<{ success: boolean; data?: SnoozedEmail[]; error?: string }>;
    listEmails: (options?: { limit?: number; offset?: number }) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    get: (emailId: string) => Promise<{ success: boolean; data?: SnoozedEmail | null; error?: string }>;
    count: () => Promise<{ success: boolean; data?: number; error?: string }>;
    checkDue: () => Promise<{ success: boolean; data?: { unsnoozed: number }; error?: string }>;
    onWakeup: (callback: (data: { count: number; emailIds: string[] }) => void) => void;
    removeWakeupListener: () => void;
  };
  ai: {
    getByCategory: (category: string, limit?: number, offset?: number, folderId?: string) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getCategoryCounts: (folderId?: string, mode?: 'unread' | 'total') =>
      Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
    getCategoryDefinitions: () =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getEmailCategoriesBatch: (emailIds: string[]) =>
      Promise<{ success: boolean; data?: Record<string, string[]>; error?: string }>;
    upsertCategoryDefinition: (def: any) =>
      Promise<{ success: boolean; error?: string }>;
    deleteCategoryDefinition: (slug: string) =>
      Promise<{ success: boolean; data?: { deleted: boolean }; error?: string }>;
    toggleCategoryDefinition: (slug: string, enabled: boolean) =>
      Promise<{ success: boolean; error?: string }>;
    getThreadSummary: (threadId: string) =>
      Promise<{ success: boolean; data?: ThreadSummaryRecord | null; error?: string }>;
    saveThreadSummary: (summary: any) =>
      Promise<{ success: boolean; error?: string }>;
    getConversation: (threadId: string) =>
      Promise<{ success: boolean; data?: any; error?: string }>;
    saveConversation: (conversation: any) =>
      Promise<{ success: boolean; error?: string }>;
    clearAllConversations: () =>
      Promise<{ success: boolean; data?: number; error?: string }>;
    saveCategory: (category: any) =>
      Promise<{ success: boolean; error?: string }>;
    removeCategory: (emailId: string) =>
      Promise<{ success: boolean; error?: string }>;
    getUnprocessedEmails: (limit?: number) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getUnprocessedEmailCount: (limit?: number, skipRead?: boolean) =>
      Promise<{ success: boolean; data?: number; error?: string }>;
    /** The breakdown behind the AI dashboard's "processing breakdown" panel. */
    getProcessingBreakdown: () =>
      Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
    /** Push the "AI Processing Limit" setting to the background pipeline. */
    setBacklogCap: (cap: number) =>
      Promise<{ success: boolean; data?: { cap: number }; error?: string }>;
    getBacklogCap: () =>
      Promise<{ success: boolean; data?: { cap: number }; error?: string }>;
    saveCategoriesBatch: (categories: any[]) =>
      Promise<{ success: boolean; data?: { saved: number }; error?: string }>;
    search: (searchQuery: SearchQuery) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    searchCount: (searchQuery: SearchQuery) =>
      Promise<{ success: boolean; data?: number; error?: string }>;
    searchSuggest: (partial: string) =>
      Promise<{ success: boolean; data?: string[]; error?: string }>;
    updateThreadExtraction: (threadId: string, emailCount: number) =>
      Promise<{ success: boolean; error?: string }>;
    setProviderConfigured: (configured: boolean) =>
      Promise<{ success: boolean; error?: string }>;
    listPromptTemplates: () =>
      Promise<{ success: boolean; data?: Array<{ id: string; label: string; description: string | null; content: string; defaultContent: string; updatedAt: number; createdAt: number }>; error?: string }>;
    updatePromptTemplate: (id: string, content: string) =>
      Promise<{ success: boolean; error?: string }>;
    resetPromptTemplate: (id: string) =>
      Promise<{ success: boolean; error?: string }>;
    onExtractionBatch: (callback: (data: { threads: { id: string; messageCount: number }[] }) => void) => void;
    removeExtractionBatchListener: () => void;
  };
  spammers: {
    add: (spammer: { email: string; name?: string; reason?: string }) =>
      Promise<{ success: boolean; error?: string }>;
    remove: (email: string) => Promise<{ success: boolean; error?: string }>;
    isSpammer: (email: string) =>
      Promise<{ success: boolean; data?: boolean; error?: string }>;
    list: (options?: { limit?: number; offset?: number; search?: string }) =>
      Promise<{ success: boolean; data?: { spammers: SpammerRecord[]; total: number }; error?: string }>;
    count: () => Promise<{ success: boolean; data?: number; error?: string }>;
  };
  outbox: {
    list: () => Promise<{ success: boolean; data?: OutboxSend[]; error?: string }>;
    get: (id: number) => Promise<{ success: boolean; data?: OutboxPreview; error?: string }>;
    counts: () => Promise<{ success: boolean; data?: { pending: number; failed: number }; error?: string }>;
    retry: (id: number) => Promise<{ success: boolean; data?: OutboxRetryResult; error?: string }>;
    retryAll: () => Promise<{ success: boolean; data?: { retried: number; connected: boolean; drained: { sent: number; queued: number; failed: number } }; error?: string }>;
    delete: (id: number) => Promise<{ success: boolean; error?: string }>;
    discardAll: () => Promise<{ success: boolean; data?: { removed: number }; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  opQueue: {
    counts: () => Promise<{ success: boolean; data?: { pending: number; failed: number }; error?: string }>;
    failed: () => Promise<{ success: boolean; data?: FailedOperation[]; error?: string }>;
    retry: () => Promise<{ success: boolean; data?: { retried: number }; error?: string }>;
    retryOne: (id: number) => Promise<{ success: boolean; data?: { retried: number }; error?: string }>;
    delete: (id: number) => Promise<{ success: boolean; error?: string }>;
    discardAll: () => Promise<{ success: boolean; data?: { removed: number }; error?: string }>;
  };
  accounts: {
    setActive: (accountId: string) => Promise<{ success: boolean; error?: string }>;
    rekey: (oldId: string, newId: string) => Promise<{ success: boolean; error?: string }>;
    remove: (accountId: string) => Promise<{ success: boolean; error?: string }>;
    // Durable DB-backed registry. The DTO mirrors the renderer's StoredAccount
    // persisted (non-secret) shape.
    list: () => Promise<{ success: boolean; data?: RegistryAccountDTO[]; error?: string }>;
    save: (accounts: RegistryAccountDTO[]) => Promise<{ success: boolean; error?: string }>;
    getActive: () => Promise<{ success: boolean; data?: string | null; error?: string }>;
    setActivePointer: (accountId: string | null) => Promise<{ success: boolean; error?: string }>;
    unifiedInbox: (opts: { accountIds: string[]; limit?: number; offset?: number; filter?: ViewFilter; aiCategory?: string }) => Promise<{ success: boolean; data?: { emails: EmailRecord[]; total: number; hasMore: boolean }; error?: string }>;
    unifiedCategoryCounts: (accountIds: string[], mode?: 'unread' | 'total') => Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
    unifiedSearch: (opts: { accountIds: string[]; searchQuery: any; limit?: number; offset?: number }) => Promise<{ success: boolean; data?: EmailRecord[]; error?: string }>;
    unreadSummary: (accountIds: string[]) => Promise<{ success: boolean; data?: Array<{ accountId: string; unread: number }>; error?: string }>;
    backgroundSync: (opts: { accountId: string; config: any }) => Promise<{ success: boolean; data?: { unread: number; skipped?: boolean }; error?: string }>;
  };
  appSettings: {
    /** SYNCHRONOUS — every managed setting as { localStorageKey: rawStringValue }. */
    getAllSync: () => Record<string, string>;
    set: (key: string, value: string) => Promise<{ success: boolean; error?: string }>;
    delete: (key: string) => Promise<{ success: boolean; error?: string }>;
  };
  secureCreds: {
    set: (accountId: string, secrets: SecureAccountSecrets) => Promise<{ success: boolean; encrypted?: boolean; error?: string }>;
    get: (accountId: string) => Promise<{ success: boolean; data?: SecureAccountSecrets | null; error?: string }>;
    delete: (accountId: string) => Promise<{ success: boolean; error?: string }>;
    has: (accountId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    hasPassword: (accountId: string, kind?: 'imap' | 'smtp') => Promise<{ success: boolean; data?: boolean; error?: string }>;
    reveal: (accountId: string, kind?: 'imap' | 'smtp') => Promise<{ success: boolean; data?: { password: string }; error?: string }>;
    available: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
  };
  notifications: {
    setConfig: (config: unknown) => Promise<{ success: boolean; error?: string }>;
    /** `supported: false` = the OS reports notifications unavailable for the app. */
    test: () => Promise<{ success: boolean; supported?: boolean; error?: string }>;
    onOpenEmail: (cb: (data: { accountId: string; emailId: string }) => void) => () => void;
    onInApp: (cb: (data: InAppToast) => void) => () => void;
    onReauthRequired: (cb: (data: { provider: string; email: string; reason: string }) => void) => () => void;
    onReauthResolved: (cb: (data: { provider: string; email: string }) => void) => () => void;
    onReauthOpenSettings: (cb: (data: { provider: string; email: string }) => void) => () => void;
  };
  aiSecrets: {
    getAll: () => Promise<{ success: boolean; data?: Record<string, string>; encrypted?: boolean; error?: string }>;
    set: (providerId: string, apiKey: string) => Promise<{ success: boolean; encrypted?: boolean; error?: string }>;
    delete: (providerId: string) => Promise<{ success: boolean; error?: string }>;
  };
  filters: {
    list: () => Promise<{ success: boolean; data?: FilterRule[]; error?: string }>;
    create: (input: FilterRuleInput) => Promise<{ success: boolean; data?: FilterRule; error?: string }>;
    update: (id: string, updates: Partial<FilterRuleInput>) => Promise<{ success: boolean; data?: FilterRule; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    reorder: (orderedIds: string[]) => Promise<{ success: boolean; error?: string }>;
    applyToExisting: (id: string) => Promise<{ success: boolean; data?: { count: number }; error?: string }>;
    countMatches: (rule: { matchType: 'all' | 'any'; conditions: FilterCondition[] }) => Promise<{ success: boolean; data?: { count: number }; error?: string }>;
  };
  labels: {
    list: (accountId?: string) => Promise<{ success: boolean; data?: Label[]; error?: string }>;
    create: (input: LabelInput, accountId?: string) => Promise<{ success: boolean; data?: Label; error?: string }>;
    update: (id: string, updates: Partial<LabelInput>) => Promise<{ success: boolean; data?: Label; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    setOnEmail: (emailId: string, label: string, on: boolean, accountId?: string) => Promise<{ success: boolean; error?: string }>;
  };
  aiCategorization: {
    start: (config: any, mode: string, options?: any) => Promise<{ success: boolean; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    startAuto: (config: any, options?: any) => Promise<{ success: boolean; error?: string }>;
    stopAuto: () => Promise<{ success: boolean; error?: string }>;
    getStatus: () => Promise<{ success: boolean; data?: { running: boolean; progress: any; autoProcessing: boolean } }>;
    onProgress: (callback: (data: any) => void) => void;
    onComplete: (callback: (data: any) => void) => void;
    onError: (callback: (data: any) => void) => void;
    onLog: (callback: (data: { level: 'info' | 'warn' | 'error'; message: string; ts: number }) => void) => void;
    removeListeners: () => void;
  };
  drafts: {
    save: (draft: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; htmlBody?: string; inReplyTo?: string; threadId?: string; accountEmail?: string; accountId?: string }) =>
      Promise<{ success: boolean; folderPath?: string; messageId?: string; error?: string }>;
    delete: (options: { messageId?: string; subject?: string; to?: string; threadId?: string; accountId?: string; savedAt?: number }) =>
      Promise<{ success: boolean; error?: string }>;
    getFolder: (accountId?: string) => Promise<{ success: boolean; data?: string | null; error?: string }>;
    debug: (event: string, data?: Record<string, unknown>) => Promise<{ success: boolean }>;
    cleanup: (opts: { sinceMs?: number; beforeMs?: number; accountId?: string }) => Promise<{ success: boolean; results: Array<{ accountId?: string; dbFile?: string; localDeleted?: number; imapDeleted?: number; error?: string }> }>;
    onRemoved: (callback: (data: { threadId: string; messageIds: string[] }) => void) => () => void;
    findForThread: (messageIds: string[], accountId?: string) => Promise<{
      success: boolean;
      data?: {
        id: string; messageId: string; threadId: string; subject: string;
        fromAddress: string; toAddress: string; ccAddress: string;
        date: number; cleanBody: string; rawBody: string;
        inReplyTo: string; tags: string;
      } | null;
      error?: string;
    }>;
  };
  agent: {
    logAction: (emailId: string, actionType: string, options?: {
      threadId?: string; actionValue?: string; source?: string; senderAddress?: string;
    }) => Promise<{ success: boolean; error?: string }>;
    logActionBatch: (actions: Array<{
      emailId: string; actionType: string; threadId?: string; actionValue?: string; source?: string; senderAddress?: string;
    }>) => Promise<{ success: boolean; count?: number; error?: string }>;
    getRecentActions: (limit?: number, since?: number) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getActionsByEmail: (emailId: string) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getActionStats: (since?: number) =>
      Promise<{ success: boolean; data?: any; error?: string }>;
    getPendingDecisions: () =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    resolveDecision: (decisionId: string, status: string, actualAction?: string, feedback?: string) =>
      Promise<{ success: boolean; error?: string }>;
    getDecisionHistory: (limit?: number, offset?: number) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getDecisionAccuracy: (since?: number) =>
      Promise<{ success: boolean; data?: { total: number; approved: number; rejected: number; accuracy: number }; error?: string }>;
    getSenderPattern: (senderEmail: string) =>
      Promise<{ success: boolean; data?: any; error?: string }>;
    getSenderTiers: () =>
      Promise<{ success: boolean; data?: { vip: string[]; noise: string[]; regular: string[] }; error?: string }>;
    getPeakHours: () =>
      Promise<{ success: boolean; data?: number[]; error?: string }>;
    predictAction: (senderAddress: string) =>
      Promise<{ success: boolean; data?: { action: string; confidence: number } | null; error?: string }>;
    getSenderMetrics: (senderEmail: string, days?: number) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getTopSenders: (actionType: string, limit?: number, since?: number) =>
      Promise<{ success: boolean; data?: { email: string; count: number }[]; error?: string }>;
    getPipelineEvents: (eventType?: string, limit?: number, since?: number) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    // Contact classification
    setContactType: (email: string, contactType: string, source?: string) =>
      Promise<{ success: boolean; error?: string }>;
    autoClassifyContacts: (userEmail: string) =>
      Promise<{ success: boolean; data?: { classified: number }; error?: string }>;
    getContactsByType: (contactType: string, options?: { limit?: number; offset?: number; search?: string }) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    getContactTypeCounts: () =>
      Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
    getContactsNeedingResponse: (limit?: number) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    refreshNeedsResponse: () =>
      Promise<{ success: boolean; data?: { updated: number }; error?: string }>;
    getWaitingActions: (limit?: number) =>
      Promise<{ success: boolean; data?: any[]; error?: string }>;
    // Agent service
    getConfig: () => Promise<{ success: boolean; data?: any; error?: string }>;
    setConfig: (config: any) => Promise<{ success: boolean; error?: string }>;
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    isReady: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    getBehaviorProfile: () => Promise<{ success: boolean; data?: any; error?: string }>;
    getReplyStyleProfile: () => Promise<{ success: boolean; data?: any; error?: string }>;
    generateReply: (emailId: string) => Promise<{ success: boolean; data?: { subject: string; body: string; confidence: number } | null; error?: string }>;
    getProposals: () => Promise<{ success: boolean; data?: any[]; error?: string }>;
    resolveProposal: (proposalId: string, approved: boolean, actualAction?: string, feedback?: string) =>
      Promise<{ success: boolean; error?: string }>;
    getAccuracyMetrics: (days?: number) =>
      Promise<{ success: boolean; data?: { total: number; approved: number; rejected: number; accuracy: number }; error?: string }>;
    onNewProposal: (callback: (proposal: any) => void) => void;
    onExecuteAction: (callback: (data: { emailId: string; action: string; value?: string }) => void) => void;
    onDraftReady: (callback: (data: { emailId: string; decisionId: string; draftBody: string }) => void) => (() => void);
    onPipelineStats: (callback: (data: { extractionPending?: number; agentPending?: number }) => void) => (() => void);
    removeAgentListeners: () => void;
    // Methods exposed at runtime via the agent block of contextBridge
    // but missing from this type surface. Loosely typed since callers
    // treat the payload as opaque dashboard data.
    scoreWaitingEmails: (limit?: number) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    getLearningSummary: () => Promise<{ success: boolean; data?: any; error?: string }>;
    getPipelineStats: () => Promise<{ success: boolean; data?: any; error?: string }>;
    getCategoryReadiness: () => Promise<{ success: boolean; data?: any; error?: string }>;
    undoAction: (actionId: string) => Promise<{ success: boolean; error?: string }>;
    setCategoryLabels: (cfg: { enabled: boolean; folderMode: 'copy' | 'move' }) => Promise<{ success: boolean; error?: string }>;
    syncCategoryLabels: (limit?: number) => Promise<{ success: boolean; data?: { accounts: number; labeled: number }; error?: string }>;
    removeCategoryLabels: () => Promise<{ success: boolean; data?: { accounts: number; removed: number }; error?: string }>;
    setAIConfig: (config: {
      type: string;
      apiKey: string;
      model: string;
      baseUrl?: string;
      authMethod?: 'apiKey' | 'oauth';
      oauthProvider?: 'sarv';
      oauthEmail?: string;
    }) => Promise<{ success: boolean; error?: string }>;
    onEmailProcessed: (callback: (data: { emailId: string; categories?: string[] }) => void) => () => void;
    onPipelineAIStatus: (callback: (data: { available: boolean; reason: string }) => void) => () => void;
  };
  oauth: {
    listProviders: () => Promise<{
      success: boolean;
      data?: Array<{ id: 'gmail' | 'microsoft' | 'yahoo' | 'sarv'; label: string; purpose: 'email' | 'llm' | 'both'; configured: boolean; imapHost: string | null; smtpHost: string | null; llmBaseUrl: string | null; apiBaseUrl: string | null; edgeBaseUrl: string | null }>;
      error?: string;
    }>;
    startFlow: (providerId: 'gmail' | 'microsoft' | 'yahoo' | 'sarv') => Promise<{
      success: boolean;
      data?: { provider: 'gmail' | 'microsoft' | 'yahoo' | 'sarv'; purpose: 'email' | 'llm' | 'both'; email: string; displayName?: string; imap: { host: string; port: number; secure: boolean } | null; smtp: { host: string; port: number; secure: boolean } | null; llmBaseUrl: string | null; apiBaseUrl: string | null; edgeBaseUrl: string | null; scopes: string[] };
      error?: string;
    }>;
    cancel: () => Promise<{ success: boolean; error?: string }>;
    listAccounts: () => Promise<{
      success: boolean;
      data?: Array<{ provider: 'gmail' | 'microsoft' | 'yahoo' | 'sarv'; email: string; displayName?: string; scopes: string[]; createdAt: number; updatedAt: number }>;
      error?: string;
    }>;
    listReauthRequired: () => Promise<{
      success: boolean;
      data?: Array<{ provider: 'gmail' | 'microsoft' | 'yahoo' | 'sarv'; email: string; reason: string; since: string }>;
      error?: string;
    }>;
    signOut: (providerId: 'gmail' | 'microsoft' | 'yahoo' | 'sarv', email: string) =>
      Promise<{ success: boolean; error?: string }>;
    getAccessToken: (providerId: 'gmail' | 'microsoft' | 'yahoo' | 'sarv', email: string) =>
      Promise<{ success: boolean; data?: { accessToken: string }; error?: string }>;
  };
  extensions: {
    list: () => Promise<{ success: boolean; data?: InstalledExtension[]; error?: string }>;
    getInfo: (extensionId: string) => Promise<{ success: boolean; data?: ExtensionInfo; error?: string }>;
    enable: (extensionId: string) => Promise<{ success: boolean; error?: string }>;
    disable: (extensionId: string) => Promise<{ success: boolean; error?: string }>;
    uninstall: (extensionId: string) => Promise<{ success: boolean; error?: string }>;
    selectAndInstall: () => Promise<{ success: boolean; data?: InstalledExtension; error?: string }>;
    getWorkflows: () => Promise<{ success: boolean; data?: string[]; error?: string }>;
    browse: (options?: { force?: boolean }) =>
      Promise<{ success: boolean; data?: MarketplaceCatalog; error?: string }>;
    registryDetail: (extensionId: string) =>
      Promise<{ success: boolean; data?: MarketplaceExtensionDetail; error?: string }>;
    installFromRegistry: (extensionId: string, permissions: string[]) =>
      Promise<{ success: boolean; data?: { id: string; version: string }; error?: string }>;
    getRegistries: () =>
      Promise<{ success: boolean; data?: { registries: string[]; systemExtensions: string[] }; error?: string }>;
    listPanels: () => Promise<{ success: boolean; data?: AvailablePanel[]; error?: string }>;
    panelRequest: (
      extensionId: string,
      payload: unknown,
      context?: { currentMessageId?: string },
    ) => Promise<PanelResponse>;
    onNotify: (callback: (card: ExtensionNotificationCard) => void) => () => void;
    onDismiss: (callback: (payload: { id: string; extensionId: string }) => void) => () => void;
    onOpenPanel: (callback: (payload: { extensionId: string; panelId: string }) => void) => () => void;
    onOpenMessage: (
      callback: (payload: { extensionId: string; emailId: string; accountId?: string }) => void,
    ) => () => void;
    cardAction: (
      notificationId: string,
      action: {
        action: 'copy' | 'dismiss' | 'expire' | 'open';
        fieldIndex?: number;
        fieldLabel?: string;
        emailId?: string;
        accountId?: string;
      },
    ) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    // Extension capability calls
    invoke: <T = unknown>(capability: string, ...args: unknown[]) => Promise<{
      success: boolean;
      data?: { served: true; extensionId: string; value: T } | { served: false };
      error?: string;
    }>;
    capabilities: () => Promise<{
      success: boolean;
      data?: { id: string; extensionId: string; description?: string }[];
      error?: string;
    }>;
    isAvailable: (extensionId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    // AI bridge for extension backend
    onAICompleteRequest: (callback: (request: { requestId: string; systemPrompt: string; userPrompt: string; maxTokens?: number }) => void) => void;
    sendAICompleteResponse: (response: { requestId: string; success: boolean; result?: string; error?: string }) => void;
    removeAICompleteListener: () => void;
  };
  log: {
    forward: (record: { level: string; name: string; text: string }) => void;
  };
}

/**
 * Signature pattern - stores HTML selector to identify signature elements
 */
export interface SignaturePattern {
  id: string;
  email: string;
  /** CSS selector or HTML element pattern (e.g., "div.gmail_signature", "table.sig") */
  htmlSelector: string;
  /** Sample HTML of the signature element */
  sampleHtml: string | null;
  /** Email IDs where this pattern was found */
  emailIds: string[];
  confidence: 'high' | 'medium' | 'low';
  usageCount: number;
  lastUsed: number;
  createdAt: number;
}

/**
 * Authentication status for email
 */
export interface AuthStatus {
  spf: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'unknown';
  dkim: 'pass' | 'fail' | 'none' | 'unknown';
  dmarc: 'pass' | 'fail' | 'none' | 'unknown';
  overall: 'pass' | 'partial' | 'fail' | 'none';
}

/**
 * Importance factor contributing to score
 */
export interface ImportanceFactor {
  name: string;
  weight: number;
  reason: string;
}

/**
 * Result of importance calculation
 */
export interface ImportanceResult {
  score: number;
  factors: ImportanceFactor[];
  isImportant: boolean;
  authStatus: AuthStatus;
}

/**
 * Sender statistics for tracking interactions
 */
export interface SenderStats {
  id: string;
  email: string;
  domain: string;
  receivedCount: number;
  repliedCount: number;
  sentToCount: number;
  readCount: number;
  deletedCount: number;
  firstSeen: number;
  lastReceived: number | null;
  lastReplied: number | null;
  lastSentTo: number | null;
  reputationScore: number;
  isVip: boolean;
  isBlocked: boolean;
  authPassCount: number;
  authFailCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Snoozed email record
 */
export interface SnoozedEmail {
  id: string;
  emailId: string;
  threadId: string | null;
  snoozeUntil: number;
  originalFolderId: string;
  originalTags: string;
  createdAt: number;
}

/**
 * AI category counts
 */
export interface AICategoryCounts {
  important: number;
  reminders: number;
  waitingReply: number;
  needsResponse: number;
  meeting: number;
  invoice: number;
}

/**
 * Search query structure for AI search
 */
export interface SearchQuery {
  from?: string;
  to?: string;
  subject?: string;
  hasAttachments?: boolean;
  isUnread?: boolean;
  isFlagged?: boolean;
  dateFrom?: number;
  dateTo?: number;
  textQuery?: string;
  labels?: string[];
  folderId?: string;  // Restrict search to specific folder
  aiCategory?: string; // Restrict search to AI category
}

/**
 * Thread summary record
 */
export interface ThreadSummaryRecord {
  id?: string;
  threadId: string;
  summary: string;
  keyPoints: string[];
  participants: string[];
  lastEmailDate: number;
  emailCount: number;
  processedAt: number;
  modelUsed?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Email AI category
 */
export interface EmailAICategory {
  id?: string;
  emailId: string;
  threadId?: string | null;
  isSpam: boolean;
  isImportant: boolean;
  isReminder: boolean;
  isWaitingReply: boolean;
  isNeedsResponse: boolean;
  isMeetingRelated: boolean;
  isInvoiceBilling: boolean;
  reasoning?: string | null;
  confidence: number;
  processedAt: number;
  modelUsed?: string | null;
}

/**
 * Spammer record for tracking blocked senders
 */
export interface SpammerRecord {
  id?: string;
  email: string;
  domain?: string | null;
  name?: string | null;
  reason?: string | null;
  reportedCount: number;
  firstReportedAt: number;
  lastReportedAt: number;
  createdAt?: number;
}

/**
 * A send sitting in the SMTP outbox (pending or dead-lettered).
 */
export interface OutboxSend {
  id: number;
  to: string;
  subject: string;
  status: string; // 'pending' | 'executing' | 'failed'
  retryCount: number;
  lastError: string | null;
  nextRetryAt: number | null;
  createdAt: number;
}

/** Metadata for one attachment on a queued send (bytes stripped). */
export interface OutboxAttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

/** Full stored content of a queued/failed send, for the Outbox preview. */
export interface OutboxPreview {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  htmlBody: string;
  status: string;
  lastError: string | null;
  createdAt: number;
  attachments: OutboxAttachmentMeta[];
}

/** Outcome the main process reports after a manual single-send retry. */
export interface OutboxRetryResult {
  outcome: 'sent' | 'queued' | 'failed';
  connected: boolean;
  lastError: string | null;
  drained: { sent: number; queued: number; failed: number };
}

/**
 * A dead-lettered IMAP operation (flag/move/delete that exhausted retries).
 */
export interface FailedOperation {
  id: number;
  type: string;
  folderPath: string;
  uid: number;
  status: string;
  retryCount: number;
  lastError: string | null;
  createdAt: number;
}

/**
 * Installed extension record
 */
export interface InstalledExtension {
  id: string;
  source: 'builtin' | 'local' | 'marketplace';
  path: string;
  version: string;
  installedAt: number;
  enabled: boolean;
  grantedPermissions: string[];
  settings: Record<string, unknown>;
}

/**
 * A card an extension asked the app to show.
 *
 * Structurally identical to core's `SanitizedExtensionNotification`, restated
 * here because the preload bundle is standalone and must not pull the core
 * package into the sandboxed context. `id` is already namespaced by extension,
 * so two extensions cannot replace or dismiss each other's cards.
 */
export interface ExtensionNotificationField {
  label: string;
  value: string;
  copyable?: boolean;
  emphasis?: boolean;
}

export interface ExtensionNotificationCard {
  id: string;
  extensionId: string;
  title: string;
  body?: string;
  fields?: ExtensionNotificationField[];
  /** UTC epoch ms after which the card is useless; rendered as a countdown. */
  expiresAt?: number;
  timeoutMs?: number;
  emailId?: string;
  accountId?: string;
}

/**
 * Extension manifest
 */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  builtin?: boolean;
}

/**
 * Extension runtime info
 */
/**
 * What a registry offers, as the Browse tab sees it.
 *
 * Structurally identical to core's `CatalogItem` / the marketplace service's
 * `MarketplaceCatalog`, restated here for the same reason as the types above:
 * the preload bundle is standalone and must not pull core into the sandboxed
 * context.
 */
export interface MarketplaceCatalogItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license?: string;
  keywords: string[];
  homepage?: string;
  iconUrl?: string;
  readmeUrl?: string;
  engineRange?: string;
  permissions: string[];
  /** Bytes of the release archive, shown on the card without a detail fetch. */
  size: number;
  /**
   * How to fetch and verify the archive. Absent on a thin registry index until
   * `registryDetail` has been read for this extension.
   */
  download?: { url: string; sha256: string; size: number; publishedAt?: string; releaseTag?: string };
  stats: { downloads: number; rating?: number; ratingCount?: number };
  sourceUrl: string;
  state: 'available' | 'installed' | 'update-available' | 'incompatible';
  installedVersion?: string;
  enabled?: boolean;
  incompatibleReason?: string;
}

/**
 * One extension's full registry record, download block included.
 *
 * A thin index leaves the download URL and the digest out of the list, so the
 * permission prompt - which shows the checksum the archive is checked against -
 * has to ask for them for the one extension the user chose.
 */
export interface MarketplaceExtensionDetail {
  id: string;
  version: string;
  size: number;
  license?: string;
  homepage?: string;
  readmeUrl?: string;
  download: { url: string; sha256: string; size: number; publishedAt?: string; releaseTag?: string };
}

export interface MarketplaceRegistryStatus {
  url: string;
  source: string | null;
  stars: number;
  generatedAt: string | null;
  ok: boolean;
  error?: string;
  fromCache: boolean;
}

export interface MarketplaceCatalog {
  items: MarketplaceCatalogItem[];
  registries: MarketplaceRegistryStatus[];
  fetchedAt: number;
}

export interface ExtensionInfo {
  manifest: ExtensionManifest | null;
  state: string;
  enabled: boolean;
  path: string;
  error?: string;
  activatedAt?: number;
  workflowIds: string[];
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
