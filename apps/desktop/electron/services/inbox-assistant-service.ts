import { randomUUID } from 'node:crypto';

import { waitForAbortableOperation } from '@sarvinbox/core';

import type { InboxAssistantAccount, InboxAssistantActionMode, InboxAssistantActivity, InboxAssistantCancellation, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange, InboxAssistantProgress, InboxAssistantRequest, InboxAssistantReviewActionRequest, InboxAssistantRewind } from '../../src/types/inbox-assistant';
import type { InboxAssistantReview, InboxAssistantReviewKind } from '../../src/types/inbox-assistant-actions';

import { applyInboxAssistantReview, parseInboxAssistantReadCommand, prepareInboxAssistantReview, undoInboxAssistantReview, type InboxAssistantActionDeps } from './inbox-assistant-actions';
import { answerInboxAssistant, planInboxAssistantSearch } from './inbox-assistant-answer';
import { buildInboxAssistantContext } from './inbox-assistant-context';
import { generateInboxAssistantDraft } from './inbox-assistant-draft';
import type { InboxAssistantHistoryStore } from './inbox-assistant-history';
import { researchInboxAssistant, type AssistantResearchDeps } from './inbox-assistant-retrieval';

export interface InboxAssistantServiceDeps extends AssistantResearchDeps {
  accounts(): InboxAssistantAccount[];
  callAI(prompt: string, signal: AbortSignal): Promise<string>;
  history: InboxAssistantHistoryStore;
  setRead?: InboxAssistantActionDeps['setRead'];
  moveMail?: InboxAssistantActionDeps['moveMail'];
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
  if (!Object.keys(request).every(key => ['requestId', 'chatId', 'accountId', 'instructions'].includes(key))
    || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.requestId)
    || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
    || typeof request.accountId !== 'string' || !request.accountId || request.accountId.length > 500
    || (request.instructions !== undefined && (typeof request.instructions !== 'string' || request.instructions.length > 4_000))) {
    throw new Error('Choose a conversation and sending account. Draft instructions can contain up to 4,000 characters.');
  }
  return { requestId: request.requestId, chatId: request.chatId, accountId: request.accountId,
    ...(request.instructions?.trim() ? { instructions: request.instructions.trim() } : {}) };
}

export class InboxAssistantService {
  private running: { id: string; chatId: string; controller: AbortController; mutating?: boolean; settled: Promise<void>; finish(): void } | null = null;
  private generations = new Map<string, number>();
  private actionReviews = new Map<string, { chatId: string; exchangeId: string; review: InboxAssistantReview; excludedThreads: Record<string, string[]> }>();

  constructor(private deps: InboxAssistantServiceDeps) {}

  private beginRequest(id: string, chatId: string, controller: AbortController, mutating = false): void {
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    this.running = { id, chatId, controller, mutating, settled, finish };
  }

  private finishRequest(controller: AbortController): void {
    if (this.running?.controller !== controller) return;
    const run = this.running;
    this.running = null;
    run.finish();
  }

  private markRequestMutating(controller: AbortController): void {
    if (this.running?.controller === controller) this.running.mutating = true;
  }

  accounts(): InboxAssistantAccount[] { return this.deps.accounts(); }

  private visibleExchanges(exchanges: InboxAssistantExchange[]): InboxAssistantExchange[] {
    const registered = new Set(this.accounts().map(account => account.id));
    return exchanges.filter(exchange => exchange.accountIds.every(id => registered.has(id))).map(exchange => {
      if (!exchange.review || (this.actionReviews.has(exchange.review.id) && exchange.review.expiresAt > Date.now())) return exchange;
      return { ...exchange, review: { ...exchange.review, status: 'expired' } };
    });
  }

  chats(): InboxAssistantChatList { return this.deps.history.list(); }

  chat(id: unknown): InboxAssistantChat {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid Inbox Agent chat.');
    const chat = this.deps.history.load(id);
    return { ...chat, exchanges: this.visibleExchanges(chat.exchanges) };
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
    if (request.actionMode === 'review' && this.running?.chatId === request.chatId && this.running.mutating) this.running.controller.abort();
    return result;
  }

  deleteChat(value: unknown): InboxAssistantChatList {
    if (this.running?.mutating && this.running.chatId === value) throw new Error('Wait for the current mail action to finish before deleting this conversation.');
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Inbox Agent chat.');
    const result = this.deps.history.delete(value);
    this.generations.set(value, (this.generations.get(value) ?? 0) + 1);
    if (this.running?.chatId === value) this.running.controller.abort(new Error('This conversation was deleted.'));
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
    if (this.running?.chatId === request.chatId) throw new Error('A new request started in this conversation. Stop it before rewinding.');
    const result = this.deps.history.rewind(request.chatId, request.exchangeId);
    this.invalidateReviews(request.chatId);
    return { ...result, chat: { ...result.chat, exchanges: this.visibleExchanges(result.chat.exchanges) } };
  }

  async restoreRewindChat(value: unknown): Promise<InboxAssistantChat> {
    const request = value as { chatId?: unknown } | null;
    if (!request || Array.isArray(request) || !Object.keys(request).every(key => key === 'chatId')
      || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)) throw new Error('Choose a conversation to restore.');
    await this.stopForHistoryChange(request.chatId);
    if (this.running?.chatId === request.chatId) throw new Error('A new request started in this conversation. Stop it before restoring.');
    const chat = this.deps.history.restoreRewind(request.chatId);
    this.invalidateReviews(request.chatId);
    return { ...chat, exchanges: this.visibleExchanges(chat.exchanges) };
  }

  private async stopForHistoryChange(chatId: string): Promise<void> {
    if (this.running?.chatId !== chatId) return;
    if (this.running.mutating) throw new Error('Stop the current mail action and wait for its receipt before rewinding this conversation.');
    await this.cancel(this.running.id);
  }

  private invalidateReviews(chatId: string): void {
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    for (const [id, entry] of this.actionReviews) if (entry.chatId === chatId) this.actionReviews.delete(id);
  }

  history(): InboxAssistantExchange[] { return this.visibleExchanges(this.deps.history.read()); }

  async cancel(value: unknown): Promise<InboxAssistantCancellation> {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Inbox Agent request to stop.');
    const run = this.running;
    if (run?.id !== value) return { requestId: value, cancelled: false };
    run.controller.abort(new Error('Request cancelled.'));
    // A mail write already acknowledged by the durable queue must finish its
    // receipt. New work can begin once this exact run has released ownership.
    await run.settled;
    return { requestId: value, cancelled: true };
  }

  clearHistory(): void {
    const active = this.deps.history.list().activeChatId;
    if (!active) return;
    if (this.running?.mutating && this.running.chatId === active) throw new Error('Wait for the current mail action to finish before clearing this conversation.');
    this.generations.set(active, (this.generations.get(active) ?? 0) + 1);
    if (this.running?.chatId === active) this.running.controller.abort();
    this.deps.history.clear(active);
    for (const [id, entry] of this.actionReviews) if (entry.chatId === active) this.actionReviews.delete(id);
  }

  private reviewDeps(signal: AbortSignal): InboxAssistantActionDeps {
    return {
      openMailbox: accountId => {
        if (signal.aborted) throw new Error('Request stopped.');
        if (!this.accounts().some(account => account.id === accountId)) throw new Error('The review account is no longer connected.');
        return this.deps.openMailbox(accountId);
      },
      callAI: (prompt, stepSignal) => {
        const effective = stepSignal ? AbortSignal.any([signal, stepSignal]) : signal;
        if (effective.aborted) throw new Error('Request stopped.');
        return waitForAbortableOperation(this.deps.callAI(prompt, effective), effective);
      },
      setRead: async (accountId, ids, read) => {
        if (signal.aborted) throw new Error('Request stopped.');
        if (!this.accounts().some(account => account.id === accountId)) throw new Error('The review account is no longer connected.');
        if (!this.deps.setRead) throw new Error('Mail actions are unavailable. Restart the app after updating.');
        return this.deps.setRead(accountId, ids, read);
      },
      moveMail: async (accountId, ids, action) => {
        if (signal.aborted) throw new Error('Request stopped.');
        if (!this.accounts().some(account => account.id === accountId)) throw new Error('The review account is no longer connected.');
        if (!this.deps.moveMail) throw new Error('Folder actions are unavailable. Restart the app after updating.');
        return this.deps.moveMail(accountId, ids, action);
      },
    };
  }

  async applyReview(value: unknown): Promise<InboxAssistantExchange> {
    const request = value as InboxAssistantReviewActionRequest;
    if (!request || !Object.keys(request).every(key => ['requestId', 'chatId', 'exchangeId', 'reviewId', 'itemIds', 'undo', 'manualSelection', 'action'].includes(key))
      || ![request.requestId, request.chatId, request.exchangeId, request.reviewId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id))
      || !Array.isArray(request.itemIds) || !request.itemIds.length || request.itemIds.length > 600
      || request.itemIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      || (request.undo !== undefined && typeof request.undo !== 'boolean')
      || (request.manualSelection !== undefined && typeof request.manualSelection !== 'boolean')
      || (request.action !== undefined && !['mark_read', 'mark_unread', 'archive', 'trash'].includes(request.action))
      || ((request.action === 'archive' || request.action === 'trash') && request.manualSelection !== true)
      || (request.undo && (request.manualSelection || request.action !== undefined))) throw new Error('Choose valid reviewed conversations.');
    if (this.running) throw new Error('Wait for the current Inbox Agent request to finish.');
    const held = this.actionReviews.get(request.reviewId);
    const chat = this.deps.history.load(request.chatId, { select: false });
    const exchange = chat.exchanges.find(item => item.id === request.exchangeId && item.review?.id === request.reviewId);
    if (!held || held.chatId !== request.chatId || held.exchangeId !== request.exchangeId || !exchange
      || held.review.expiresAt <= Date.now()) throw new Error('This review has expired. Prepare a fresh review before changing mail.');
    if (exchange.accountIds.some(id => !this.accounts().some(account => account.id === id))) throw new Error('A review account is no longer connected.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Mail action took too long.')), 300_000);
    timeout.unref?.();
    this.beginRequest(request.requestId, request.chatId, controller, true);
    try {
      const ids = [...new Set(request.itemIds)];
      const result = request.undo
        ? await undoInboxAssistantReview(held.review, ids, this.reviewDeps(controller.signal), controller.signal)
        : await applyInboxAssistantReview(held.review, ids, this.reviewDeps(controller.signal), controller.signal, { manualSelection: request.manualSelection === true, action: request.action });
      const completed: InboxAssistantExchange = { ...exchange, review: held.review, reviewResult: result,
        answer: { ...exchange.answer, text: reviewText(held.review) } };
      const current = this.deps.history.load(request.chatId, { select: false });
      this.deps.history.writeChat({ ...current, exchanges: current.exchanges.map(item => item.id === completed.id ? completed : item) });
      return completed;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
    }
  }

  async draftEmail(value: unknown, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantDraft> {
    const request = validateDraftRequest(value);
    if (this.running) throw new Error('Another Inbox Agent request is still running. Cancel it before preparing an email draft.');
    const account = this.accounts().find(item => item.id === request.accountId);
    if (!account) throw new Error('The sending account is no longer connected. Choose another account.');
    const chat = this.deps.history.load(request.chatId, { select: false });
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
    const exchangeIds = chat.exchanges.map(exchange => exchange.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Draft preparation took too long. Try again with shorter instructions.')), 300_000);
    timeout.unref?.();
    const generation = this.generations.get(request.chatId) ?? 0;
    let sequence = 0;
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== (this.generations.get(request.chatId) ?? 0)) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Draft preparation cancelled.');
      }
      assertAccounts();
    };
    const report = (progress: InboxAssistantProgress) => {
      if (controller.signal.aborted || generation !== (this.generations.get(request.chatId) ?? 0)) return;
      try { onActivity?.({ ...progress, requestId: request.requestId, chatId: request.chatId, sequence: ++sequence, at: Date.now() }); }
      catch { /* The requesting window may have closed. */ }
    };
    this.beginRequest(request.requestId, request.chatId, controller);
    try {
      report({ stage: 'context', status: 'done', message: 'Loaded this conversation for drafting', detail: `${chat.exchanges.length} conversation ${chat.exchanges.length === 1 ? 'message' : 'messages'} included.` });
      report({ stage: 'answer', status: 'running', message: 'Preparing email draft', detail: account.email });
      const callAI = (prompt: string) => {
        assertCurrent();
        return waitForAbortableOperation(this.deps.callAI(prompt, controller.signal), controller.signal);
      };
      const draft = await waitForAbortableOperation(
        generateInboxAssistantDraft(chat, account, request.instructions ?? '', callAI, controller.signal), controller.signal,
      );
      assertCurrent();
      const current = this.deps.history.load(request.chatId, { select: false });
      if (current.exchanges.length !== exchangeIds.length || current.exchanges.some((exchange, index) => exchange.id !== exchangeIds[index])) {
        throw new Error('This conversation changed while preparing the draft. Prepare a new draft from the updated conversation.');
      }
      if (draft.chatId !== request.chatId || draft.accountId !== request.accountId) throw new Error('The email draft did not match the requested conversation and account.');
      assertCurrent();
      report({ stage: 'complete', status: 'done', message: 'Email draft ready', detail: 'Review recipients and content in the composer.' });
      return draft;
    } catch (error) {
      if (!controller.signal.aborted && generation === (this.generations.get(request.chatId) ?? 0)) {
        report({ stage: 'complete', status: 'warning', message: 'Could not prepare this draft', detail: error instanceof Error ? error.message : 'Please try again.' });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
    }
  }

  async ask(value: unknown, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantExchange> {
    const request = validateRequest(value);
    if (this.running) throw new Error('Another Inbox Agent question is still running. Cancel it before starting a new question.');
    const known = this.accounts();
    const selected = request.accountIds.map(id => {
      const account = known.find(item => item.id === id);
      if (!account) throw new Error('A selected account is no longer connected. Update the account selection and try again.');
      return account;
    });
    const origin = this.deps.history.load(request.chatId, { select: false });
    const history = this.visibleExchanges(origin.exchanges);
    if (request.previousExchangeId && !history.some(exchange => exchange.id === request.previousExchangeId)) {
      throw new Error('The previous message does not belong to this chat or is no longer available.');
    }
    const context = buildInboxAssistantContext(history, request);
    const { historyContext } = context;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Search took too long. Narrow the question or date range and try again.')), 300_000);
    timeout.unref?.();
    const generation = this.generations.get(request.chatId) ?? 0;
    const activities: InboxAssistantActivity[] = [];
    let sequence = 0;
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== (this.generations.get(request.chatId) ?? 0)) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Search cancelled.');
      const current = new Set(this.accounts().map(account => account.id));
      if (request.accountIds.some(id => !current.has(id))) throw new Error('A selected account was disconnected during the search.');
    };
    const report = (progress: InboxAssistantProgress) => {
      // A queued network operation may settle after cancellation. Progress must
      // neither reach a new run nor throw inside the sync engine's callbacks.
      if (controller.signal.aborted || generation !== (this.generations.get(request.chatId) ?? 0)) return;
      const activity: InboxAssistantActivity = { ...progress, requestId: request.requestId, chatId: request.chatId, sequence: ++sequence, at: Date.now() };
      activities.push(activity);
      if (activities.length > 400) activities.shift();
      // A closed renderer must not interrupt mailbox research or persistence.
      try { onActivity?.(activity); } catch { /* The caller may have closed its window. */ }
    };
    this.beginRequest(request.requestId, request.chatId, controller);
    try {
      if (historyContext) report({ stage: 'context', status: 'done', message: 'Loaded conversation context', detail: 'Earlier questions supply context; original emails and attachments are checked again for facts.' });
      report({ stage: 'search', status: 'running', message: 'Preparing email search', detail: `Searching ${selected.length} selected ${selected.length === 1 ? 'account' : 'accounts'}, including Sent and Archive.` });
      const callAI = (prompt: string) => { assertCurrent(); return waitForAbortableOperation(this.deps.callAI(prompt, controller.signal), controller.signal); };
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
        const review = await waitForAbortableOperation(prepareInboxAssistantReview(selected, reviewKind, this.reviewDeps(controller.signal), controller.signal, report, { excludeThreadIds: excludedThreads, ...(command ? { scope: command.scope } : {}) }), controller.signal);
        assertCurrent();
        const exchange: InboxAssistantExchange = {
          id: randomUUID(), chatId: request.chatId, question: request.question, accountIds: request.accountIds, createdAt: Date.now(), review,
          answer: { text: reviewText(review), sources: [], coverage: [], warnings: review.coverage.flatMap(account => account.warnings) },
        };
        for (const [id, held] of this.actionReviews) if (held.review.expiresAt <= Date.now()) this.actionReviews.delete(id);
        while (this.actionReviews.size >= 20) this.actionReviews.delete(this.actionReviews.keys().next().value!);
        this.actionReviews.set(review.id, { chatId: request.chatId, exchangeId: exchange.id, review, excludedThreads });
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
            this.markRequestMutating(controller);
            exchange.reviewResult = await applyInboxAssistantReview(review, ids, this.reviewDeps(controller.signal), controller.signal);
            exchange.answer.text = reviewText(review);
          }
        }
        report({ stage: 'complete', status: 'done', message: command ? 'Matching email review ready' : 'Unread review ready', detail: `${review.items.length} conversations reviewed.` });
        exchange.activities = activities;
        const current = this.deps.history.load(request.chatId, { select: false });
        this.deps.history.writeChat({ ...current, exchanges: [...current.exchanges, exchange] });
        return exchange;
      }
      const plan = await planInboxAssistantSearch(context.contextualizedQuestion, callAI, {
        historyContext, topicTerms: context.topicTerms, participantTerms: context.participantTerms, intent: context.intent,
      });
      assertCurrent();
      const research = await waitForAbortableOperation(researchInboxAssistant(selected, plan, this.deps, controller.signal, {
        onProgress: report, sourceRefs: context.sourceRefs,
      }), controller.signal);
      assertCurrent();
      report({ stage: 'answer', status: 'running', message: 'Preparing answer from sources', detail: `${research.evidence.length} source excerpts collected.` });
      const grounded = await answerInboxAssistant(request.question, research.evidence, research.coverage, callAI, historyContext);
      assertCurrent();
      const used = new Set(grounded.sourceIds);
      // When a model cannot verify a fact, offer the retrieved originals rather
      // than inventing an answer or hiding useful source links.
      const sources = (used.size ? research.evidence.filter(source => used.has(source.id)) : research.evidence.slice(0, 12))
        .map(({ text: _text, ...source }) => ({ ...source,
          excerpt: grounded.facts.flatMap(fact => fact.quotes).find(quote => quote.sourceId === source.id)?.text.slice(0, 1000) || source.excerpt,
        }));
      const exchange: InboxAssistantExchange = {
        id: randomUUID(), chatId: request.chatId, question: request.question, accountIds: request.accountIds, createdAt: Date.now(),
        answer: { text: grounded.answer, sources, coverage: research.coverage,
          warnings: grounded.warnings },
      };
      assertCurrent();
      report({ stage: 'complete', status: 'done', message: 'Answer ready', detail: `${sources.length} linked ${sources.length === 1 ? 'source' : 'sources'}.` });
      exchange.activities = activities;
      const currentOrigin = this.deps.history.load(request.chatId, { select: false });
      this.deps.history.writeChat({ ...currentOrigin, exchanges: [...currentOrigin.exchanges, exchange] });
      return exchange;
    } catch (error) {
      if (!controller.signal.aborted && generation === (this.generations.get(request.chatId) ?? 0)) {
        report({ stage: 'complete', status: 'warning', message: 'Could not finish this question', detail: error instanceof Error ? error.message : 'Please try again.' });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
    }
  }
}
