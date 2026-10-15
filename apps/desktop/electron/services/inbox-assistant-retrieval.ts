import type { ContactRecord, EmailRecord, FolderRecord, SearchQuery } from '@sarvinbox/core';
import { htmlToPlainText, parseAddresses, parseAttachmentNames, stripQuotedTail, waitForAbortableOperation } from '@sarvinbox/core';
import type { SQLiteStorage } from '@sarvinbox/storage-node';

import type { InboxAssistantAccount, InboxAssistantAccountCoverage, InboxAssistantEvidence, InboxAssistantProgress } from '../../src/types/inbox-assistant';

import type { AssistantAttachmentResult } from './assistant-attachment-types';
import type { InboxAssistantSearchPlan } from './inbox-assistant-answer';

export type AssistantResearchStorage = Pick<SQLiteStorage,
  'getFolders' | 'searchEmails' | 'getEmail' | 'getContacts' | 'getAttachments'>;

export interface AssistantResearchMailbox {
  storage: AssistantResearchStorage;
  aliases: string[];
  fetchBody?: (email: EmailRecord, folder: FolderRecord, options?: { signal?: AbortSignal }) => Promise<EmailRecord | null>;
}

export interface AssistantResearchDeps {
  openMailbox(accountId: string): Promise<AssistantResearchMailbox>;
  readAttachment(ref: { accountId: string; emailId: string; filename: string }, options: { signal?: AbortSignal; onProgress?: (progress: InboxAssistantProgress) => void }): Promise<AssistantAttachmentResult>;
}

export interface InboxAssistantResearchOptions {
  onProgress?: (progress: InboxAssistantProgress) => void;
  sourceRefs?: Array<{ accountId: string; emailId: string }>;
}

export interface InboxAssistantResearch {
  evidence: InboxAssistantEvidence[];
  coverage: InboxAssistantAccountCoverage[];
}

const QUERY_LIMIT = 61;
const MAX_MESSAGES_PER_ACCOUNT = 24;
const MAX_EVIDENCE_CHARS = 110_000;
const MAX_ATTACHMENT_FILES = 12;
const MAX_FILES_PER_MESSAGE = 6;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_SEGMENTS_PER_FILE = 12;
const EXCLUDED_ROLES = new Set(['\\drafts', '\\junk', '\\trash']);
const SENT_NAMES = new Set(['sent', 'sent items', 'sent mail', '[gmail]/sent mail']);

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Search cancelled.');
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, limit);
}

function addresses(value: string | null): string[] {
  return parseAddresses(value ?? '').map(address => address.toLowerCase());
}

function isExcluded(email: EmailRecord, folders: FolderRecord[]): boolean {
  if (/\|(?:draft|deleted|outbox|queued|Trash|Spam|Drafts|Junk|Junk Email|Deleted Items)\|/i.test(email.tags)) return true;
  return folders.some(folder => EXCLUDED_ROLES.has((folder.specialUse ?? '').toLowerCase())
    && (folder.id === email.folderId || email.tags.includes(`|${folder.path}|`)));
}

function isSent(email: EmailRecord, folders: FolderRecord[], aliases: string[]): boolean {
  return aliases.includes(email.fromAddress.toLowerCase()) || folders.some(folder =>
    ((folder.specialUse ?? '').toLowerCase() === '\\sent' || SENT_NAMES.has(folder.path.toLowerCase()))
      && (folder.id === email.folderId || email.tags.includes(`|${folder.path}|`)));
}

function matchesFilters(email: EmailRecord, plan: InboxAssistantSearchPlan): boolean {
  const { filters } = plan;
  if (filters.after && email.date < Date.parse(`${filters.after}T00:00:00Z`) / 1000) return false;
  if (filters.before && email.date >= Date.parse(`${filters.before}T00:00:00Z`) / 1000) return false;
  if (filters.from && !`${email.fromAddress} ${email.fromName ?? ''}`.toLowerCase().includes(filters.from.toLowerCase())) return false;
  if (filters.to && !(email.toAddress ?? '').toLowerCase().includes(filters.to.toLowerCase())) return false;
  if (typeof filters.hasAttachment === 'boolean' && (email.hasAttachments || parseAttachmentNames(email.attachmentNames).length > 0) !== filters.hasAttachment) return false;
  return true;
}

function contactTerms(contacts: ContactRecord[]): string[] {
  return contacts.flatMap(contact => [contact.email, contact.enrichment?.companyDomain ?? ''])
    .filter(value => value.includes('@') || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value));
}

function planFilters(plan: InboxAssistantSearchPlan): Pick<SearchQuery, 'dateFrom' | 'dateTo' | 'from' | 'to' | 'hasAttachments'> {
  return {
    ...(plan.filters.after ? { dateFrom: Date.parse(`${plan.filters.after}T00:00:00Z`) / 1000 } : {}),
    ...(plan.filters.before ? { dateTo: Date.parse(`${plan.filters.before}T00:00:00Z`) / 1000 - 1 } : {}),
    ...(plan.filters.from ? { from: plan.filters.from } : {}),
    ...(plan.filters.to ? { to: plan.filters.to } : {}),
    ...(typeof plan.filters.hasAttachment === 'boolean' ? { hasAttachments: plan.filters.hasAttachment } : {}),
  };
}

/** Account/folder scope is enforced here, independently of the AI's search hints. */
export async function researchInboxAssistant(
  accounts: InboxAssistantAccount[], plan: InboxAssistantSearchPlan,
  deps: AssistantResearchDeps, signal?: AbortSignal, options: InboxAssistantResearchOptions = {},
): Promise<InboxAssistantResearch> {
  const evidence: InboxAssistantEvidence[] = [];
  const coverage: InboxAssistantAccountCoverage[] = [];
  let totalChars = 0;
  let filesRead = 0;
  const progress = (value: InboxAssistantProgress) => {
    if (signal?.aborted) return;
    options.onProgress?.(value);
  };
  for (const account of accounts) {
    checkAbort(signal);
    const covered: InboxAssistantAccountCoverage = {
      accountId: account.id, email: account.email, status: 'searched', matchedMessages: 0,
      reviewedMessages: 0, missingBodies: 0, attachmentsRead: 0, attachmentsSkipped: 0,
      truncated: false, warnings: [],
    };
    coverage.push(covered);
    // Reserve evidence space and extraction work for every selected account.
    // A busy first account must not consume the entire answer context.
    const accountCharEnd = Math.min(MAX_EVIDENCE_CHARS, totalChars + Math.floor(MAX_EVIDENCE_CHARS / accounts.length));
    const accountFileLimit = Math.max(1, Math.floor(MAX_ATTACHMENT_FILES / accounts.length));
    let accountFilesRead = 0;
    const downloadBudgetMs = Math.min(180_000, Math.floor(240_000 / accounts.length));
    let downloadSpentMs = 0;
    let downloadLimitReported = false;
    const reportDownloadLimit = () => {
      covered.truncated = true;
      if (!downloadLimitReported) {
        downloadLimitReported = true;
        covered.warnings.push('The download time limit was reached for this account. Cached content was still reviewed; other accounts continue.');
        progress({ stage: 'search', status: 'warning', accountId: account.id, message: `Download time limit reached for ${account.email}`, detail: 'Continuing with cached content and the other selected accounts.' });
      }
    };
    const download = async <T>(run: (downloadSignal: AbortSignal) => Promise<T>): Promise<T> => {
      checkAbort(signal);
      const remaining = downloadBudgetMs - downloadSpentMs;
      if (remaining <= 0) { reportDownloadLimit(); throw new Error('Account download time limit reached.'); }
      const controller = new AbortController();
      const downloadSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const started = Date.now();
      const timer = setTimeout(() => {
        downloadSpentMs = downloadBudgetMs;
        controller.abort(new Error('Account download time limit reached.'));
      }, remaining);
      timer.unref?.();
      try {
        return await waitForAbortableOperation(run(downloadSignal), downloadSignal);
      } finally {
        clearTimeout(timer);
        downloadSpentMs = Math.min(downloadBudgetMs, downloadSpentMs + Math.max(0, Date.now() - started));
        if (controller.signal.aborted && !signal?.aborted) reportDownloadLimit();
      }
    };
    try {
      progress({ stage: 'search', status: 'running', accountId: account.id, message: `Searching ${account.email}`, detail: 'Checking Inbox, Sent and archived mail.' });
      const mailbox = await deps.openMailbox(account.id);
      checkAbort(signal);
      const folders = await mailbox.storage.getFolders();
      const aliases = unique([account.email, ...mailbox.aliases].map(value => value.toLowerCase()), 12);
      if (folders.some(folder => folder.syncEnabled !== false && folder.backfillComplete === false)) {
        covered.warnings.push('Older mail is still synchronizing. This answer covers locally searchable mail.');
      }
      const entities = unique(plan.entityTerms, 6);
      const contacts: ContactRecord[] = [];
      for (const term of entities.slice(0, 3)) {
        try { contacts.push(...await mailbox.storage.getContacts({ search: term, limit: 12, offset: 0 })); }
        catch { /* Contact expansion is optional; original search terms remain. */ }
      }
      const queries = unique([...entities, ...plan.queries], 8);
      const participants = unique([...entities.filter(value => value.includes('@') || value.includes('.')), ...contactTerms(contacts)], 8);
      const requests: SearchQuery[] = [];
      const sentFolders = folders.filter(folder => (folder.specialUse ?? '').toLowerCase() === '\\sent' || SENT_NAMES.has(folder.path.toLowerCase()));
      const addRequest = (query: string, extra: Partial<SearchQuery> = {}) => requests.push({
        query, scope: 'mailbox', collapseThreads: false, sortBy: 'date', sortOrder: 'desc',
        limit: QUERY_LIMIT, ...planFilters(plan), ...extra,
      });
      for (const query of queries) {
        if (plan.intent === 'sent') {
          for (const folder of sentFolders.slice(0, 3)) addRequest(query, { folderPath: folder.path });
          for (const alias of aliases.slice(0, 3)) {
            if (!plan.filters.from || plan.filters.from.toLowerCase() === alias) addRequest(query, { from: alias });
          }
        } else addRequest(query);
      }
      for (const participant of participants) {
        if (!plan.filters.to || plan.filters.to.toLowerCase() === participant.toLowerCase()) addRequest('', { to: participant });
        if (plan.intent !== 'sent' && !plan.filters.from) addRequest('', { from: participant });
      }
      const found = new Map<string, EmailRecord>();
      const relevance = new Map<string, number>();
      // Follow-up questions re-read their actual cited messages. A vague phrase
      // such as "read the attached document" must not lose the previous source.
      const pinned = unique((options.sourceRefs ?? []).filter(ref => ref.accountId === account.id).map(ref => ref.emailId), 12);
      if (pinned.length) {
        progress({ stage: 'context', status: 'running', accountId: account.id, message: `Reopening ${pinned.length} previously cited ${pinned.length === 1 ? 'message' : 'messages'}`, detail: account.email });
        let reopened = 0;
        for (const emailId of pinned) {
          checkAbort(signal);
          const email = await mailbox.storage.getEmail(emailId);
          if (!email || isExcluded(email, folders) || !matchesFilters(email, plan) || (plan.intent === 'sent' && !isSent(email, folders, aliases))) continue;
          found.set(email.id, email);
          relevance.set(email.id, 100);
          reopened++;
        }
        progress({ stage: 'context', status: reopened ? 'done' : 'warning', accountId: account.id, message: `Reopened ${reopened} previously cited ${reopened === 1 ? 'message' : 'messages'}`, detail: account.email });
      }
      const requestKeys = new Set<string>();
      for (const request of requests.slice(0, 48)) {
        checkAbort(signal);
        const key = JSON.stringify(request);
        if (requestKeys.has(key)) continue;
        requestKeys.add(key);
        const rows = await mailbox.storage.searchEmails(request);
        if (rows.length >= QUERY_LIMIT) covered.truncated = true;
        for (const email of rows) {
          if (isExcluded(email, folders) || (plan.intent === 'sent' && !isSent(email, folders, aliases))) continue;
          found.set(email.id, email);
          const entityQuery = entities.some(entity => entity.toLowerCase() === request.query.toLowerCase());
          const participantQuery = participants.some(participant => request.to === participant || request.from === participant);
          const quoted = plan.quoteIntent && /quot|proposal|pricing/i.test(`${email.subject ?? ''} ${email.attachmentNames ?? ''}`);
          relevance.set(email.id, Math.max(relevance.get(email.id) ?? 0, (participantQuery ? 20 : entityQuery ? 10 : 0) + (quoted ? 1 : 0)));
        }
        // Release the Electron main loop between synchronous SQLite searches.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      covered.matchedMessages = found.size;
      progress({ stage: 'search', status: 'done', accountId: account.id, message: `Found ${found.size} matching ${found.size === 1 ? 'message' : 'messages'}`, detail: account.email });
      const candidates = [...found.values()].sort((a, b) => (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0) || b.date - a.date);
      if (candidates.length > MAX_MESSAGES_PER_ACCOUNT) covered.truncated = true;
      for (const candidate of candidates.slice(0, MAX_MESSAGES_PER_ACCOUNT)) {
        checkAbort(signal);
        if (totalChars >= accountCharEnd) { covered.truncated = true; break; }
        let email = await mailbox.storage.getEmail(candidate.id);
        if (!email || isExcluded(email, folders) || !matchesFilters(email, plan) || (plan.intent === 'sent' && !isSent(email, folders, aliases))) continue;
        let body = email.cleanBody?.trim() || '';
        if (!body && !email.rawBody && mailbox.fetchBody) {
          const folder = folders.find(item => item.id === email!.folderId);
          if (folder) {
            progress({ stage: 'body', status: 'running', accountId: account.id, emailId: email.id, message: 'Downloading missing email content', detail: email.subject || '(No subject)' });
            try {
              // A foreground fetch can wait behind the engine's body queue;
              // the old 12-second cutoff abandoned legitimate downloads.
              const downloadingEmail = email;
              const downloaded = await download(bodySignal => mailbox.fetchBody!(downloadingEmail, folder, { signal: bodySignal }));
              checkAbort(signal);
              // Body fetch also discovers MIME attachments and can repair UIDs.
              // Refresh the authoritative row before selecting attachments.
              const refreshed = await mailbox.storage.getEmail(email.id);
              if (!refreshed && !downloaded) continue;
              email = refreshed && (refreshed.cleanBody?.trim() || refreshed.rawBody) ? refreshed : downloaded ?? refreshed ?? email;
            }
            catch { /* Report missing body and continue with attachment/header evidence. */ }
          }
          checkAbort(signal);
          body = email.cleanBody?.trim() || '';
        }
        if (isExcluded(email, folders) || !matchesFilters(email, plan) || (plan.intent === 'sent' && !isSent(email, folders, aliases))) continue;
        if (!body && email.rawBody) body = htmlToPlainText(email.rawBody.slice(0, 500_000));
        if (!body) {
          covered.missingBodies++;
          progress({ stage: 'body', status: 'warning', accountId: account.id, emailId: email.id, message: 'Email content could not be downloaded', detail: email.subject || '(No subject)' });
        } else {
          progress({ stage: 'body', status: 'done', accountId: account.id, emailId: email.id, message: 'Email content ready', detail: email.subject || '(No subject)' });
        }
        covered.reviewedMessages++;
        const folder = folders.find(item => item.id === email!.folderId);
        const sent = isSent(email, folders, aliases);
        const ownBody = stripQuotedTail(body).trim() || body;
        const metadata = {
          accountId: account.id, accountEmail: account.email, emailId: email.id,
          threadId: email.threadId, subject: email.subject || '(No subject)',
          from: email.fromAddress, to: addresses(email.toAddress), date: email.date,
          folder: folder?.path ?? '', sent,
        };
        const header = `Subject: ${metadata.subject}\nDate: ${new Date(email.date * 1000).toISOString()}\nFrom: ${metadata.from}\nTo: ${metadata.to.join(', ')}\nDirection: ${sent ? 'Sent by the user' : 'Received'}\n`;
        const allowance = Math.min(MAX_MESSAGE_CHARS, accountCharEnd - totalChars);
        const text = `${header}\n${ownBody}`.slice(0, allowance);
        if (text.length < header.length + ownBody.length) covered.truncated = true;
        evidence.push({ ...metadata, id: `S${evidence.length + 1}`, kind: 'message', text, excerpt: ownBody.slice(0, 1000) });
        totalChars += text.length;

        let names = parseAttachmentNames(email.attachmentNames);
        const declared = await mailbox.storage.getAttachments(email.id);
        names = unique([...names, ...declared.map(item => item.filename)], 500);
        const supported = (name: string) => /\.(?:pdf|docx|xlsx|csv|tsv|txt)$/i.test(name);
        names.sort((a, b) => Number(supported(b)) - Number(supported(a))
          || Number(/quot|proposal|pricing/i.test(b)) - Number(/quot|proposal|pricing/i.test(a)));
        if (names.length > 30) { covered.attachmentsSkipped += names.length - 30; covered.truncated = true; }
        let supportedFiles = 0;
        for (const filename of names.slice(0, 30)) {
          checkAbort(signal);
          // Inline logos and unsupported files do not consume document slots.
          if (!supported(filename)) { covered.attachmentsSkipped++; continue; }
          if (supportedFiles >= MAX_FILES_PER_MESSAGE || filesRead >= MAX_ATTACHMENT_FILES || accountFilesRead >= accountFileLimit || totalChars >= accountCharEnd) {
            covered.attachmentsSkipped++; covered.truncated = true; continue;
          }
          filesRead++;
          accountFilesRead++;
          supportedFiles++;
          try {
            progress({ stage: 'attachment', status: 'running', accountId: account.id, emailId: email.id, filename, message: `Downloading and reading ${filename}`, detail: account.email });
            const ref = { accountId: account.id, emailId: email.id, filename };
            const result = await download(attachmentSignal => deps.readAttachment(ref, {
              signal: attachmentSignal,
              ...(options.onProgress ? { onProgress: (activity: InboxAssistantProgress) => { if (!attachmentSignal.aborted) progress(activity); } } : {}),
            }));
            checkAbort(signal);
            if (result.status !== 'ready' || !result.segments.length) {
              covered.attachmentsSkipped++;
              covered.warnings.push(`${filename}: ${result.message || result.status.replace(/_/g, ' ')}.`);
              progress({ stage: 'attachment', status: 'warning', accountId: account.id, emailId: email.id, filename, message: `${filename} could not be read`, detail: result.message || result.status.replace(/_/g, ' ') });
              continue;
            }
            covered.attachmentsRead++;
            progress({ stage: 'attachment', status: 'done', accountId: account.id, emailId: email.id, filename, message: `Read ${filename}`, detail: `${result.segments.length} text ${result.segments.length === 1 ? 'section' : 'sections'} available${result.truncated ? '; document exceeds the reading limit' : ''}.` });
            if (result.truncated) covered.truncated = true;
            const score = (value: string) => queries.reduce((n, query) => n + (value.toLowerCase().includes(query.toLowerCase()) ? 2 : 0), 0)
              + (plan.quoteIntent && /(?:quot|total|amount|price|INR|USD|₹|\$)/i.test(value) ? 1 : 0);
            const segments = result.segments.map((segment, originalIndex) => ({ ...segment, originalIndex }))
              .sort((a, b) => score(b.text) - score(a.text) || a.originalIndex - b.originalIndex);
            if (segments.length > MAX_SEGMENTS_PER_FILE) covered.truncated = true;
            for (const segment of segments.slice(0, MAX_SEGMENTS_PER_FILE)) {
              const maxChars = Math.min(6000, accountCharEnd - totalChars);
              if (maxChars <= 0) { covered.truncated = true; break; }
              const segmentText = `${header}Attachment: ${filename}\nLocation: ${segment.locator.label}\n\n${segment.text}`.slice(0, maxChars);
              if (segment.text.length > maxChars - header.length) covered.truncated = true;
              evidence.push({ ...metadata, id: `S${evidence.length + 1}`, kind: 'attachment',
                attachmentId: declared.find(item => item.filename === filename)?.id, filename,
                location: segment.locator.label, text: segmentText, excerpt: segment.text.slice(0, 1000),
              });
              totalChars += segmentText.length;
            }
          } catch (error) {
            checkAbort(signal);
            covered.attachmentsSkipped++;
            covered.warnings.push(`${filename}: attachment could not be read.`);
            progress({ stage: 'attachment', status: 'warning', accountId: account.id, emailId: email.id, filename, message: `${filename} could not be downloaded or read` });
          }
        }
      }
      covered.warnings = unique(covered.warnings, 12);
      progress({ stage: 'search', status: 'done', accountId: account.id, message: `Reviewed ${covered.reviewedMessages} emails and ${covered.attachmentsRead} attachments`, detail: account.email });
    } catch (error) {
      checkAbort(signal);
      covered.status = 'unavailable';
      covered.warnings.push('This account could not be fully searched. Its results may be incomplete.');
      progress({ stage: 'search', status: 'warning', accountId: account.id, message: `${account.email} could not be fully searched`, detail: 'Results from this account may be incomplete.' });
    }
  }
  return { evidence, coverage };
}
