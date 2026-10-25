import { randomUUID } from 'node:crypto';

import { waitForAbortableOperation } from '@sarvinbox/core';

import type { InboxAssistantAccount, InboxAssistantActionMode, InboxAssistantActivity, InboxAssistantAIUsage, InboxAssistantAIWorkload, InboxAssistantCancellation, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange, InboxAssistantProgress, InboxAssistantRequest, InboxAssistantReviewActionRequest, InboxAssistantRewind, InboxAssistantRunRecord } from '../../src/types/inbox-assistant';
import type { InboxAssistantReview, InboxAssistantReviewAutomation, InboxAssistantReviewKind } from '../../src/types/inbox-assistant-actions';
import type { LocalCalendarAvailability, LocalCalendarAvailabilityRequest, LocalCalendarPreferences } from '../../src/types/local-calendar';
import { readInboxAssistantAIWorkload } from '../../src/utils/inbox-assistant-workload';

import { isMeetingDraft, meetingAvailabilityRequests, recheckMeetingAvailability } from './assistant-calendar';
import { applyInboxAssistantReview, parseInboxAssistantReadCommand, prepareInboxAssistantReview, undoInboxAssistantReview, type InboxAssistantActionDeps } from './inbox-assistant-actions';
import { answerInboxAssistant, planInboxAssistantSearch } from './inbox-assistant-answer';
import { inboxAssistantCapabilityReply } from './inbox-assistant-capabilities';
import { buildInboxAssistantContext } from './inbox-assistant-context';
import { generateInboxAssistantDraft } from './inbox-assistant-draft';
import type { InboxAssistantHistoryStore } from './inbox-assistant-history';
import { InboxAssistantRecommendationCache } from './inbox-assistant-recommendation-cache';
import { researchInboxAssistant, type AssistantResearchDeps } from './inbox-assistant-retrieval';
import { aggregateInboxAssistantUsage } from './inbox-assistant-usage';

export interface InboxAssistantServiceDeps extends AssistantResearchDeps {
  accounts(): InboxAssistantAccount[];
  callAI(prompt: string, signal: AbortSignal, onUsage?: (usage: InboxAssistantAIUsage) => void, options?: { maxOutputTokens?: number }): Promise<string>;
  reviewCacheIdentity?(): string;
  now?(): number;
  timeZone?(): string;
  history: InboxAssistantHistoryStore;
  setRead?: InboxAssistantActionDeps['setRead'];
  moveMail?: InboxAssistantActionDeps['moveMail'];
  calendar?: {
    preferences(): LocalCalendarPreferences;
    availability(request: LocalCalendarAvailabilityRequest): LocalCalendarAvailability | Promise<LocalCalendarAvailability>;
  };
}

interface ActiveRun {
  id: string;
  chatId: string;
  controller: AbortController;
  generation: number;
  record: InboxAssistantRunRecord;
  mutating: boolean;
  cancelled: boolean;
  settled: Promise<void>;
  finish(): void;
  reviewBudget?: { calls: number; inputChars: number; reason?: string };
}

const AUTOMATIC_REVIEW_LIMITS = { batches: 10, aiCalls: 20, inputChars: 500_000, durationMs: 10 * 60_000 };

/** A calendar preference failure must not prevent unrelated email research. */
function researchTimeZone(deps: InboxAssistantServiceDeps): string {
  for (const resolve of [() => deps.timeZone?.(), () => deps.calendar?.preferences().timeZone,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    try {
      const zone = resolve();
      if (typeof zone !== 'string' || !zone.trim()) continue;
      new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
      return zone;
    } catch { /* Try the next host-owned timezone source. */ }
  }
  return 'UTC';
}

interface HeldReview {
  chatId: string;
  exchangeId: string;
  review: InboxAssistantReview;
  excludedThreads: Record<string, string[]>;
  /** Host-only continuation, updated only after safely settled batches. */
  automaticCheckpoint?: Record<string, string[]>;
  automaticExhausted?: boolean;
}

function validateRequest(value: unknown): InboxAssistantRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid Inbox Agent question.');
  const request = value as InboxAssistantRequest;
  if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.requestId)
    || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
    || typeof request.question !== 'string' || !request.question.trim() || request.question.length > 4000
    || !Array.isArray(request.accountIds) || !request.accountIds.length
    || !request.accountIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 500)
    || (request.previousExchangeId !== undefined && typeof request.previousExchangeId !== 'string')
    || (request.reviewKind !== undefined && !['unread', 'uncategorized', 'mark_read', 'mark_unread'].includes(request.reviewKind))
    || (request.reviewOnly !== undefined && typeof request.reviewOnly !== 'boolean')
    || (request.continueReviewId !== undefined && (typeof request.continueReviewId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.continueReviewId)))) {
    throw new Error('Enter a question and select at least one account. Questions can contain up to 4,000 characters.');
  }
  return { ...request, question: request.question.trim(), accountIds: [...new Set(request.accountIds)] };
}

/** User-authored requests alone can enter the action flow; mail cannot invoke it. */
export function inboxAssistantReviewIntent(question: string): InboxAssistantReviewKind | undefined {
  if (/\b(?:do not|don't|never|without)\s+(?:mark|change|review|process)/i.test(question)) return undefined;
  if (/\bunread\b/i.test(question) && /\b(?:all|including|include|also)\b/i.test(question)
    && /\b(?:review|triage|clean|mark|look|check)\b/i.test(question)) return 'unread';
  if (/\b(?:uncategori[sz]ed|unlabelled|unlabeled|unclassified)\b/i.test(question)
    && /\b(?:review|check|find|show|triage|look|process|categori[sz]e)\b/i.test(question)) return 'uncategorized';
  if (/\bunread\b/i.test(question) && /\b(?:review|triage|clean|mark|look|check)\b/i.test(question)) return 'unread';
  return undefined;
}

/** This first tool has an explicit account scope and no hidden free-text filters. */
export function inboxAssistantGenericReviewRequest(question: string): boolean {
  const allowed = new Set('a about across all an and are as at available can categorize categorise categorization categorisation categories check classify clean cleanup conversation conversations could do email emails for have help i if in inbox inboxes into is it let look low mail mails mark me my no nonvaluable not of or our please process read review should show that the them these they this those triage uncategorized uncategorised unclassified unlabelled unlabeled unread unvaluable up us useful valuable value what which will with worthless worth would you your accounts account'.split(' '));
  const words = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && words.every(word => allowed.has(word));
}

function reviewText(review: InboxAssistantReview): string {
  const accountCount = review.coverage.filter(account => account.status === 'reviewed').length;
  const accountText = `${accountCount} ${accountCount === 1 ? 'account' : 'accounts'}`;
  if (review.kind === 'mark_read' || review.kind === 'mark_unread') {
    const flag = review.kind === 'mark_unread' ? 'unread' : 'read';
    const changed = review.items.filter(item => item.status === 'applied' || item.status === 'queued').length;
    const messages = review.items.reduce((sum, item) => sum + (item.targetEmailIds?.length ?? 0), 0);
    return `Found ${review.items.length} matching ${review.items.length === 1 ? 'conversation' : 'conversations'} for “${review.scope?.query ?? ''}” across ${accountText}. ${messages} matching ${messages === 1 ? 'email is' : 'emails are'} selected for marking as ${flag}.\n\n${changed ? `${changed} ${changed === 1 ? 'conversation was' : 'conversations were'} updated. Review the receipts below or undo the changes.` : 'Review the matching emails below before applying the change.'}${review.truncated ? '\n\nMore mail may remain. Continue with another review after this batch.' : ''}`;
  }
  const suggested = review.items.filter(item => item.recommendation === 'mark_read').length;
  const applied = review.items.filter(item => item.status === 'applied' || item.status === 'queued').length;
  const uncategorized = review.items.filter(item => item.uncategorized).length;
  return `Reviewed ${review.items.length} unread conversations across ${accountText}. ${uncategorized} conversations include uncategorized mail.\n\n${applied ? `${applied} conversations marked as read. Review the results below or undo the changes.` : `${suggested} conversations are recommended for marking as read. Important, incomplete and uncertain conversations stay unread.`}${review.truncated ? '\n\nMore unread mail remains. Continue with another review after this batch.' : ''}`;
}

function validateDraftRequest(value: unknown): InboxAssistantDraftRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid email draft request.');
  const request = value as InboxAssistantDraftRequest;
  if (!Object.keys(request).every(key => ['requestId', 'chatId', 'accountId', 'instructions', 'meeting'].includes(key))
    || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.requestId)
    || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
    || typeof request.accountId !== 'string' || !request.accountId || request.accountId.length > 500
    || (request.instructions !== undefined && (typeof request.instructions !== 'string' || request.instructions.length > 4_000))
    || (request.meeting !== undefined && (!request.meeting || typeof request.meeting !== 'object' || Array.isArray(request.meeting)))) {
    throw new Error('Choose a conversation and sending account. Draft instructions can contain up to 4,000 characters.');
  }
  return { requestId: request.requestId, chatId: request.chatId, accountId: request.accountId,
    ...(request.meeting ? { meeting: request.meeting } : {}),
    ...(request.instructions?.trim() ? { instructions: request.instructions.trim() } : {}) };
}

export class InboxAssistantService {
  private running = new Map<string, ActiveRun>();
  private mailActionTail: Promise<void> = Promise.resolve();
  private generations = new Map<string, number>();
  private actionReviews = new Map<string, HeldReview>();
  private recommendationCache = new InboxAssistantRecommendationCache();

  constructor(private deps: InboxAssistantServiceDeps) {}

  private assertIdle(chatId: string, requestId: string): void {
    if (this.running.has(chatId)) throw new Error('Another Inbox Agent request is still running in this conversation. Stop it before starting another.');
    if ([...this.running.values()].some(run => run.id === requestId)) throw new Error('This Inbox Agent request is already running.');
  }

  private beginRequest(id: string, chatId: string, controller: AbortController, kind: InboxAssistantRunRecord['kind'], question: string, accountIds: string[], exchangeId?: string): ActiveRun {
    this.assertIdle(chatId, id);
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    const now = Date.now();
    const run: ActiveRun = { id, chatId, controller, generation: this.generations.get(chatId) ?? 0,
      record: { requestId: id, chatId, kind, question, accountIds: [...accountIds], ...(exchangeId ? { exchangeId } : {}), status: 'pending', startedAt: now, updatedAt: now, activities: [] },
      mutating: false, cancelled: false, settled, finish };
    this.running.set(chatId, run);
    try { this.persistRun(run); } catch (error) { this.running.delete(chatId); finish(); throw error; }
    return run;
  }

  private finishRequest(controller: AbortController): void {
    const run = [...this.running.values()].find(value => value.controller === controller);
    if (!run) return;
    this.running.delete(run.chatId);
    run.finish();
  }

  private markRequestMutating(controller: AbortController): void {
    const run = [...this.running.values()].find(value => value.controller === controller);
    if (run) run.mutating = true;
  }

  private persistRun(run: ActiveRun, exchange?: InboxAssistantExchange): void {
    if (run.generation !== (this.generations.get(run.chatId) ?? 0)) return;
    const current = this.deps.history.load(run.chatId, { select: false });
    const runs = [...(current.runs ?? [])];
    const index = runs.findIndex(value => value.requestId === run.id);
    run.record.updatedAt = Math.max(run.record.updatedAt, Date.now());
    const record = { ...run.record, activities: [...run.record.activities] };
    if (index < 0) runs.push(record); else runs[index] = record;
    let exchanges = exchange ? current.exchanges.some(value => value.id === exchange.id)
      ? current.exchanges.map(value => value.id === exchange.id ? exchange : value) : [...current.exchanges, exchange] : current.exchanges;
    if (run.record.kind === 'question' && run.record.exchangeId && !exchange) {
      const previous = exchanges.find(value => value.id === run.record.exchangeId);
      const question: InboxAssistantExchange = { ...(previous ?? { id: run.record.exchangeId, chatId: run.chatId, question: run.record.question,
        accountIds: run.record.accountIds, createdAt: run.record.startedAt, answer: { text: '', sources: [], coverage: [], warnings: [] } }),
        requestId: run.id, status: run.record.status, updatedAt: record.updatedAt, activities: record.activities, ...(record.usage ? { usage: record.usage } : {}),
        ...(run.record.error ? { error: run.record.error } : {}) };
      exchanges = previous ? exchanges.map(value => value.id === question.id ? question : value) : [...exchanges, question];
    }
    this.deps.history.writeChat({ ...current, runs, exchanges });
  }

  private reportRun(run: ActiveRun, progress: InboxAssistantProgress, listener?: (activity: InboxAssistantActivity) => void): void {
    if (run.controller.signal.aborted || run.generation !== (this.generations.get(run.chatId) ?? 0)) return;
    run.record.status = 'running';
    const activity: InboxAssistantActivity = { ...progress, requestId: run.id, chatId: run.chatId,
      sequence: (run.record.activities.at(-1)?.sequence ?? 0) + 1, at: Date.now() };
    run.record.activities.push(activity);
    if (run.record.activities.length > 400) run.record.activities.shift();
    this.persistRun(run);
    try { listener?.(activity); } catch { /* The requesting window may have closed. */ }
  }

  private settleRun(run: ActiveRun, error?: unknown, exchange?: InboxAssistantExchange): InboxAssistantExchange | undefined {
    run.record.status = run.cancelled ? 'stopped' : error !== undefined ? 'failed' : 'completed';
    if (error !== undefined) run.record.error = error instanceof Error ? error.message : 'Inbox Agent could not finish this request.';
    else delete run.record.error;
    run.record.updatedAt = run.record.kind === 'action' && exchange
      ? Math.max(Date.now(), (exchange.updatedAt ?? exchange.createdAt) + 1) : Date.now();
    const saved = exchange ? run.record.kind === 'question' ? { ...exchange, requestId: run.id, status: run.record.status, updatedAt: run.record.updatedAt,
      activities: [...run.record.activities], ...(run.record.error ? { error: run.record.error } : {}), ...(run.record.usage ? { usage: run.record.usage } : {}) } : { ...exchange, updatedAt: run.record.updatedAt } : undefined;
    this.persistRun(run, saved);
    return saved;
  }

  /** Serialize mutations while allowing independent chats to research in parallel. */
  private async withMailActions<T>(run: ActiveRun, action: () => Promise<T>): Promise<T> {
    const before = this.mailActionTail.catch(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.mailActionTail = before.then(() => gate);
    try {
      await waitForAbortableOperation(before, run.controller.signal);
      run.controller.signal.throwIfAborted();
      this.markRequestMutating(run.controller);
      return await action();
    } finally { release(); }
  }

  private callRunAI(run: ActiveRun, prompt: string, signal: AbortSignal, maxOutputTokens?: number, workload?: InboxAssistantAIWorkload): Promise<string> {
    signal.throwIfAborted();
    if (run.reviewBudget) {
      const budget = run.reviewBudget;
      if (budget.calls >= AUTOMATIC_REVIEW_LIMITS.aiCalls || budget.inputChars + prompt.length > AUTOMATIC_REVIEW_LIMITS.inputChars) {
        budget.reason = 'The automatic review reached its AI budget. Start another run to continue.';
        throw new Error(budget.reason);
      }
      budget.calls++;
      budget.inputChars += prompt.length;
    }
    const trustedWorkload = readInboxAssistantAIWorkload(workload);
    const onUsage = (usage: InboxAssistantAIUsage) => {
      // Only the host's actual prepared batch describes workload. Provider
      // accounting remains unchanged and cannot supply these diagnostic counts.
      const { workload: _providerWorkload, ...reported } = usage;
      run.record.usage = aggregateInboxAssistantUsage([...(run.record.usage?.calls ?? []), { ...reported, ...(trustedWorkload ? { workload: trustedWorkload } : {}) }]);
      // Reported accounting can arrive during cancellation. Keep the saved
      // receipt on its originating run without waking or selecting that chat.
      if (run.generation === (this.generations.get(run.chatId) ?? 0)) this.persistRun(run);
      else this.persistStaleUsage(run);
    };
    return waitForAbortableOperation(maxOutputTokens === undefined ? this.deps.callAI(prompt, signal, onUsage)
      : this.deps.callAI(prompt, signal, onUsage, { maxOutputTokens }), signal);
  }

  private persistStaleUsage(run: ActiveRun): void {
    // The caller may have rewound/cleared the request before the aborted
    // provider returned its billable counts. Merge only the spending ledger:
    // never restore a removed question/run or recreate a deleted conversation.
    if (!run.record.usage?.calls.length || !this.deps.history.list().chats.some(chat => chat.id === run.chatId)) return;
    const current = this.deps.history.load(run.chatId, { select: false });
    const usage = aggregateInboxAssistantUsage([...(current.usage?.calls ?? []), ...run.record.usage.calls]);
    this.deps.history.writeChat({ ...current, usage });
  }

  accounts(): InboxAssistantAccount[] { return this.deps.accounts(); }

  private visibleExchanges(exchanges: InboxAssistantExchange[]): InboxAssistantExchange[] {
    const registered = new Set(this.accounts().map(account => account.id));
    return exchanges.filter(exchange => exchange.accountIds.every(id => registered.has(id))).map(exchange => {
      if (!exchange.review || (this.actionReviews.has(exchange.review.id) && exchange.review.expiresAt > Date.now())) return exchange;
      return { ...exchange, review: { ...exchange.review, status: 'expired' } };
    });
  }

  chats(): InboxAssistantChatList {
    const list = this.deps.history.list();
    return { ...list, chats: list.chats.map(chat => {
      const run = this.running.get(chat.id);
      return { ...chat, ...(run ? { activeRun: structuredClone(run.record) } : {}) };
    }) };
  }

  private recoverChat(chat: InboxAssistantChat): InboxAssistantChat {
    const live = this.running.get(chat.id);
    let changed = false;
    const stopOrphan = <T extends { status?: string; requestId?: string; error?: string; updatedAt?: number }>(value: T): T => {
      if (!['pending', 'running'].includes(value.status ?? '') || (live && value.requestId === live.id)) return value;
      changed = true;
      return { ...value, status: 'stopped', updatedAt: Date.now(), error: 'Interrupted when the app restarted. The saved conversation is available; start a new request to continue.' };
    };
    const recovered: InboxAssistantChat = { ...chat, exchanges: chat.exchanges.map(value => {
      const exchange = stopOrphan(value);
      if (exchange.review?.automation?.status !== 'running' || (live && live.record.exchangeId === exchange.id)) return exchange;
      changed = true;
      return { ...exchange, review: { ...exchange.review, automation: { ...exchange.review.automation, status: 'stopped' as const,
        reason: 'Interrupted when the app restarted. Saved receipts remain available; start a new review to continue.' } } };
    }),
      ...(chat.runs ? { runs: chat.runs.map(stopOrphan) } : {}) };
    if (changed) this.deps.history.writeChat(recovered);
    return recovered;
  }

  chat(id: unknown): InboxAssistantChat {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid Inbox Agent chat.');
    const chat = this.recoverChat(this.deps.history.load(id));
    const live = this.running.get(id);
    return { ...chat, exchanges: this.visibleExchanges(chat.exchanges), ...(live ? { activeRun: structuredClone(live.record) } : {}) };
  }

  createChat(): InboxAssistantChat { return this.deps.history.create(); }

  renameChat(value: unknown): InboxAssistantChatSummary {
    const request = value as { chatId?: unknown; title?: unknown } | null;
    if (!request || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
      || typeof request.title !== 'string' || !request.title.trim() || request.title.trim().length > 120) throw new Error('Enter a chat name containing 1 to 120 characters.');
    return this.deps.history.rename(request.chatId, request.title);
  }

  updateChat(value: unknown): InboxAssistantChatSummary {
    const request = value as { chatId?: unknown; pinned?: unknown; actionMode?: unknown } | null;
    if (!request || Array.isArray(request) || !Object.keys(request).every(key => ['chatId', 'pinned', 'actionMode'].includes(key))
      || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
      || (request.pinned === undefined && request.actionMode === undefined)
      || (request.pinned !== undefined && typeof request.pinned !== 'boolean')
      || (request.actionMode !== undefined && !['review', 'approve_for_me'].includes(request.actionMode as string))) {
      throw new Error('Choose a valid conversation setting.');
    }
    const result = this.deps.history.update(request.chatId, {
      ...(typeof request.pinned === 'boolean' ? { pinned: request.pinned } : {}),
      ...(request.actionMode !== undefined ? { actionMode: request.actionMode as InboxAssistantActionMode } : {}),
    });
    const run = this.running.get(request.chatId);
    if (request.actionMode === 'review' && run?.mutating) { run.cancelled = true; run.controller.abort(new Error('Delegated approval stopped.')); }
    return result;
  }

  deleteChat(value: unknown): InboxAssistantChatList {
    if (typeof value === 'string' && this.running.get(value)?.mutating) throw new Error('Wait for the current mail action to finish before deleting this conversation.');
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Inbox Agent chat.');
    const result = this.deps.history.delete(value);
    this.generations.set(value, (this.generations.get(value) ?? 0) + 1);
    this.running.get(value)?.controller.abort(new Error('This conversation was deleted.'));
    for (const [id, entry] of this.actionReviews) if (entry.chatId === value) this.actionReviews.delete(id);
    return result;
  }

  async rewindChat(value: unknown): Promise<InboxAssistantRewind> {
    const request = value as { chatId?: unknown; exchangeId?: unknown } | null;
    if (!request || Array.isArray(request) || !Object.keys(request).every(key => ['chatId', 'exchangeId'].includes(key))
      || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
      || typeof request.exchangeId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.exchangeId)) throw new Error('Choose a message to edit.');
    const current = this.deps.history.load(request.chatId, { select: false });
    if (!current.exchanges.some(exchange => exchange.id === request.exchangeId)) throw new Error('This message is no longer available.');
    await this.stopForHistoryChange(request.chatId);
    if (this.running.has(request.chatId)) throw new Error('A new request started in this conversation. Stop it before rewinding.');
    const result = this.deps.history.rewind(request.chatId, request.exchangeId);
    this.invalidateReviews(request.chatId);
    return { ...result, chat: { ...result.chat, exchanges: this.visibleExchanges(result.chat.exchanges) } };
  }

  async restoreRewindChat(value: unknown): Promise<InboxAssistantChat> {
    const request = value as { chatId?: unknown } | null;
    if (!request || Array.isArray(request) || !Object.keys(request).every(key => key === 'chatId')
      || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)) throw new Error('Choose a conversation to restore.');
    await this.stopForHistoryChange(request.chatId);
    if (this.running.has(request.chatId)) throw new Error('A new request started in this conversation. Stop it before restoring.');
    const chat = this.deps.history.restoreRewind(request.chatId);
    this.invalidateReviews(request.chatId);
    return { ...chat, exchanges: this.visibleExchanges(chat.exchanges) };
  }

  private async stopForHistoryChange(chatId: string): Promise<void> {
    const run = this.running.get(chatId);
    if (!run) return;
    if (run.mutating) throw new Error('Stop the current mail action and wait for its receipt before rewinding this conversation.');
    await this.cancel(run.id);
  }

  private invalidateReviews(chatId: string): void {
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    for (const [id, entry] of this.actionReviews) if (entry.chatId === chatId) this.actionReviews.delete(id);
  }

  history(): InboxAssistantExchange[] {
    const active = this.deps.history.list().activeChatId;
    return active ? this.visibleExchanges(this.recoverChat(this.deps.history.load(active, { select: false })).exchanges) : [];
  }

  async cancel(value: unknown): Promise<InboxAssistantCancellation> {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Inbox Agent request to stop.');
    const run = [...this.running.values()].find(item => item.id === value);
    if (!run) return { requestId: value, cancelled: false };
    run.cancelled = true;
    run.controller.abort(new Error('Request cancelled.'));
    // A mail write already acknowledged by the durable queue must finish its
    // receipt. New work can begin once this exact run has released ownership.
    await run.settled;
    return { requestId: value, cancelled: true };
  }

  clearHistory(): void {
    const active = this.deps.history.list().activeChatId;
    if (!active) return;
    if (this.running.get(active)?.mutating) throw new Error('Wait for the current mail action to finish before clearing this conversation.');
    this.generations.set(active, (this.generations.get(active) ?? 0) + 1);
    this.running.get(active)?.controller.abort();
    this.deps.history.clear(active);
    for (const [id, entry] of this.actionReviews) if (entry.chatId === active) this.actionReviews.delete(id);
  }

  private reviewDeps(signal: AbortSignal, expectedAccounts?: InboxAssistantAccount[]): InboxAssistantActionDeps {
    const assertAccount = (accountId: string) => {
      signal.throwIfAborted();
      const account = this.accounts().find(item => item.id === accountId);
      if (!account || (expectedAccounts && !expectedAccounts.some(item => item.id === account.id && item.email === account.email))) {
        throw new Error('The review account changed or is no longer connected.');
      }
    };
    return {
      openMailbox: accountId => {
        assertAccount(accountId);
        return this.deps.openMailbox(accountId);
      },
      callAI: (prompt, stepSignal, workload) => {
        const effective = stepSignal ? AbortSignal.any([signal, stepSignal]) : signal;
        if (effective.aborted) throw new Error('Request stopped.');
        const run = [...this.running.values()].find(value => value.controller.signal === signal);
        if (!run) throw new Error('This Inbox Agent request is no longer running.');
        expectedAccounts?.forEach(account => assertAccount(account.id));
        return this.callRunAI(run, prompt, effective, 4_000, workload);
      },
      setRead: async (accountId, ids, read) => {
        assertAccount(accountId);
        if (!this.deps.setRead) throw new Error('Mail actions are unavailable. Restart the app after updating.');
        return this.deps.setRead(accountId, ids, read);
      },
      moveMail: async (accountId, ids, action) => {
        assertAccount(accountId);
        if (!this.deps.moveMail) throw new Error('Folder actions are unavailable. Restart the app after updating.');
        return this.deps.moveMail(accountId, ids, action);
      },
    };
  }

  private rememberReview(chatId: string, exchangeId: string, review: InboxAssistantReview, excludedThreads: Record<string, string[]>): void {
    for (const [id, held] of this.actionReviews) if (held.review.expiresAt <= Date.now()) this.actionReviews.delete(id);
    while (this.actionReviews.size >= 20) this.actionReviews.delete(this.actionReviews.keys().next().value!);
    this.actionReviews.set(review.id, { chatId, exchangeId, review, excludedThreads });
  }

  /** Each batch keeps its own trusted snapshot and durable, independently undoable receipt. */
  private async automaticallyReview(run: ActiveRun, initial: InboxAssistantExchange, held: HeldReview, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantExchange> {
    const selected = held.review.accounts.map(account => ({ ...account }));
    const identity = this.deps.reviewCacheIdentity?.();
    const signal = run.controller.signal;
    const deps = this.reviewDeps(signal, selected);
    const resuming = !!held.review.automation && held.review.automation.status !== 'running';
    const progress: InboxAssistantReviewAutomation = { reviewId: held.review.id, status: 'running', batchesReviewed: 0,
      reviewedConversations: 0, markedConversations: 0, markedEmails: 0, queuedEmails: 0,
      maxBatches: AUTOMATIC_REVIEW_LIMITS.batches, maxAICalls: AUTOMATIC_REVIEW_LIMITS.aiCalls };
    run.reviewBudget = { calls: 0, inputChars: 0 };
    let anchor = initial;
    let batch = initial;
    let current = held;
    let failure: unknown;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (run.generation !== (this.generations.get(run.chatId) ?? 0)) throw new Error('The conversation changed. Automatic review stopped.');
      if (selected.some(account => !this.accounts().some(value => value.id === account.id && value.email === account.email))) throw new Error('A selected account changed. Automatic review stopped.');
      if (this.deps.reviewCacheIdentity?.() !== identity) throw new Error('Your AI provider changed. Start another review with the new settings.');
    };
    const saveProgress = () => {
      held.review.automation = { ...progress };
      anchor = { ...anchor, review: held.review, updatedAt: Date.now() };
      this.persistRun(run, anchor);
      this.reportRun(run, { stage: 'action', status: progress.status === 'running' ? 'running' : progress.status === 'completed' ? 'done' : 'warning',
        message: progress.status === 'running' ? `Automatic unread review · Batch ${Math.max(1, progress.batchesReviewed)}` : progress.status === 'completed' ? 'Automatic unread review finished' : 'Automatic unread review stopped',
        detail: progress.reason ?? `${progress.reviewedConversations} conversations reviewed · ${progress.markedEmails} emails marked as read${progress.queuedEmails ? ` · ${progress.queuedEmails} queued for sync` : ''}`,
        reviewAutomation: { ...progress } }, onActivity);
    };
    const prepareNext = async (excludedThreads: Record<string, string[]>) => {
      const next = await waitForAbortableOperation(prepareInboxAssistantReview(selected, held.review.kind, deps, signal,
        activity => this.reportRun(run, activity, onActivity), { excludeThreadIds: excludedThreads, recommendationCache: this.recommendationCache, reviewCacheIdentity: identity,
          isCacheCurrent: () => this.deps.reviewCacheIdentity?.() === identity }), signal);
      assertCurrent();
      batch = { id: randomUUID(), chatId: run.chatId, question: initial.question, reviewBatch: { runId: run.id, number: progress.batchesReviewed + 1 },
        accountIds: selected.map(account => account.id), createdAt: Date.now(), status: 'completed', review: next,
        answer: { text: reviewText(next), sources: [], coverage: [], warnings: next.coverage.flatMap(account => account.warnings) } };
      this.rememberReview(run.chatId, batch.id, next, excludedThreads);
      current = this.actionReviews.get(next.id)!;
      this.persistRun(run, batch);
    };
    try {
      saveProgress();
      if (held.automaticCheckpoint || resuming) await prepareNext(held.automaticCheckpoint ?? held.excludedThreads);
      while (progress.batchesReviewed < AUTOMATIC_REVIEW_LIMITS.batches) {
        assertCurrent();
        const review = current.review;
        progress.batchesReviewed++;
        progress.reviewedConversations += review.items.length;
        saveProgress();
        // A renderer selection, cached authority or an LLM can never widen this
        // action. The mutation helper rechecks full source snapshots as well.
        const ids = review.items.filter(item => item.status === 'pending' && item.recommendation === 'mark_read' && item.confidence >= 0.9
          && !item.protectedReasons.length && !item.bodyUnavailable && !item.attachmentsUnknown).map(item => item.id);
        if (ids.length) {
          const result = await this.withMailActions(run, () => {
            assertCurrent();
            return applyInboxAssistantReview(review, ids, deps, signal);
          });
          batch = { ...batch, review, reviewResult: result, answer: { ...batch.answer, text: reviewText(review) }, updatedAt: Date.now() };
          if (batch.id === anchor.id) anchor = batch;
          // Even Stop during a write must save acknowledged changes before
          // observing cancellation or attempting another batch.
          this.persistRun(run, batch);
          progress.markedConversations += result.items.filter(item => item.appliedIds.length > 0).length;
          progress.markedEmails += result.items.reduce((sum, item) => sum + item.appliedIds.length, 0);
          progress.queuedEmails += result.items.reduce((sum, item) => sum + item.queuedIds.length, 0);
          saveProgress();
          assertCurrent();
          if (result.failedCount || result.skippedCount) {
            progress.status = 'stopped'; progress.reason = 'Some conversations changed or could not be updated. Check the saved receipts before continuing.'; break;
          }
        }
        assertCurrent();
        if (review.coverage.some(account => account.status === 'unavailable')) {
          progress.status = 'stopped'; progress.reason = 'A selected account could not be reviewed. Reconnect it before continuing.'; break;
        }
        if (run.reviewBudget.reason) { progress.status = 'stopped'; progress.reason = run.reviewBudget.reason; break; }
        const excludedThreads: Record<string, string[]> = {};
        for (const account of selected) excludedThreads[account.id] = [...new Set([
          ...(current.excludedThreads[account.id] ?? []), ...review.items.filter(item => item.accountId === account.id).map(item => item.threadId),
        ])];
        held.automaticCheckpoint = excludedThreads;
        held.excludedThreads = excludedThreads;
        if (!review.coverage.some(account => account.hasMore)) { held.automaticExhausted = true; progress.status = 'completed'; progress.reason = 'All available unread conversations in the selected accounts were reviewed. Important and uncertain mail stayed unread.'; break; }
        if (!review.items.length) { progress.status = 'stopped'; progress.reason = 'No new conversations were found within the scan limit. More mail may remain; narrow the account scope or refresh later.'; break; }
        if (progress.batchesReviewed >= AUTOMATIC_REVIEW_LIMITS.batches) {
          progress.status = 'stopped'; progress.reason = 'Reached the 10-batch limit. Start another automatic run to continue.'; break;
        }
        if (run.reviewBudget.calls >= AUTOMATIC_REVIEW_LIMITS.aiCalls) {
          progress.status = 'stopped'; progress.reason = 'Reached the AI budget for this run. Start another automatic run to continue.'; break;
        }
        await prepareNext(excludedThreads);
      }
    } catch (error) {
      failure = error;
      progress.status = run.cancelled ? 'stopped' : 'failed';
      progress.reason = run.cancelled ? 'Stopped. Changes already acknowledged are saved below; no further batches were started.'
        : error instanceof Error ? error.message : 'Automatic review could not finish. Check the saved receipts.';
    }
    saveProgress();
    return this.settleRun(run, failure, anchor)!;
  }

  async applyReview(value: unknown, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantExchange> {
    const request = value as InboxAssistantReviewActionRequest;
    if (!request || !Object.keys(request).every(key => ['requestId', 'chatId', 'exchangeId', 'reviewId', 'itemIds', 'undo', 'manualSelection', 'action', 'autoContinue'].includes(key))
      || ![request.requestId, request.chatId, request.exchangeId, request.reviewId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id))
      || !Array.isArray(request.itemIds) || (!request.itemIds.length && !request.autoContinue) || request.itemIds.length > 600
      || request.itemIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      || (request.undo !== undefined && typeof request.undo !== 'boolean')
      || (request.manualSelection !== undefined && typeof request.manualSelection !== 'boolean')
      || (request.autoContinue !== undefined && typeof request.autoContinue !== 'boolean')
      || (request.autoContinue && (request.itemIds.length > 0 || request.undo || request.manualSelection || request.action !== undefined))
      || (request.action !== undefined && !['mark_read', 'mark_unread', 'archive', 'trash'].includes(request.action))
      || ((request.action === 'archive' || request.action === 'trash') && request.manualSelection !== true)
      || (request.undo && (request.manualSelection || request.action !== undefined))) throw new Error('Choose valid reviewed conversations.');
    this.assertIdle(request.chatId, request.requestId);
    const held = this.actionReviews.get(request.reviewId);
    const chat = this.deps.history.load(request.chatId, { select: false });
    const exchange = chat.exchanges.find(item => item.id === request.exchangeId && item.review?.id === request.reviewId);
    if (!held || held.chatId !== request.chatId || held.exchangeId !== request.exchangeId || !exchange
      || held.review.expiresAt <= Date.now()) throw new Error('This review has expired. Prepare a fresh review before changing mail.');
    if (exchange.accountIds.some(id => !this.accounts().some(account => account.id === id))) throw new Error('A review account is no longer connected.');
    if (request.autoContinue && !['unread', 'uncategorized'].includes(held.review.kind)) throw new Error('Automatic review is available for unread and uncategorized mail only.');
    if (request.autoContinue && held.automaticExhausted) throw new Error('This automatic review is complete. Refresh the review to check newly arrived mail.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Mail action took too long.')), request.autoContinue ? AUTOMATIC_REVIEW_LIMITS.durationMs : 300_000);
    timeout.unref?.();
    const actionText = request.autoContinue ? 'Automatically mark recommended mail read and review the next batches' : request.undo ? 'Undo the previous read action' : request.action === 'trash' ? 'Move selected conversations to Trash'
      : request.action === 'archive' ? 'Archive selected conversations' : held.review.kind === 'mark_unread' ? 'Mark selected emails unread' : 'Mark selected conversations read';
    const run = this.beginRequest(request.requestId, request.chatId, controller, 'action', actionText, [...exchange.accountIds], exchange.id);
    try {
      if (request.autoContinue) return await this.automaticallyReview(run, exchange, held, onActivity);
      this.reportRun(run, { stage: 'action', status: 'running', message: actionText }, onActivity);
      const ids = [...new Set(request.itemIds)];
      const result = await this.withMailActions(run, async () => request.undo
        ? await undoInboxAssistantReview(held.review, ids, this.reviewDeps(controller.signal), controller.signal)
        : await applyInboxAssistantReview(held.review, ids, this.reviewDeps(controller.signal), controller.signal, { manualSelection: request.manualSelection === true, action: request.action }));
      const completed: InboxAssistantExchange = { ...exchange, review: held.review, reviewResult: result,
        answer: { ...exchange.answer, text: reviewText(held.review) } };
      return this.settleRun(run, undefined, completed)!;
    } catch (error) {
      this.settleRun(run, error);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
    }
  }

  async draftEmail(value: unknown, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantDraft> {
    const request = validateDraftRequest(value);
    this.assertIdle(request.chatId, request.requestId);
    const account = this.accounts().find(item => item.id === request.accountId);
    if (!account) throw new Error('The sending account is no longer connected. Choose another account.');
    const origin = this.recoverChat(this.deps.history.load(request.chatId, { select: false }));
    const chat = { ...origin, exchanges: origin.exchanges.filter(exchange => !exchange.status || exchange.status === 'completed') };
    if (!chat.exchanges.length) throw new Error('Ask Inbox Agent a question before drafting an email from this conversation.');
    const requiredAccounts = new Set([request.accountId, ...chat.exchanges.flatMap(exchange => [
      ...exchange.accountIds, ...exchange.answer.sources.map(source => source.accountId),
    ])]);
    const assertAccounts = () => {
      const current = new Set(this.accounts().map(item => item.id));
      if ([...requiredAccounts].some(id => !current.has(id))) {
        throw new Error('This conversation includes an account that is no longer connected. Reconnect it before drafting the whole conversation.');
      }
    };
    assertAccounts();
    const exchangeIds = origin.exchanges.map(exchange => exchange.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Draft preparation took too long. Try again with shorter instructions.')), 300_000);
    timeout.unref?.();
    const generation = this.generations.get(request.chatId) ?? 0;
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== (this.generations.get(request.chatId) ?? 0)) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Draft preparation cancelled.');
      }
      assertAccounts();
    };
    const run = this.beginRequest(request.requestId, request.chatId, controller, 'draft', request.instructions?.trim() || 'Draft an email from this conversation', [request.accountId, ...new Set(chat.exchanges.flatMap(exchange => exchange.accountIds))]);
    const report = (progress: InboxAssistantProgress) => this.reportRun(run, progress, onActivity);
    try {
      report({ stage: 'context', status: 'done', message: 'Loaded this conversation for drafting', detail: `${chat.exchanges.length} conversation ${chat.exchanges.length === 1 ? 'message' : 'messages'} included.` });
      let availability: LocalCalendarAvailability | undefined;
      if (request.meeting && !this.deps.calendar) throw new Error('The local calendar is unavailable. Open Calendar and try again.');
      if (this.deps.calendar && (request.meeting || isMeetingDraft(chat, request.instructions ?? ''))) {
        const windows = meetingAvailabilityRequests(chat, request.instructions ?? '', this.deps.calendar.preferences(), request.meeting);
        if (windows?.length) {
          report({ stage: 'context', status: 'running', message: 'Checking your local calendar', detail: 'Checking busy events, working hours, buffers and timezone. Other calendar services and recipient availability are not connected yet.' });
          for (const window of windows) {
            const result = await waitForAbortableOperation(Promise.resolve(this.deps.calendar.availability(window)), controller.signal);
            if (result.status !== 'ready') throw new Error('Choose at least one calendar that blocks availability in Calendar before preparing meeting times.');
            if (availability && [...availability.calendarIds].sort().join('\n') !== [...result.calendarIds].sort().join('\n')) throw new Error('Your calendar selection changed. Please prepare the meeting draft again.');
            availability = availability ? { ...availability, slots: [...availability.slots, ...result.slots] } : result;
            if (availability.slots.length >= 3) break;
          }
          availability = { ...availability!, startMs: Math.min(...windows.map(window => window.startMs)), endMs: Math.max(...windows.map(window => window.endMs)),
            slots: [...new Map(availability!.slots.map(slot => [slot.startMs, slot])).values()].sort((a, b) => a.startMs - b.startMs).slice(0, 3) };
          report({ stage: 'context', status: 'done', message: `${availability.slots.length} verified meeting ${availability.slots.length === 1 ? 'option' : 'options'}`, detail: `${availability.timeZone} · Local calendars only` });
        }
      }
      report({ stage: 'answer', status: 'running', message: 'Preparing email draft', detail: account.email });
      const callAI = (prompt: string) => {
        assertCurrent();
        return this.callRunAI(run, prompt, controller.signal);
      };
      const draft = await waitForAbortableOperation(
        generateInboxAssistantDraft(chat, account, request.instructions ?? '', callAI, controller.signal, availability), controller.signal,
      );
      assertCurrent();
      if (availability && this.deps.calendar) {
        report({ stage: 'context', status: 'running', message: 'Rechecking the proposed meeting times' });
        await waitForAbortableOperation(recheckMeetingAvailability(availability, value => this.deps.calendar!.availability(value)), controller.signal);
        assertCurrent();
      }
      const current = this.deps.history.load(request.chatId, { select: false });
      if (current.exchanges.length !== exchangeIds.length || current.exchanges.some((exchange, index) => exchange.id !== exchangeIds[index])) {
        throw new Error('This conversation changed while preparing the draft. Prepare a new draft from the updated conversation.');
      }
      if (draft.chatId !== request.chatId || draft.accountId !== request.accountId) throw new Error('The email draft did not match the requested conversation and account.');
      assertCurrent();
      report({ stage: 'complete', status: 'done', message: 'Email draft ready', detail: 'Review recipients and content in the composer.' });
      run.record.draft = draft;
      this.settleRun(run);
      return draft;
    } catch (error) {
      if (!controller.signal.aborted && generation === (this.generations.get(request.chatId) ?? 0)) {
        report({ stage: 'complete', status: 'warning', message: 'Could not prepare this draft', detail: error instanceof Error ? error.message : 'Please try again.' });
      }
      this.settleRun(run, error);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
    }
  }

  async ask(value: unknown, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantExchange> {
    const request = validateRequest(value);
    this.assertIdle(request.chatId, request.requestId);
    const known = this.accounts();
    const selected = request.accountIds.map(id => {
      const account = known.find(item => item.id === id);
      if (!account) throw new Error('A selected account is no longer connected. Update the account selection and try again.');
      return account;
    });
    const origin = this.recoverChat(this.deps.history.load(request.chatId, { select: false }));
    const history = this.visibleExchanges(origin.exchanges).filter(exchange => !exchange.status || exchange.status === 'completed');
    if (request.previousExchangeId && !history.some(exchange => exchange.id === request.previousExchangeId)) {
      throw new Error('The previous message does not belong to this chat or is no longer available.');
    }
    const context = buildInboxAssistantContext(history, request);
    const { historyContext } = context;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Search took too long. Narrow the question or date range and try again.')), 300_000);
    timeout.unref?.();
    const generation = this.generations.get(request.chatId) ?? 0;
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== (this.generations.get(request.chatId) ?? 0)) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Search cancelled.');
      const current = new Set(this.accounts().map(account => account.id));
      if (request.accountIds.some(id => !current.has(id))) throw new Error('A selected account was disconnected during the search.');
    };
    const run = this.beginRequest(request.requestId, request.chatId, controller, 'question', request.question, request.accountIds, randomUUID());
    const report = (progress: InboxAssistantProgress) => this.reportRun(run, progress, onActivity);
    try {
      const capabilityReply = !request.reviewKind && !request.continueReviewId ? inboxAssistantCapabilityReply(request.question) : undefined;
      if (capabilityReply) {
        const exchange: InboxAssistantExchange = { id: run.record.exchangeId!, chatId: request.chatId, question: request.question,
          accountIds: request.accountIds, createdAt: run.record.startedAt,
          answer: { text: capabilityReply, sources: [], coverage: [], warnings: [] } };
        report({ stage: 'complete', status: 'done', message: 'Inbox Agent capabilities', detail: 'No email search or AI request was needed.' });
        return this.settleRun(run, undefined, exchange)!;
      }
      if (historyContext) report({ stage: 'context', status: 'done', message: 'Loaded conversation context', detail: 'Earlier questions supply context; original emails and attachments are checked again for facts.' });
      report({ stage: 'search', status: 'running', message: 'Preparing email search', detail: `Searching ${selected.length} selected ${selected.length === 1 ? 'account' : 'accounts'}, including Sent and Archive.` });
      const callAI = (prompt: string) => { assertCurrent(); return this.callRunAI(run, prompt, controller.signal, 8_000); };
      const command = parseInboxAssistantReadCommand(request.question);
      // Never reinterpret a rejected mark-unread command as low-value triage
      // (which has the opposite flag direction). Only parsed literal scopes can
      // enter the explicit flag tool.
      if ((!command && (/\bmark\b[\s\S]*\bunread\b/iu.test(request.question)
          || /^(?:(?:please|can you|could you|would you)\s+)?mark\b[\s\S]*\bread\b/iu.test(request.question)))
        || (request.reviewKind?.startsWith('mark_') && command?.kind !== request.reviewKind)
        || (command && request.reviewKind && command.kind !== request.reviewKind)) {
        throw new Error('Specify the matching sender, subject or phrase, for example “Mark all BigBlueButton emails unread”. Date, category and combined restrictions are not supported by this command yet. No mail was changed.');
      }
      const reviewKind = command?.kind ?? request.reviewKind ?? inboxAssistantReviewIntent(request.question);
      if (reviewKind) {
        if (!command && !inboxAssistantGenericReviewRequest(request.question)) {
          throw new Error('This unread review uses the selected accounts. Sender, date and category restrictions are not supported yet, so no mail was changed. Use “Review my unread emails” or choose fewer accounts.');
        }
        if (/\ball\s+accounts\b/i.test(request.question) && selected.length !== known.length) throw new Error('Select all accounts before reviewing mail across all accounts. No mail was changed.');
        const excludedThreads: Record<string, string[]> = {};
        if (request.continueReviewId) {
          const prior = this.actionReviews.get(request.continueReviewId);
          if (!prior || prior.chatId !== request.chatId || prior.review.kind !== reviewKind || prior.review.expiresAt <= Date.now()
            || JSON.stringify(prior.review.scope) !== JSON.stringify(command?.scope)
            || prior.review.accounts.length !== selected.length || prior.review.accounts.some(account => !request.accountIds.includes(account.id))) {
            throw new Error('This review continuation expired or its account scope changed. Start a fresh review.');
          }
          for (const account of selected) excludedThreads[account.id] = [...new Set([
            ...(prior.excludedThreads[account.id] ?? []), ...prior.review.items.filter(item => item.accountId === account.id).map(item => item.threadId),
          ])];
        }
        report({ stage: 'search', status: 'running', message: command ? 'Finding matching emails' : 'Reviewing unread conversations', detail: command ? `Matching “${command.scope.query}” in ${command.scope.field === 'any' ? 'sender, subject and original body' : command.scope.field}. Preparing mark as ${command.kind === 'mark_unread' ? 'unread' : 'read'}.` : 'Including uncategorized mail and checking every unread member of each conversation.' });
        const reviewCacheIdentity = this.deps.reviewCacheIdentity?.();
        const review = await waitForAbortableOperation(prepareInboxAssistantReview(selected, reviewKind, this.reviewDeps(controller.signal), controller.signal, report, { excludeThreadIds: excludedThreads,
          recommendationCache: this.recommendationCache, reviewCacheIdentity, isCacheCurrent: () => this.deps.reviewCacheIdentity?.() === reviewCacheIdentity,
          ...(command ? { scope: command.scope } : {}) }), controller.signal);
        assertCurrent();
        const exchange: InboxAssistantExchange = {
          id: run.record.exchangeId!, chatId: request.chatId, question: request.question, accountIds: request.accountIds, createdAt: run.record.startedAt, review,
          answer: { text: reviewText(review), sources: [], coverage: [], warnings: review.coverage.flatMap(account => account.warnings) },
        };
        this.rememberReview(request.chatId, exchange.id, review, excludedThreads);
        // Approval is a saved choice for user requests in this conversation.
        // Changing it never starts work by itself or enables a mail daemon.
        const mode = this.deps.history.load(request.chatId, { select: false }).actionMode ?? 'review';
        if (mode === 'approve_for_me' && !request.reviewOnly) {
          const ids = review.items.filter(item => command
            ? item.recommendation === command.kind && item.confidence === 1 && (item.targetEmailIds?.length ?? 0) > 0
            : item.recommendation === 'mark_read' && item.confidence >= 0.9
              && !item.protectedReasons.length && !item.bodyUnavailable && !item.attachmentsUnknown).map(item => item.id);
          if (ids.length) {
            report({ stage: 'action', status: 'running', message: command ? `Marking matching emails as ${command.kind === 'mark_unread' ? 'unread' : 'read'}` : 'Marking high-confidence low-value conversations as read', detail: command ? 'Changing only the matching messages in the reviewed account scope.' : 'Protected and uncertain conversations stay unread.' });
            exchange.reviewResult = await this.withMailActions(run, () => applyInboxAssistantReview(review, ids, this.reviewDeps(controller.signal), controller.signal));
            exchange.answer.text = reviewText(review);
          }
        }
        report({ stage: 'complete', status: 'done', message: command ? 'Matching email review ready' : 'Unread review ready', detail: `${review.items.length} conversations reviewed.` });
        return this.settleRun(run, undefined, exchange)!;
      }
      const timeZone = researchTimeZone(this.deps);
      const plan = await planInboxAssistantSearch(context.contextualizedQuestion, prompt => {
        assertCurrent();
        return this.callRunAI(run, prompt, controller.signal, 1_600);
      }, {
        historyContext, topicTerms: context.topicTerms, participantTerms: context.participantTerms, intent: context.intent,
        nowMs: this.deps.now?.() ?? Date.now(),
        timeZone,
      });
      assertCurrent();
      const research = await waitForAbortableOperation(researchInboxAssistant(selected, plan, this.deps, controller.signal, {
        onProgress: report, sourceRefs: context.sourceRefs,
      }), controller.signal);
      assertCurrent();
      report({ stage: 'answer', status: 'running', message: 'Preparing answer from sources', detail: `${research.evidence.length} source excerpts collected.` });
      const answerEvidence = research.evidence.map(source => ({ ...source, dateTimeZone: timeZone }));
      const grounded = await answerInboxAssistant(request.question, answerEvidence, research.coverage, callAI, historyContext, plan.scope);
      assertCurrent();
      const used = new Set(grounded.sourceIds);
      // Unverified originals remain inspectable as explicitly related mail.
      // They are never presented as sources supporting a successful answer.
      const sources = (used.size ? research.evidence.filter(source => used.has(source.id)) : research.evidence.slice(0, 6))
        .map(({ text: _text, ...source }) => ({ ...source,
          excerpt: grounded.facts.flatMap(fact => fact.quotes).find(quote => quote.sourceId === source.id)?.text.slice(0, 1000) || source.excerpt,
        }));
      const exchange: InboxAssistantExchange = {
        id: run.record.exchangeId!, chatId: request.chatId, question: request.question, accountIds: request.accountIds, createdAt: run.record.startedAt,
        answer: { text: grounded.answer, sources, sourceStatus: used.size ? 'verified' : 'related', coverage: research.coverage,
          warnings: grounded.warnings },
      };
      assertCurrent();
      report({ stage: 'complete', status: used.size ? 'done' : 'warning', message: used.size ? 'Answer verified against sources' : sources.length ? 'Related emails found; answer not verified' : 'No supporting email found',
        detail: used.size ? `${sources.length} cited ${sources.length === 1 ? 'source' : 'sources'}.`
          : sources.length ? 'Related originals are available to inspect. They do not support a verified answer.' : 'Check the search coverage and account scope before concluding that no email exists.' });
      return this.settleRun(run, undefined, exchange)!;
    } catch (error) {
      if (!controller.signal.aborted && generation === (this.generations.get(request.chatId) ?? 0)) {
        report({ stage: 'complete', status: 'warning', message: 'Could not finish this question', detail: error instanceof Error ? error.message : 'Please try again.' });
      }
      this.settleRun(run, error);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
    }
  }
}
