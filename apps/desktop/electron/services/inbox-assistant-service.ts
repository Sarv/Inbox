import { randomUUID } from 'node:crypto';

import { waitForAbortableOperation } from '@sarvinbox/core';

import type { InboxAssistantAccount, InboxAssistantActivity, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange, InboxAssistantProgress, InboxAssistantRequest } from '../../src/types/inbox-assistant';

import { answerInboxAssistant, planInboxAssistantSearch } from './inbox-assistant-answer';
import { buildInboxAssistantContext } from './inbox-assistant-context';
import { generateInboxAssistantDraft } from './inbox-assistant-draft';
import type { InboxAssistantHistoryStore } from './inbox-assistant-history';
import { researchInboxAssistant, type AssistantResearchDeps } from './inbox-assistant-retrieval';

export interface InboxAssistantServiceDeps extends AssistantResearchDeps {
  accounts(): InboxAssistantAccount[];
  callAI(prompt: string, signal: AbortSignal): Promise<string>;
  history: InboxAssistantHistoryStore;
}

function validateRequest(value: unknown): InboxAssistantRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid Inbox Agent question.');
  const request = value as InboxAssistantRequest;
  if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.requestId)
    || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
    || typeof request.question !== 'string' || !request.question.trim() || request.question.length > 4000
    || !Array.isArray(request.accountIds) || !request.accountIds.length
    || !request.accountIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 500)
    || (request.previousExchangeId !== undefined && typeof request.previousExchangeId !== 'string')) {
    throw new Error('Enter a question and select at least one account. Questions can contain up to 4,000 characters.');
  }
  return { ...request, question: request.question.trim(), accountIds: [...new Set(request.accountIds)] };
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
  private running: { id: string; chatId: string; controller: AbortController } | null = null;
  private generations = new Map<string, number>();

  constructor(private deps: InboxAssistantServiceDeps) {}

  accounts(): InboxAssistantAccount[] { return this.deps.accounts(); }

  private visibleExchanges(exchanges: InboxAssistantExchange[]): InboxAssistantExchange[] {
    const registered = new Set(this.accounts().map(account => account.id));
    return exchanges.filter(exchange => exchange.accountIds.every(id => registered.has(id)));
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
    const request = value as { chatId?: unknown; pinned?: unknown } | null;
    if (!request || Array.isArray(request) || !Object.keys(request).every(key => ['chatId', 'pinned'].includes(key))
      || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)
      || typeof request.pinned !== 'boolean') {
      throw new Error('Choose whether to pin this chat.');
    }
    return this.deps.history.update(request.chatId, { pinned: request.pinned });
  }

  deleteChat(value: unknown): InboxAssistantChatList {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Inbox Agent chat.');
    const result = this.deps.history.delete(value);
    this.generations.set(value, (this.generations.get(value) ?? 0) + 1);
    if (this.running?.chatId === value) this.running.controller.abort(new Error('This conversation was deleted.'));
    return result;
  }

  history(): InboxAssistantExchange[] { return this.visibleExchanges(this.deps.history.read()); }

  cancel(requestId: string): void {
    if (this.running?.id === requestId) this.running.controller.abort();
  }

  clearHistory(): void {
    const active = this.deps.history.list().activeChatId;
    if (!active) return;
    this.generations.set(active, (this.generations.get(active) ?? 0) + 1);
    if (this.running?.chatId === active) this.running.controller.abort();
    this.deps.history.clear(active);
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
    this.running = { id: request.requestId, chatId: request.chatId, controller };
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
      if (this.running?.controller === controller) this.running = null;
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
    this.running = { id: request.requestId, chatId: request.chatId, controller };
    try {
      if (historyContext) report({ stage: 'context', status: 'done', message: 'Loaded conversation context', detail: 'Earlier questions supply context; original emails and attachments are checked again for facts.' });
      report({ stage: 'search', status: 'running', message: 'Preparing email search', detail: `Searching ${selected.length} selected ${selected.length === 1 ? 'account' : 'accounts'}, including Sent and Archive.` });
      const callAI = (prompt: string) => { assertCurrent(); return waitForAbortableOperation(this.deps.callAI(prompt, controller.signal), controller.signal); };
      const plan = await planInboxAssistantSearch(context.contextualizedQuestion, callAI, { historyContext });
      assertCurrent();
      const research = await researchInboxAssistant(selected, plan, this.deps, controller.signal, {
        onProgress: report, sourceRefs: context.sourceRefs,
      });
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
      if (this.running?.controller === controller) this.running = null;
    }
  }
}
