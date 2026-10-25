import type { ContactRecord, EmailRecord, FolderRecord, SearchQuery } from '@sarvinbox/core';
import { htmlToPlainText, parseAddresses, parseAttachmentNames, waitForAbortableOperation } from '@sarvinbox/core';
import type { SQLiteStorage } from '@sarvinbox/storage-node';

import type { InboxAssistantAccount, InboxAssistantAccountCoverage, InboxAssistantEvidence, InboxAssistantProgress } from '../../src/types/inbox-assistant';

import type { AssistantAttachmentResult } from './assistant-attachment-types';
import type { InboxAssistantSearchPlan } from './inbox-assistant-answer';
import { matchesInboxAssistantTerm, meaningfulInboxAssistantTerms } from './inbox-assistant-search-scope';

export type AssistantResearchStorage = Pick<SQLiteStorage,
  'getFolders' | 'searchEmails' | 'getEmail' | 'getContacts' | 'getAttachments'>
  & Partial<Pick<SQLiteStorage, 'getEmailsByThread'>>;

export interface AssistantResearchMailbox {
  storage: AssistantResearchStorage;
  aliases: string[];
  fetchBody?: (email: EmailRecord, folder: FolderRecord, options?: { signal?: AbortSignal }) => Promise<EmailRecord | null>;
}

export interface AssistantResearchDeps {
  openMailbox(accountId: string): Promise<AssistantResearchMailbox>;
  readAttachment(ref: { accountId: string; emailId: string; filename: string }, options: { signal?: AbortSignal; onProgress?: (progress: InboxAssistantProgress) => void; allowSecurityPrompt?: boolean; onApprovalWait?: (waiting: boolean) => void }): Promise<AssistantAttachmentResult>;
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
const MAX_THREAD_SEEDS = 8;
const MAX_THREAD_MEMBERS = 120;
const MAX_RAW_BODY_CHARS = 500_000;
const EXCLUDED_ROLES = new Set(['\\drafts', '\\junk', '\\trash']);
const SENT_NAMES = new Set(['sent', 'sent items', 'sent mail', '[gmail]/sent mail']);

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Search cancelled.');
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, limit);
}

/** Full records can still contain a legacy list preview in cleanBody. */
function fullBody(email: EmailRecord): string {
  const clean = email.cleanBody?.trim() || '';
  const raw = email.rawBody?.slice(0, MAX_RAW_BODY_CHARS).trim() || '';
  const plain = raw && email.contentType !== 'text' ? htmlToPlainText(raw).trim() : raw;
  return plain.length > clean.length ? plain : clean;
}

const matchesTerm = matchesInboxAssistantTerm;

function participantText(email: EmailRecord): string {
  return `${email.fromAddress} ${email.fromName ?? ''} ${email.toAddress ?? ''} ${email.toNames ?? ''} ${email.ccAddress ?? ''} ${email.ccNames ?? ''}`;
}

function calendarInvitation(email: EmailRecord): string {
  const ics = email.calendarIcs?.slice(0, 24_000).trim() ?? '';
  return /(?:^|\r?\n)BEGIN:VCALENDAR\b/i.test(ics) && /(?:^|\r?\n)BEGIN:VEVENT\b/i.test(ics) ? ics : '';
}

/** An incidental mention of a past meeting is not an invitation. */
function invitationEvidence(email: EmailRecord, body = fullBody(email)): boolean {
  if (calendarInvitation(email)) return true;
  const subject = email.subject ?? '';
  const commercialInvitation = /\b(?:tender|rfp|rfq|bid|quotation|proposal|procurement)\b/i.test(subject);
  if (/\bmeeting\s+(?:confirmation|invitation|invite)\b/i.test(subject)
    || !commercialInvitation && /^(?:(?:re|fw|fwd):\s*)*(?:invitation|invite)\s*[:|–-]/i.test(subject)
    || /\b(?:invitation|invite)\s+(?:to|for)\s+(?:(?:a|the|our|your)\s+)?(?:meeting|call|demo|discussion|review|webinar)\b/i.test(subject)) return true;
  const bounded = body.slice(0, 12_000);
  const quoted = bounded.search(/\n\s*(?:On [^\n]{1,250}wrote:|[- ]{2,}(?:Original Message|Forwarded Message)[- ]*|From:\s*\S)/i);
  const authored = quoted >= 0 ? bounded.slice(0, quoted) : bounded;
  const invitationWording = (value: string) => /\byou(?:\s+are|['’]re|\s+have been)\s+invited\s+to\s+[^\n.!?]{0,80}\b(?:meeting|call|demo|webinar|review|discussion|session|conference|appointment|sync)\b|\b(?:please\s+)?join\s+(?:us\s+for|the|this|our)\s+(?:(?:scheduled|upcoming)\s+)?(?:meeting|call|demo|webinar|review)\b|\bmeeting\s+(?:invitation|confirmation)\b/i.test(value);
  if (invitationWording(authored)) return true;
  // An intentional forward retains its outer source/date provenance. An old
  // quoted invite below an unrelated pricing follow-up does not qualify.
  const deliberateForward = /^(?:fw|fwd):/i.test(subject) && /\b(?:meetings?|invites?|invitations?|appointments?)\b/i.test(subject)
    || /\bforward(?:ing|ed)?\b[^\n.!?]{0,50}\b(?:meetings?|invites?|invitations?)\b/i.test(authored);
  return deliberateForward && invitationWording(bounded);
}

/** Read the complete body, then retain bounded, explicitly separated excerpts. */
function bodyEvidence(body: string, allowance: number, terms: string[], leadingShare = 0.25): string {
  if (body.length <= allowance) return body;
  if (allowance < 300) return body.slice(0, Math.max(0, allowance));
  const separator = '\n[… additional email content …]\n';
  const available = allowance - separator.length * 3;
  const leadingWindow = Math.max(80, Math.floor(available * leadingShare));
  const window = Math.max(80, Math.floor((available - leadingWindow) / 3));
  const ranges: Array<[number, number]> = [[0, leadingWindow]];
  const matcher = terms.filter(Boolean).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (matcher) {
    const hits = [...body.matchAll(new RegExp(matcher, 'giu'))].slice(0, 100);
    // Commercial figures and submission terms near a topic hit are useful,
    // including when they occur after a long signature or quoted history.
    hits.sort((a, b) => Number(/₹|\b(?:INR|total|bid|price|attached|submitted)\b/i.test(body.slice(Math.max(0, b.index! - 150), b.index! + window)))
      - Number(/₹|\b(?:INR|total|bid|price|attached|submitted)\b/i.test(body.slice(Math.max(0, a.index! - 150), a.index! + window))));
    for (const hit of hits) {
      const start = Math.max(0, hit.index! - Math.floor(window / 3));
      if (ranges.some(([left, right]) => start < right && start + window > left)) continue;
      ranges.push([start, Math.min(body.length, start + window)]);
      if (ranges.length === 3) break;
    }
  }
  // A reply's deployment details or closing answer can precede a long quoted
  // conversation. Preserve that authored ending instead of an old signature.
  // Topic windows above still retain relevant forwarded/quoted material.
  const quotedBoundary = leadingShare > 0.25
    ? body.search(/\n\s*(?:On [^\n]{1,250}wrote:|[- ]{2,}(?:Original Message|Forwarded Message)[- ]*)/i) : -1;
  const tailEnd = quotedBoundary > leadingWindow + window ? quotedBoundary : body.length;
  ranges.push([Math.max(0, tailEnd - window), tailEnd]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged.map(([start, end]) => body.slice(start, end)).join(separator).slice(0, allowance);
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
  const dates = dateFilters(plan);
  if (dates.dateFrom !== undefined && email.date < dates.dateFrom) return false;
  if (dates.dateTo !== undefined && email.date > dates.dateTo) return false;
  if (filters.from && !`${email.fromAddress} ${email.fromName ?? ''}`.toLowerCase().includes(filters.from.toLowerCase())) return false;
  if (filters.to && !(email.toAddress ?? '').toLowerCase().includes(filters.to.toLowerCase())) return false;
  if (typeof filters.hasAttachment === 'boolean' && (email.hasAttachments || parseAttachmentNames(email.attachmentNames).length > 0) !== filters.hasAttachment) return false;
  return true;
}

function contactTerms(contacts: ContactRecord[]): string[] {
  return contacts.flatMap(contact => [contact.email, contact.enrichment?.companyDomain ?? ''])
    .filter(value => value.includes('@') || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value));
}

function dateFilters(plan: InboxAssistantSearchPlan): Pick<SearchQuery, 'dateFrom' | 'dateTo'> {
  const window = plan.scope?.timeWindow;
  if (window) return { dateFrom: window.dateFrom, dateTo: window.dateTo };
  return {
    ...(plan.filters.after ? { dateFrom: Date.parse(`${plan.filters.after}T00:00:00Z`) / 1000 } : {}),
    ...(plan.filters.before ? { dateTo: Date.parse(`${plan.filters.before}T00:00:00Z`) / 1000 - 1 } : {}),
  };
}

function planFilters(plan: InboxAssistantSearchPlan): Pick<SearchQuery, 'dateFrom' | 'dateTo' | 'from' | 'to' | 'hasAttachments'> {
  return {
    ...dateFilters(plan),
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
    const download = async <T>(run: (downloadSignal: AbortSignal, approvalWait: (waiting: boolean) => void) => Promise<T>): Promise<T> => {
      checkAbort(signal);
      const remaining = downloadBudgetMs - downloadSpentMs;
      if (remaining <= 0) { reportDownloadLimit(); throw new Error('Account download time limit reached.'); }
      const controller = new AbortController();
      const downloadSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let activeMs = 0;
      let activeSince = Date.now();
      let awaitingApproval = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        timer = setTimeout(() => {
          downloadSpentMs = downloadBudgetMs;
          controller.abort(new Error('Account download time limit reached.'));
        }, Math.max(0, remaining - activeMs));
        timer.unref?.();
      };
      const approvalWait = (waiting: boolean) => {
        if (waiting === awaitingApproval || downloadSignal.aborted) return;
        if (!awaitingApproval) activeMs += Math.max(0, Date.now() - activeSince);
        if (timer) clearTimeout(timer);
        awaitingApproval = waiting;
        activeSince = Date.now();
        // User consent is not network/extraction work. The request and security
        // gate retain their absolute cancellation/deadline protections.
        if (!waiting) arm();
      };
      arm();
      try {
        return await waitForAbortableOperation(run(downloadSignal, approvalWait), downloadSignal);
      } finally {
        if (timer) clearTimeout(timer);
        if (!awaitingApproval) activeMs += Math.max(0, Date.now() - activeSince);
        downloadSpentMs = Math.min(downloadBudgetMs, downloadSpentMs + activeMs);
        if (controller.signal.aborted && !signal?.aborted) reportDownloadLimit();
      }
    };
    try {
      progress({ stage: 'search', status: 'running', accountId: account.id, message: `Searching ${account.email}`, detail: `Checking Inbox, Sent and archived mail.${plan.scope?.timeWindow ? ` Message date range: ${plan.scope.timeWindow.label}.` : ''}` });
      const mailbox = await deps.openMailbox(account.id);
      checkAbort(signal);
      const folders = await mailbox.storage.getFolders();
      const aliases = unique([account.email, ...mailbox.aliases].map(value => value.toLowerCase()), 12);
      const ownDomains = new Set(aliases.map(value => value.slice(value.lastIndexOf('@') + 1)).filter(Boolean));
      const ownIdentityTerms = new Set([...ownDomains].flatMap(domain => [domain, ...domain.split('.').slice(0, -1).filter(label => label.length > 2)]));
      const ownIdentityTopic = (term: string) => ownIdentityTerms.has(term.toLowerCase().replace(/^@/, ''));
      const withoutOwnAddresses = (value: string) => {
        const parts: string[] = [];
        let cursor = 0;
        // Start at literal @ characters rather than repeatedly scanning long
        // attacker-controlled words for a possible mailbox suffix.
        for (const match of value.matchAll(/@([\p{L}\p{N}.-]{1,253})/gu)) {
          const domain = match[1]!.replace(/\.+$/, '');
          if (!ownDomains.has(domain.toLowerCase())) continue;
          let start = match.index!;
          while (start > cursor && /[\p{L}\p{N}._%+-]/u.test(value[start - 1]!)) start--;
          parts.push(value.slice(cursor, start));
          cursor = match.index! + 1 + domain.length;
        }
        return parts.length ? parts.join('') + value.slice(cursor) : value;
      };
      if (folders.some(folder => folder.syncEnabled !== false && folder.backfillComplete === false)) {
        covered.warnings.push('Older mail is still synchronizing. This answer covers locally searchable mail.');
      }
      const entities = meaningfulInboxAssistantTerms(plan.scope?.meetingIntent
        ? plan.scope.topicTerms.filter(term => term !== 'meeting') : plan.entityTerms).slice(0, 6);
      const plannedTopics = plan.scope?.meetingIntent ? plan.scope.topicTerms : plan.topicTerms?.length
        ? plan.topicTerms : entities.filter(term => !plan.participantTerms?.some(person => person.toLowerCase() === term.toLowerCase()));
      const topics = meaningfulInboxAssistantTerms(plannedTopics.length ? plannedTopics : plan.queries).slice(0, 6);
      const people = unique(plan.participantTerms ?? [], 6);
      const customerProductAnchors = unique(meaningfulInboxAssistantTerms([...topics, ...entities, ...plan.queries])
        .filter(term => !ownIdentityTopic(term)), 12);
      const requireCustomerProduct = !plan.scope?.meetingIntent && topics.some(ownIdentityTopic) && customerProductAnchors.length > 0;
      const requiredTopicGroups = (plan.requiredTopicGroups ?? []).map(group => unique(group.map(term =>
        term.split(/\s+/).filter(word => !ownIdentityTopic(word)).join(' ')), 6)).filter(group => group.length);
      const contacts: ContactRecord[] = [];
      for (const term of entities.slice(0, 3)) {
        try { contacts.push(...await mailbox.storage.getContacts({ search: term, limit: 12, offset: 0 })); }
        catch { /* Contact expansion is optional; original search terms remain. */ }
      }
      const queries = plan.scope?.meetingIntent ? unique(plan.scope.queryTerms, 8)
        : unique(topics.length
          ? [...topics, ...meaningfulInboxAssistantTerms(plan.queries).filter(query => topics.some(topic => matchesTerm(query, topic)))]
          : [...entities, ...meaningfulInboxAssistantTerms(plan.queries)], 8);
      const participants = unique([...people, ...entities.filter(value => value.includes('@') || value.includes('.')), ...contactTerms(contacts)], 12);
      const requests: SearchQuery[] = [];
      const requestKeys = new Set<string>();
      const addRequest = (query: string, extra: Partial<SearchQuery> = {}) => {
        const request: SearchQuery = { query, scope: 'mailbox', collapseThreads: false, sortBy: 'date', sortOrder: 'desc',
          limit: QUERY_LIMIT, ...planFilters(plan), ...extra };
        const key = JSON.stringify(request);
        if (!requestKeys.has(key)) { requestKeys.add(key); requests.push(request); }
      };
      if (requiredTopicGroups.length > 1) addRequest(requiredTopicGroups.map(group => group[0]).join(' ').slice(0, 160));
      for (const query of queries) {
        // Mailbox scope already searches Inbox, Sent and Archive. Repeating
        // every query per alias/folder starved later participant searches.
        addRequest(query);
      }
      if (!queries.length && plan.scope?.timeWindow) addRequest('');
      // Calendar MIME data is not indexed as body text. Inspect one bounded
      // local-date page to discover generic-subject invites without fetching
      // unrelated missing bodies or searching all time.
      if (plan.scope?.invitationIntent && plan.scope.timeWindow) addRequest('');
      for (const participant of participants) {
        // Keep participant discovery inside the project. A generic sender or
        // company match must not consume the result window with other work.
        for (const topic of topics.length ? topics.slice(0, 3) : ['']) {
          if (!plan.filters.to || plan.filters.to.toLowerCase() === participant.toLowerCase()) addRequest(topic, { to: participant });
          if (plan.intent !== 'sent' && !plan.filters.from) addRequest(topic, { from: participant });
        }
      }
      const found = new Map<string, EmailRecord>();
      const relevance = new Map<string, number>();
      const pinnedIds = new Set<string>();
      const expandedThreads = new Set<string>();
      const eligible = (email: EmailRecord) => !isExcluded(email, folders) && matchesFilters(email, plan)
        && (plan.intent !== 'sent' || isSent(email, folders, aliases));
      const score = (email: EmailRecord, body = fullBody(email), threadMatch = false): number => {
        const header = `${email.subject ?? ''} ${email.attachmentNames ?? ''} ${participantText(email)}`;
        const subject = `${email.subject ?? ''} ${email.attachmentNames ?? ''}`;
        const content = `${body}\n${plan.scope?.invitationIntent ? calendarInvitation(email) : ''}`;
        // The user's own company/domain occurs on nearly every mail header and
        // in quoted signatures. It is identity metadata, not proof that an
        // otherwise unrelated message concerns the requested customer/product.
        // Keep actual brand prose and explicit full-address searches intact.
        const identityNeutralContent = withoutOwnAddresses(content);
        const topicInHeader = (term: string) => matchesTerm(ownIdentityTopic(term) ? subject : header, term);
        const topicInBody = (term: string) => matchesTerm(ownIdentityTopic(term) ? identityNeutralContent : content, term);
        const searchable = `${header}\n${content}`;
        const invited = plan.scope?.invitationIntent === true && invitationEvidence(email, body);
        if (plan.scope?.invitationIntent && !invited) return -1;
        const meetingTerm = (term: string) => /^(?:meetings?|invites?|invitations?|appointments?)$/i.test(term);
        if (!threadMatch && plan.scope?.topicGroups.some(group => !group.some(term => matchesTerm(searchable, term) || invited && meetingTerm(term)))) return -1;
        if (!threadMatch && requiredTopicGroups.some(group => !group.some(term => topicInHeader(term) || topicInBody(term)))) return -1;
        if (!threadMatch && requireCustomerProduct && !customerProductAnchors.some(term => topicInHeader(term) || topicInBody(term))) return -1;
        const inHeader = topics.filter(topicInHeader).length;
        const inBody = topics.filter(topic => topicInBody(topic) || invited && meetingTerm(topic)).length;
        const reopenedWithoutNewTopic = pinnedIds.has(email.id) && !plannedTopics.length && !plan.scope?.meetingIntent;
        if (topics.length && !inHeader && !inBody && !threadMatch && !reopenedWithoutNewTopic) return -1;
        const person = people.some(term => matchesTerm(participantText(email), term));
        const authoredByPerson = people.some(term => matchesTerm(`${email.fromAddress} ${email.fromName ?? ''}`, term));
        if (!topics.length && !person && !threadMatch && !pinnedIds.has(email.id) && !plan.scope?.timeWindow) return -1;
        return inHeader * 80 + inBody * 25 + Number(person) * 40 + Number(authoredByPerson) * 160
          + Number(plan.quoteIntent && /quot|proposal|pricing|price.?bid|commercial/i.test(`${email.subject ?? ''} ${email.attachmentNames ?? ''}`)) * 30
          + Number(pinnedIds.has(email.id)) * 10 + Number(threadMatch) * 5;
      };
      // Follow-up questions re-read their actual cited messages. A vague phrase
      // such as "read the attached document" must not lose the previous source.
      const pinned = unique((options.sourceRefs ?? []).filter(ref => ref.accountId === account.id).map(ref => ref.emailId), 12);
      if (pinned.length) {
        progress({ stage: 'context', status: 'running', accountId: account.id, message: `Reopening ${pinned.length} previously cited ${pinned.length === 1 ? 'message' : 'messages'}`, detail: account.email });
        let reopened = 0;
        for (const emailId of pinned) {
          checkAbort(signal);
          const email = await mailbox.storage.getEmail(emailId);
          if (!email || !eligible(email)) continue;
          pinnedIds.add(email.id);
          found.set(email.id, email);
          relevance.set(email.id, score(email));
          reopened++;
        }
        progress({ stage: 'context', status: reopened ? 'done' : 'warning', accountId: account.id, message: `Reopened ${reopened} previously cited ${reopened === 1 ? 'message' : 'messages'}`, detail: account.email });
      }
      if (requests.length > 48) covered.truncated = true;
      for (const request of requests.slice(0, 48)) {
        checkAbort(signal);
        const rows = await mailbox.storage.searchEmails(request);
        if (rows.length >= QUERY_LIMIT) covered.truncated = true;
        for (const email of rows) {
          if (!eligible(email)) continue;
          if (plan.scope?.invitationIntent && !invitationEvidence(email)) continue;
          found.set(email.id, email);
          relevance.set(email.id, Math.max(relevance.get(email.id) ?? -1, score(email)));
        }
        // Release the Electron main loop between synchronous SQLite searches.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      // Search rows deliberately carry previews. Hydrate before deciding topic
      // relevance and expand actual conversations, including team replies.
      for (const [id] of found) {
        checkAbort(signal);
        const email = await mailbox.storage.getEmail(id);
        if (!email || !eligible(email)) { found.delete(id); continue; }
        const value = score(email);
        if (value < 0 && email.rawBody) { found.delete(id); continue; }
        found.set(id, email);
        relevance.set(id, value);
      }
      if (mailbox.storage.getEmailsByThread) {
        const seeds = [...found.values()].sort((a, b) => (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0) || b.date - a.date);
        for (const seed of seeds) {
          if (expandedThreads.size >= MAX_THREAD_SEEDS) break;
          if (!seed.threadId || expandedThreads.has(seed.threadId) || (relevance.get(seed.id) ?? -1) < 0) continue;
          checkAbort(signal);
          expandedThreads.add(seed.threadId);
          const members = await mailbox.storage.getEmailsByThread(seed.threadId);
          if (members.length > MAX_THREAD_MEMBERS) covered.truncated = true;
          let added = 0;
          for (const email of members.sort((a, b) => b.date - a.date).slice(0, MAX_THREAD_MEMBERS)) {
            if (!eligible(email)) continue;
            if (plan.scope?.invitationIntent && !invitationEvidence(email)) continue;
            if (!found.has(email.id)) added++;
            found.set(email.id, email);
            relevance.set(email.id, score(email, fullBody(email), true));
          }
          if (added) progress({ stage: 'context', status: 'done', accountId: account.id, emailId: seed.id,
            message: `Loaded ${added} additional conversation ${added === 1 ? 'message' : 'messages'}`, detail: seed.subject || '(No subject)' });
        }
      }
      covered.matchedMessages = found.size;
      progress({ stage: 'search', status: 'done', accountId: account.id, message: `Found ${found.size} matching ${found.size === 1 ? 'message' : 'messages'}`, detail: account.email });
      const ranked = [...found.values()].sort((a, b) => (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0) || b.date - a.date);
      // Reserve a first message for each discovered conversation before one
      // busy conversation consumes every source slot.
      const seenThreads = new Set<string>();
      const first: EmailRecord[] = []; const additional: EmailRecord[] = [];
      for (const email of ranked) {
        const key = email.threadId || email.id;
        if (seenThreads.has(key)) additional.push(email);
        else { seenThreads.add(key); first.push(email); }
      }
      const candidates = [...first, ...additional];
      if (candidates.length > MAX_MESSAGES_PER_ACCOUNT) covered.truncated = true;
      const selected = candidates.slice(0, MAX_MESSAGES_PER_ACCOUNT);
      const documentCount = selected.filter(email => email.hasAttachments || parseAttachmentNames(email.attachmentNames).length).length;
      const messageBudget = Math.floor((accountCharEnd - totalChars) * (documentCount ? 0.62 : 1));
      // Give the strongest matches enough contiguous text to explain their
      // actual reply before older quoted history. Keep the same account budget.
      const messageWeights = selected.map((_, index) => index < 4 ? 3 : 1);
      const totalWeight = messageWeights.reduce((sum, weight) => sum + weight, 0) || 1;
      for (const [candidateIndex, candidate] of selected.entries()) {
        checkAbort(signal);
        if (totalChars >= accountCharEnd) { covered.truncated = true; break; }
        let email = await mailbox.storage.getEmail(candidate.id);
        if (!email || isExcluded(email, folders) || !matchesFilters(email, plan) || (plan.intent === 'sent' && !isSent(email, folders, aliases))) continue;
        let body = fullBody(email);
        let unavailableOriginal = !email.rawBody?.trim() && email.hasBody === false;
        // A bounded preview is not a downloaded body. Request the original
        // even when the list/search snippet is nonempty.
        if (!email.rawBody?.trim() && (!body || email.hasBody === false || body.length <= 256) && mailbox.fetchBody) {
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
              email = refreshed && (refreshed.cleanBody?.trim() || refreshed.rawBody?.trim()) ? refreshed : downloaded ?? refreshed ?? email;
              unavailableOriginal = !email.rawBody?.trim() && (!downloaded || downloaded.hasBody === false
                || downloaded.cleanBody === downloadingEmail.cleanBody);
            }
            catch { unavailableOriginal = true; }
          }
          checkAbort(signal);
          body = fullBody(email);
        }
        if (!eligible(email)) continue;
        if (score(email, body, expandedThreads.has(email.threadId)) < 0) continue;
        const ics = plan.scope?.invitationIntent ? calendarInvitation(email) : '';
        if (ics) body += `\n\nCalendar invitation captured from this message (untrusted original calendar text):\n${ics}`;
        if (!body || unavailableOriginal) {
          covered.missingBodies++;
          progress({ stage: 'body', status: 'warning', accountId: account.id, emailId: email.id, message: 'Email content could not be downloaded', detail: email.subject || '(No subject)' });
        } else {
          progress({ stage: 'body', status: 'done', accountId: account.id, emailId: email.id, message: 'Email content ready', detail: email.subject || '(No subject)' });
        }
        covered.reviewedMessages++;
        const folder = folders.find(item => item.id === email!.folderId);
        const sent = isSent(email, folders, aliases);
        const metadata = {
          accountId: account.id, accountEmail: account.email, emailId: email.id,
          threadId: email.threadId, subject: email.subject || '(No subject)',
          from: email.fromAddress, to: addresses(email.toAddress), date: email.date,
          folder: folder?.path ?? '', sent,
        };
        // The answer renderer supplies Subject/Date/From/To from this source's
        // metadata. Duplicating them here wastes the bounded body allowance.
        const header = `CC: ${addresses(email.ccAddress).join(', ')}\n`;
        const messageAllowance = Math.min(MAX_MESSAGE_CHARS,
          Math.floor(messageBudget * messageWeights[candidateIndex]! / totalWeight));
        const allowance = Math.min(messageAllowance, accountCharEnd - totalChars);
        const selectedBody = bodyEvidence(body, Math.max(0, allowance - header.length - 1), [...topics, ...people, ...(plan.quoteIntent ? ['total', 'price', 'commercial', '₹'] : [])], 0.6);
        const text = `${header}${unavailableOriginal ? 'Content status: original unavailable; the following is only a preview.\n' : ''}\n${selectedBody}`.slice(0, allowance);
        if (text.length < header.length + body.length || email.rawBody.length > MAX_RAW_BODY_CHARS) covered.truncated = true;
        evidence.push({ ...metadata, id: `S${evidence.length + 1}`, kind: 'message', text, excerpt: selectedBody.slice(0, 1000) });
        totalChars += text.length;

        let names = parseAttachmentNames(email.attachmentNames);
        const declared = await mailbox.storage.getAttachments(email.id);
        names = unique([...names, ...declared.map(item => item.filename)], 500);
        const supported = (name: string) => /\.(?:pdf|docx|xlsx|pptx|csv|tsv|txt)$/i.test(name);
        names.sort((a, b) => Number(supported(b)) - Number(supported(a))
          || Number(/quot|proposal|pricing/i.test(b)) - Number(/quot|proposal|pricing/i.test(a)));
        if (names.length > 30) { covered.attachmentsSkipped += names.length - 30; covered.truncated = true; }
        let supportedFiles = 0;
        for (const filename of names.slice(0, 30)) {
          checkAbort(signal);
          if (ics && /\.ics$/i.test(filename)) continue;
          // Inline logos and unsupported files do not consume document slots.
          if (!supported(filename)) { covered.attachmentsSkipped++; continue; }
          if (plan.quoteIntent && /tender|\brfp\b|declaration|invoice|cibil/i.test(filename)
            && !/quot|proposal|pricing|price.?bid|commercial/i.test(`${filename} ${email.subject ?? ''}`)) {
            covered.attachmentsSkipped++;
            continue;
          }
          // A company acronym in an incidental quoted body (for example a
          // financial newsletter) is insufficient reason to download its files.
          // Preserve the message evidence, but spend document work on matching
          // headers, commercial filenames, named senders or a reopened source.
          if (topics.length && (relevance.get(candidate.id) ?? 0) < 50 && !pinnedIds.has(candidate.id)) {
            covered.attachmentsSkipped++;
            continue;
          }
          if (supportedFiles >= MAX_FILES_PER_MESSAGE || filesRead >= MAX_ATTACHMENT_FILES || accountFilesRead >= accountFileLimit || totalChars >= accountCharEnd) {
            covered.attachmentsSkipped++; covered.truncated = true; continue;
          }
          filesRead++;
          accountFilesRead++;
          supportedFiles++;
          try {
            progress({ stage: 'attachment', status: 'running', accountId: account.id, emailId: email.id, filename, message: `Downloading and reading ${filename}`, detail: account.email });
            const ref = { accountId: account.id, emailId: email.id, filename };
            const result = await download((attachmentSignal, onApprovalWait) => deps.readAttachment(ref, {
              signal: attachmentSignal,
              allowSecurityPrompt: true,
              onApprovalWait,
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
            if (result.message) covered.warnings.push(`${filename}: ${result.message}`);
            progress({ stage: 'attachment', status: 'done', accountId: account.id, emailId: email.id, filename, message: `Read ${filename}`, detail: `${result.segments.length} text ${result.segments.length === 1 ? 'section' : 'sections'} available${result.truncated ? '; document exceeds the reading limit' : ''}.` });
            if (result.truncated) covered.truncated = true;
            const score = (value: string, label: string) => queries.reduce((n, query) => n + (value.toLowerCase().includes(query.toLowerCase()) ? 2 : 0), 0)
              + Number(/summary/i.test(label) && /total bid value|grand total|total commercial value/i.test(value)) * 100
              + Number(/\bdummy\b/i.test(value)) * 40
              + Number(/summary|read\s*me|notes|terms|conditions/i.test(label)) * 10
              + Number(/dummy|evaluation|actual (?:effort|consumption)|exclud|contract value/i.test(value)) * 5
              + (plan.quoteIntent && /(?:quot|total|amount|price|INR|USD|₹|\$)/i.test(value) ? 1 : 0);
            const segments = result.segments.map((segment, originalIndex) => ({ ...segment, originalIndex }))
              .sort((a, b) => score(b.text, b.locator.label) - score(a.text, a.locator.label) || a.originalIndex - b.originalIndex);
            if (segments.length > MAX_SEGMENTS_PER_FILE) covered.truncated = true;
            let fileChars = 0;
            const fileAllowance = Math.min(16_000, Math.max(4_000,
              Math.floor(MAX_EVIDENCE_CHARS / accounts.length * 0.38 / Math.max(1, Math.min(documentCount, accountFileLimit)))));
            const selectedSegments = segments.slice(0, MAX_SEGMENTS_PER_FILE);
            const segmentAllowance = Math.min(6000, Math.max(1200, Math.floor(fileAllowance / Math.min(4, selectedSegments.length))));
            for (const segment of selectedSegments) {
              const maxChars = Math.min(segmentAllowance, fileAllowance - fileChars, accountCharEnd - totalChars);
              if (maxChars <= 0) { covered.truncated = true; break; }
              // Attachment identity and location also travel as source metadata.
              const attachmentHeader = '';
              if (maxChars <= attachmentHeader.length + 100) { covered.truncated = true; break; }
              const segmentText = attachmentHeader + bodyEvidence(segment.text, maxChars - attachmentHeader.length,
                [...topics, 'Total Bid Value', 'total', 'dummy', 'evaluation', 'actual', 'contract value', 'including GST']);
              if (segment.text.length > maxChars - attachmentHeader.length) covered.truncated = true;
              evidence.push({ ...metadata, id: `S${evidence.length + 1}`, kind: 'attachment',
                attachmentId: declared.find(item => item.filename === filename)?.id, filename,
                location: segment.locator.label, text: segmentText, excerpt: segment.text.slice(0, 1000),
              });
              totalChars += segmentText.length;
              fileChars += segmentText.length;
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
