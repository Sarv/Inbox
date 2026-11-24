import { randomUUID } from 'node:crypto';

import { createLogger, errorDiagnostic, waitForAbortableOperation, type AIChatRequest, type AIChatResult } from '@sarvinbox/core';

import type { InboxAssistantAccount, InboxAssistantActionMode, InboxAssistantActivity, InboxAssistantAIUsage, InboxAssistantAIWorkload, InboxAssistantCancellation, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange, InboxAssistantProgress, InboxAssistantRequest, InboxAssistantRewind, InboxAssistantRunRecord, InboxAssistantAIPurpose, InboxAssistantRunDiagnostics } from '../../src/types/inbox-assistant';
import type { InboxAgentChangeSetRequest, InboxAgentUndoRequest } from '../../src/types/inbox-assistant-changes';
import type { LocalCalendarAvailability, LocalCalendarAvailabilityRequest, LocalCalendarPreferences } from '../../src/types/local-calendar';
import { readInboxAssistantAIWorkload } from '../../src/utils/inbox-assistant-workload';

import { isMeetingDraft, meetingAvailabilityRequests, recheckMeetingAvailability } from './assistant-calendar';
import { runInboxAgent, type InboxAgentProtocol } from './inbox-assistant-agent';
import type { InboxAgentChangeContext } from './inbox-assistant-agent-tools';
import { INBOX_ASSISTANT_OUTPUT_TOKENS, planInboxAssistantSearch } from './inbox-assistant-answer';
import type { InboxAgentChangeJournal } from './inbox-assistant-change-journal';
import { applyChangeSet, cancelChangeSet, changeCounts, INBOX_AGENT_CHANGE_LIMITS, openApprovalWindow, undoChangeSet, type HeldChangeSet, type InboxAgentEmailReader, type InboxAgentMailActions } from './inbox-assistant-change-sets';
import { buildInboxAssistantContext } from './inbox-assistant-context';
import { inboxAssistantDegradedStages, inboxAssistantRunSummary } from './inbox-assistant-diagnostics';
import { generateInboxAssistantDraft } from './inbox-assistant-draft';
import type { InboxAssistantHistoryStore } from './inbox-assistant-history';
import { researchInboxAssistant, type AssistantResearchDeps } from './inbox-assistant-retrieval';
import { applySettingChange, cancelSettingChange, openSettingApprovalWindow, undoSettingChange, type HeldSettingChange, type InboxAgentSettingActions } from './inbox-assistant-setting-changes';
import { aggregateInboxAssistantUsage, INBOX_ASSISTANT_SYSTEM_PROMPT } from './inbox-assistant-usage';

export interface InboxAssistantServiceDeps extends AssistantResearchDeps {
  accounts(): InboxAssistantAccount[];
  callAI(prompt: string, signal: AbortSignal, onUsage?: (usage: InboxAssistantAIUsage) => void, options?: { maxOutputTokens?: number }): Promise<string>;
  /** A multi-turn tool call: the agent loop. */
  callAIChat(request: AIChatRequest, signal: AbortSignal, onUsage?: (usage: InboxAssistantAIUsage) => void): Promise<AIChatResult>;
  /** Which provider and model answer now: the agent remembers per identity how calling it succeeded. */
  providerIdentity?(): string;
  now?(): number;
  timeZone?(): string;
  history: InboxAssistantHistoryStore;
  /** How the agent's approved change sets reach the mailbox. Absent: the agent can only read. */
  mailActions?: InboxAgentMailActions;
  /** How the agent's approved setting changes (filters, senders) are saved. Absent: the setting tools are not offered. */
  settingActions?: InboxAgentSettingActions;
  /** Where open cards are kept across a restart. Absent: they expire when the app quits. */
  changeJournal?: InboxAgentChangeJournal;
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
  /**
   * The agent's change context, while a question runs. The renderer does not
   * offer the mode while a request runs; as defence in depth, switching the
   * chat to "Ask for approval" narrows it at once, so the rest of the run waits
   * for cards (a change already waiting its turn stops the run: see
   * withMailActions); switching to "Approve for me" never widens a run already going.
   */
  changes?: InboxAgentChangeContext;
  settled: Promise<void>;
  finish(): void;
}

// Content-free lines only: see inbox-assistant-diagnostics.ts.
const logger = createLogger('InboxAssistant');

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
  return { requestId: request.requestId, chatId: request.chatId, question: request.question.trim(), accountIds: [...new Set(request.accountIds)],
    ...(request.previousExchangeId !== undefined ? { previousExchangeId: request.previousExchangeId } : {}) };
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
  /** The agent's change sets, by id: what a card's Approve, Cancel and Undo act on. */
  private heldSets = new Map<string, { chatId: string; exchangeId: string; accounts: InboxAssistantAccount[]; held: HeldChangeSet }>();
  /** The agent's setting changes, by id, likewise. */
  private heldSettings = new Map<string, { chatId: string; exchangeId: string; accounts: InboxAssistantAccount[]; held: HeldSettingChange }>();
  private journalLoaded = false;
  /** How the agent last succeeded in calling each provider identity, so a refusal is paid for once. */
  private agentProtocols = new Map<string, InboxAgentProtocol>();

  // The service is built when its IPC module loads, before main.ts names the
  // app: anything that opens the core database there fixes the data folder
  // (and keychain item) to the RELEASE app's. So the journal is read on first
  // use, never in the constructor.
  constructor(private deps: InboxAssistantServiceDeps) {}

  /** Cards from before a restart keep their buttons while their windows last. Read once, on first use. */
  private loadJournal(): void {
    if (this.journalLoaded) return;
    this.journalLoaded = true;
    const saved = this.deps.changeJournal?.load(this.deps.now?.() ?? Date.now());
    for (const entry of saved?.sets ?? []) this.heldSets.set(entry.held.set.id, entry);
    for (const entry of saved?.settings ?? []) this.heldSettings.set(entry.held.change.id, entry);
  }

  private get changeSets() { this.loadJournal(); return this.heldSets; }
  private get settingChanges() { this.loadJournal(); return this.heldSettings; }

  /** Save what the cards can still do, so it survives a restart. */
  private saveJournal(): void {
    this.deps.changeJournal?.save({ sets: [...this.changeSets.values()], settings: [...this.settingChanges.values()] }, this.deps.now?.() ?? Date.now());
  }

  /** An exchange's cards as their held state says now (an Undo from a later message changes an earlier card). */
  private withHeldCards(exchange: InboxAssistantExchange): InboxAssistantExchange {
    const sets = exchange.changeSets?.some(set => this.changeSets.has(set.id));
    const settings = exchange.settingChanges?.some(change => this.settingChanges.has(change.id));
    if (!sets && !settings) return exchange;
    return {
      ...exchange,
      ...(sets ? { changeSets: exchange.changeSets!.map(set => { const held = this.changeSets.get(set.id)?.held; return held ? structuredClone(held.set) : set; }) } : {}),
      ...(settings ? { settingChanges: exchange.settingChanges!.map(change => { const held = this.settingChanges.get(change.id)?.held; return held ? structuredClone(held.change) : change; }) } : {}),
    };
  }

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
    // Earlier cards a run changed (the agent undid one) are saved as they are now.
    exchanges = exchanges.map(value => this.withHeldCards(value));
    if (run.record.kind === 'question' && run.record.exchangeId && !exchange) {
      const previous = exchanges.find(value => value.id === run.record.exchangeId);
      // Sets the run already changed mail with (keepRunSet): their cards are
      // saved with the unfinished exchange, so they survive a crash mid-run.
      const kept = [...this.changeSets.values()].filter(entry => entry.chatId === run.chatId && entry.exchangeId === run.record.exchangeId)
        .map(entry => structuredClone(entry.held.set));
      const question: InboxAssistantExchange = { ...(previous ?? { id: run.record.exchangeId, chatId: run.chatId, question: run.record.question,
        accountIds: run.record.accountIds, createdAt: run.record.startedAt, answer: { text: '', sources: [], coverage: [], warnings: [] } }),
        requestId: run.id, status: run.record.status, updatedAt: record.updatedAt, activities: record.activities, ...(record.usage ? { usage: record.usage } : {}),
        ...(record.diagnostics ? { diagnostics: record.diagnostics } : {}), ...(kept.length ? { changeSets: kept } : {}),
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
      activities: [...run.record.activities], ...(run.record.error ? { error: run.record.error } : {}), ...(run.record.usage ? { usage: run.record.usage } : {}),
      ...(run.record.diagnostics ? { diagnostics: run.record.diagnostics } : {}) } : { ...exchange, updatedAt: run.record.updatedAt } : undefined;
    this.persistRun(run, saved);
    return saved;
  }

  /**
   * Serialize mutations while allowing independent chats to research in
   * parallel. `delegated`: a change the run decided to make without a card
   * ("Approve for me"). The mode is checked again once the change's turn
   * comes: a chat switched to "Ask for approval" while it waited stops the
   * request, as a switch during an apply does.
   */
  private async withMailActions<T>(run: ActiveRun, action: () => Promise<T>, delegated = false): Promise<T> {
    const before = this.mailActionTail.catch(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.mailActionTail = before.then(() => gate);
    try {
      await waitForAbortableOperation(before, run.controller.signal);
      if (delegated && run.changes && run.changes.mode !== 'approve_for_me') { run.cancelled = true; run.controller.abort(new Error('Delegated approval stopped.')); }
      run.controller.signal.throwIfAborted();
      this.markRequestMutating(run.controller);
      return await action();
    } finally { release(); }
  }

  private callRunAI(run: ActiveRun, prompt: string, signal: AbortSignal, maxOutputTokens?: number, workload?: InboxAssistantAIWorkload, purpose?: InboxAssistantAIPurpose): Promise<string> {
    signal.throwIfAborted();
    const onUsage = this.usageRecorder(run, workload, purpose);
    return waitForAbortableOperation(maxOutputTokens === undefined ? this.deps.callAI(prompt, signal, onUsage)
      : this.deps.callAI(prompt, signal, onUsage, { maxOutputTokens }), signal);
  }

  /** Records one provider call's usage on its run, as the host describes it. */
  private usageRecorder(run: ActiveRun, workload?: InboxAssistantAIWorkload, purpose?: InboxAssistantAIPurpose): (usage: InboxAssistantAIUsage) => void {
    const trustedWorkload = readInboxAssistantAIWorkload(workload);
    return (usage: InboxAssistantAIUsage) => {
      // Only the host's actual prepared batch describes workload. Provider
      // accounting remains unchanged and cannot supply these diagnostic counts.
      // The step name is the host's too: which of a run's calls this was.
      const { workload: _providerWorkload, purpose: _providerPurpose, ...reported } = usage;
      run.record.usage = aggregateInboxAssistantUsage([...(run.record.usage?.calls ?? []), { ...reported, ...(trustedWorkload ? { workload: trustedWorkload } : {}), ...(purpose ? { purpose } : {}) }]);
      // Reported accounting can arrive during cancellation. Keep the saved
      // receipt on its originating run without waking or selecting that chat.
      if (run.generation === (this.generations.get(run.chatId) ?? 0)) this.persistRun(run);
      else this.persistStaleUsage(run);
    };
  }

  private callRunChat(run: ActiveRun, request: AIChatRequest, signal: AbortSignal, purpose: InboxAssistantAIPurpose = 'agent'): Promise<AIChatResult> {
    signal.throwIfAborted();
    if (!this.deps.callAIChat) throw new Error('The Inbox Agent is unavailable. Restart the app after updating.');
    return waitForAbortableOperation(this.deps.callAIChat(request, signal, this.usageRecorder(run, undefined, purpose)), signal);
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
    return exchanges.filter(exchange => exchange.accountIds.every(id => registered.has(id))).map(stored => {
      let exchange = this.withHeldCards(stored);
      // A card whose change set is no longer held (the app restarted) can no
      // longer be approved or undone: say so rather than offer the buttons.
      if (exchange.changeSets?.some(set => !this.changeSets.has(set.id))) {
        exchange = { ...exchange, changeSets: exchange.changeSets.map(set => this.changeSets.has(set.id) ? set
          : { ...set, approveBy: 0, undoBy: 0, ...(set.status === 'pending' ? { status: 'expired' as const } : {}) }) };
      }
      if (exchange.settingChanges?.some(change => !this.settingChanges.has(change.id))) {
        exchange = { ...exchange, settingChanges: exchange.settingChanges.map(change => this.settingChanges.has(change.id) ? change
          : { ...change, approveBy: 0, undoBy: 0, ...(change.status === 'pending' ? { status: 'expired' as const } : {}) }) };
      }
      // A review card from the retired unread review: its actions went with it.
      return exchange.review ? { ...exchange, review: { ...exchange.review, status: 'expired' } } : exchange;
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
      // An automatic review that was running when the app quit, saved by an earlier version.
      if (exchange.review?.automation?.status !== 'running') return exchange;
      changed = true;
      return { ...exchange, review: { ...exchange.review, automation: { ...exchange.review.automation, status: 'stopped' as const,
        reason: 'Interrupted when the app restarted. Saved receipts remain available.' } } };
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
    if (request.actionMode === 'review' && run) {
      if (run.changes) run.changes.mode = 'review';
      if (run.mutating) { run.cancelled = true; run.controller.abort(new Error('Delegated approval stopped.')); }
    }
    return result;
  }

  deleteChat(value: unknown): InboxAssistantChatList {
    if (typeof value === 'string' && this.running.get(value)?.mutating) throw new Error('Wait for the current mail action to finish before deleting this conversation.');
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Inbox Agent chat.');
    const result = this.deps.history.delete(value);
    this.generations.set(value, (this.generations.get(value) ?? 0) + 1);
    this.running.get(value)?.controller.abort(new Error('This conversation was deleted.'));
    this.forgetChangeSets(value);
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
    this.invalidateCards(request.chatId);
    return { ...result, chat: { ...result.chat, exchanges: this.visibleExchanges(result.chat.exchanges) } };
  }

  async restoreRewindChat(value: unknown): Promise<InboxAssistantChat> {
    const request = value as { chatId?: unknown } | null;
    if (!request || Array.isArray(request) || !Object.keys(request).every(key => key === 'chatId')
      || typeof request.chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.chatId)) throw new Error('Choose a conversation to restore.');
    await this.stopForHistoryChange(request.chatId);
    if (this.running.has(request.chatId)) throw new Error('A new request started in this conversation. Stop it before restoring.');
    const chat = this.deps.history.restoreRewind(request.chatId);
    this.invalidateCards(request.chatId);
    return { ...chat, exchanges: this.visibleExchanges(chat.exchanges) };
  }

  private async stopForHistoryChange(chatId: string): Promise<void> {
    const run = this.running.get(chatId);
    if (!run) return;
    if (run.mutating) throw new Error('Stop the current mail action and wait for its receipt before rewinding this conversation.');
    await this.cancel(run.id);
  }

  private invalidateCards(chatId: string): void {
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    this.forgetChangeSets(chatId);
  }

  private forgetChangeSets(chatId: string): void {
    for (const [id, entry] of this.changeSets) if (entry.chatId === chatId) this.changeSets.delete(id);
    for (const [id, entry] of this.settingChanges) if (entry.chatId === chatId) this.settingChanges.delete(id);
    this.saveJournal();
  }

  /**
   * Hand a run's cards over: called when its answer (or its failure) is
   * delivered, before the exchange that shows them is built. Their approval
   * windows start here, when the user can first see them, not when the run
   * staged them.
   */
  private rememberChangeSets(chatId: string, exchangeId: string, accounts: InboxAssistantAccount[], sets: HeldChangeSet[], settings: HeldSettingChange[] = []): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const held of sets) openApprovalWindow(held, now);
    for (const held of settings) openSettingApprovalWindow(held, now);
    for (const [id, entry] of this.changeSets) if (Math.max(entry.held.set.approveBy, entry.held.set.undoBy) < now) this.changeSets.delete(id);
    for (const [id, entry] of this.settingChanges) if (Math.max(entry.held.change.approveBy, entry.held.change.undoBy) < now) this.settingChanges.delete(id);
    for (const held of sets) this.changeSets.set(held.set.id, { chatId, exchangeId, accounts, held });
    for (const held of settings) this.settingChanges.set(held.change.id, { chatId, exchangeId, accounts, held });
    while (this.changeSets.size > 200) this.changeSets.delete(this.changeSets.keys().next().value!);
    while (this.settingChanges.size > 100) this.settingChanges.delete(this.settingChanges.keys().next().value!);
    this.saveJournal();
  }

  /**
   * The run's undo requests with the exchange each card belongs to. `known` is
   * the chat's cards as the run started: a request whose card stopped being
   * held during the run (its window ended) keeps its exchange, so an undo the
   * agent did still refreshes the mail list and its earlier card still shows.
   */
  private undoRequests(requests: InboxAgentChangeContext['undoRequests'], known: Map<string, string>): InboxAgentUndoRequest[] {
    return requests.flatMap(request => {
      const exchangeId = (request.kind === 'setting' ? this.settingChanges.get(request.id) : this.changeSets.get(request.id))?.exchangeId ?? known.get(request.id);
      return exchangeId ? [{ ...request, exchangeId }] : [];
    });
  }

  /** Which exchange each of a chat's held cards belongs to, now. */
  private cardExchanges(chatId: string): Map<string, string> {
    return new Map([...this.changeSets, ...this.settingChanges].filter(([, entry]) => entry.chatId === chatId).map(([id, entry]) => [id, entry.exchangeId]));
  }

  /**
   * Keep a set the run changed mail with (applied without a card, or undone)
   * at once, not when the run ends: if the app quits or crashes mid-run, its
   * card and its Undo must survive. A set of this run is held under the run's
   * exchange, and the unfinished exchange is saved with its card (persistRun).
   * Its approval window is not opened here; that waits for the answer
   * (rememberChangeSets). An earlier set (`own` false) keeps its own card and
   * exchange; only the journal is saved. Nothing is kept for a chat deleted or
   * rewound since.
   */
  private keepRunSet(run: ActiveRun, accounts: InboxAssistantAccount[], held: HeldChangeSet, own: boolean): void {
    if (run.generation !== (this.generations.get(run.chatId) ?? 0)) return;
    if (own && !this.changeSets.has(held.set.id) && held.set.items.some(item => item.status !== 'pending')) {
      this.changeSets.set(held.set.id, { chatId: run.chatId, exchangeId: run.record.exchangeId!, accounts, held });
    }
    this.saveJournal();
    this.persistRun(run);
  }

  /** A chat's earlier changes the agent can still undo, and how many cards it had, so new labels stay unique. */
  private earlierChanges(chatId: string): Pick<InboxAgentChangeContext, 'earlier' | 'labelOffset'> {
    const exchanges = this.deps.history.load(chatId, { select: false }).exchanges;
    return {
      earlier: {
        sets: [...this.changeSets.values()].filter(entry => entry.chatId === chatId).map(entry => entry.held),
        settings: [...this.settingChanges.values()].filter(entry => entry.chatId === chatId).map(entry => entry.held),
      },
      labelOffset: {
        sets: exchanges.reduce((sum, exchange) => sum + (exchange.changeSets?.length ?? 0), 0),
        settings: exchanges.reduce((sum, exchange) => sum + (exchange.settingChanges?.length ?? 0), 0),
      },
    };
  }

  /** The host's settings, refused once an account is no longer the one the change was prepared for. */
  private agentSettings(signal: AbortSignal, expected: InboxAssistantAccount[]): InboxAgentSettingActions {
    const settings = this.deps.settingActions;
    if (!settings) throw new Error('Settings are unavailable. Restart the app after updating.');
    const checked = <A extends unknown[], R>(call: (accountId: string, ...args: A) => Promise<R>) => (accountId: string, ...args: A): Promise<R> => {
      signal.throwIfAborted();
      const account = this.accounts().find(item => item.id === accountId);
      if (!account || !expected.some(item => item.id === account.id && item.email === account.email)) return Promise.reject(new Error('The account changed or is no longer connected.'));
      return call(accountId, ...args);
    };
    return {
      listFilters: checked(settings.listFilters.bind(settings)), createFilter: checked(settings.createFilter.bind(settings)), updateFilter: checked(settings.updateFilter.bind(settings)),
      deleteFilter: checked(settings.deleteFilter.bind(settings)), matchFilter: checked(settings.matchFilter.bind(settings)), senderEmails: checked(settings.senderEmails.bind(settings)),
      sender: checked(settings.sender.bind(settings)), setSender: checked(settings.setSender.bind(settings)),
    };
  }

  /** The agent's mail actions, refused once an account is no longer the one the change was prepared for. */
  private agentMail(signal: AbortSignal, expected: InboxAssistantAccount[]): { actions: InboxAgentMailActions; readEmail: InboxAgentEmailReader } {
    const mail = this.deps.mailActions;
    if (!mail) throw new Error('Mail actions are unavailable. Restart the app after updating.');
    const assertAccount = (accountId: string) => {
      signal.throwIfAborted();
      const account = this.accounts().find(item => item.id === accountId);
      if (!account || !expected.some(item => item.id === account.id && item.email === account.email)) throw new Error('The account changed or is no longer connected.');
    };
    return {
      actions: {
        setRead: (accountId, ids, read) => { assertAccount(accountId); return mail.setRead(accountId, ids, read); },
        setStarred: (accountId, ids, starred) => { assertAccount(accountId); return mail.setStarred(accountId, ids, starred); },
        move: (accountId, ids, to) => { assertAccount(accountId); return mail.move(accountId, ids, to); },
        restore: (accountId, ids) => { assertAccount(accountId); return mail.restore(accountId, ids); },
        setCategory: (accountId, ids, slug, on) => { assertAccount(accountId); return mail.setCategory(accountId, ids, slug, on); },
        setLabel: (accountId, ids, name, on) => { assertAccount(accountId); return mail.setLabel(accountId, ids, name, on); },
        createLabel: (accountId, name) => { assertAccount(accountId); return mail.createLabel(accountId, name); },
        dropLabel: (accountId, name) => { assertAccount(accountId); return mail.dropLabel(accountId, name); },
        setSnooze: (accountId, ids, until) => { assertAccount(accountId); return mail.setSnooze(accountId, ids, until); },
        spamVerdict: (accountId, ids, verdict) => { assertAccount(accountId); return mail.spamVerdict(accountId, ids, verdict); },
        revertSpamVerdict: (accountId, rows) => { assertAccount(accountId); return mail.revertSpamVerdict(accountId, rows); },
      },
      readEmail: async (accountId, emailId) => {
        assertAccount(accountId);
        return (await this.deps.openMailbox(accountId)).storage.getEmail(emailId);
      },
    };
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
    this.forgetChangeSets(active);
  }

  /** The user's decision on one of the agent's change-set cards: approve (all or some rows), cancel, or undo. */
  async decideChangeSet(value: unknown, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantExchange> {
    const request = value as InboxAgentChangeSetRequest;
    const id = /^[a-zA-Z0-9_-]{1,100}$/;
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || !Object.keys(request).every(key => ['requestId', 'chatId', 'exchangeId', 'changeSetId', 'decision', 'itemIds', 'includeExisting'].includes(key))
      || (request.includeExisting !== undefined && (request.decision !== 'approve' || typeof request.includeExisting !== 'boolean'))
      || ![request.requestId, request.chatId, request.exchangeId, request.changeSetId].every(value => typeof value === 'string' && id.test(value))
      || !['approve', 'cancel', 'undo'].includes(request.decision)
      || (request.itemIds !== undefined && (request.decision === 'cancel' || !Array.isArray(request.itemIds) || request.itemIds.length > INBOX_AGENT_CHANGE_LIMITS.perSet
        || request.itemIds.some(item => typeof item !== 'string' || !/^c\d{1,2}-\d{1,5}$/.test(item))))) throw new Error('Choose valid changes.');
    this.assertIdle(request.chatId, request.requestId);
    if (this.settingChanges.has(request.changeSetId)) {
      if (request.itemIds) throw new Error('Choose valid changes.');
      return this.decideSettingChange(request, onActivity);
    }
    if (request.includeExisting !== undefined) throw new Error('Choose valid changes.');
    const entry = this.changeSets.get(request.changeSetId);
    const chat = this.deps.history.load(request.chatId, { select: false });
    const exchange = chat.exchanges.find(item => item.id === request.exchangeId && item.changeSets?.some(set => set.id === request.changeSetId));
    if (!entry || entry.chatId !== request.chatId || entry.exchangeId !== request.exchangeId || !exchange) {
      throw new Error('These changes are no longer available. Ask again to prepare them fresh.');
    }
    if (exchange.accountIds.some(accountId => !this.accounts().some(account => account.id === accountId))) throw new Error('An account in this change is no longer connected.');
    const { held } = entry;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Mail action took too long.')), 300_000);
    timeout.unref?.();
    const label = request.decision === 'approve' ? held.set.summary : request.decision === 'undo' ? `Undo: ${held.set.summary}` : `Cancel: ${held.set.summary}`;
    const run = this.beginRequest(request.requestId, request.chatId, controller, 'action', label, [...exchange.accountIds], exchange.id);
    const saved = (): InboxAssistantExchange => ({ ...exchange, changeSets: exchange.changeSets!.map(set => set.id === held.set.id ? structuredClone(held.set) : set) });
    try {
      this.reportRun(run, { stage: 'action', status: 'running', message: label }, onActivity);
      const now = this.deps.now?.() ?? Date.now();
      if (request.decision === 'cancel') cancelChangeSet(held);
      else {
        const options = { ...this.agentMail(controller.signal, entry.accounts), nowMs: now, signal: controller.signal, ...(request.itemIds ? { itemIds: request.itemIds } : {}) };
        await this.withMailActions(run, () => request.decision === 'approve' ? applyChangeSet(held, options) : undoChangeSet(held, options));
      }
      const counts = changeCounts(held.set);
      const changed = counts.applied + counts.queued;
      this.reportRun(run, { stage: 'action', status: counts.failed ? 'warning' : 'done',
        message: request.decision === 'cancel' ? 'Changes cancelled' : request.decision === 'undo' ? `${counts.undone} put back` : `${changed} changed`,
        ...(request.decision === 'approve' ? { detail: [counts.queued ? `${counts.queued} will sync when the account is online` : '', counts.unchanged ? `${counts.unchanged} were already as asked` : '',
          counts.skipped ? `${counts.skipped} left out` : '', counts.failed ? `${counts.failed} failed` : ''].filter(Boolean).join('; ') || undefined } : {}) }, onActivity);
      return this.settleRun(run, undefined, saved())!;
    } catch (error) {
      // The set may have changed before the failure (rows applied, or expired).
      this.settleRun(run, error, saved());
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
      this.saveJournal();
    }
  }

  /** The user's decision on a setting-change card: approve (optionally with its existing mail), cancel, or undo. */
  private async decideSettingChange(request: InboxAgentChangeSetRequest, onActivity?: (activity: InboxAssistantActivity) => void): Promise<InboxAssistantExchange> {
    const entry = this.settingChanges.get(request.changeSetId)!;
    const chat = this.deps.history.load(request.chatId, { select: false });
    const exchange = chat.exchanges.find(item => item.id === request.exchangeId && item.settingChanges?.some(change => change.id === request.changeSetId));
    if (entry.chatId !== request.chatId || entry.exchangeId !== request.exchangeId || !exchange) {
      throw new Error('These changes are no longer available. Ask again to prepare them fresh.');
    }
    if (exchange.accountIds.some(accountId => !this.accounts().some(account => account.id === accountId))) throw new Error('An account in this change is no longer connected.');
    const { held } = entry;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Mail action took too long.')), 300_000);
    timeout.unref?.();
    const label = request.decision === 'approve' ? held.change.summary : request.decision === 'undo' ? `Undo: ${held.change.summary}` : `Cancel: ${held.change.summary}`;
    const run = this.beginRequest(request.requestId, request.chatId, controller, 'action', label, [...exchange.accountIds], exchange.id);
    const saved = (): InboxAssistantExchange => ({ ...exchange, settingChanges: exchange.settingChanges!.map(change => change.id === held.change.id ? structuredClone(held.change) : change) });
    try {
      this.reportRun(run, { stage: 'action', status: 'running', message: label }, onActivity);
      const nowMs = this.deps.now?.() ?? Date.now();
      if (request.decision === 'cancel') cancelSettingChange(held);
      else {
        const { actions: mail, readEmail } = this.agentMail(controller.signal, entry.accounts);
        const options = { settings: this.agentSettings(controller.signal, entry.accounts), mail, readEmail, nowMs, signal: controller.signal };
        await this.withMailActions(run, () => request.decision === 'approve'
          ? applySettingChange(held, { ...options, ...(request.includeExisting ? { includeExisting: true } : {}) })
          : undoSettingChange(held, options));
      }
      const { change } = held;
      const failed = !!change.detail && change.status === 'pending';
      this.reportRun(run, { stage: 'action', status: failed || /failed/.test(change.existing?.result ?? '') ? 'warning' : 'done',
        message: request.decision === 'cancel' ? 'Change cancelled' : failed ? 'Not saved' : request.decision === 'undo' ? 'Change undone' : 'Change saved',
        ...(change.existing?.result && change.existingApplied ? { detail: change.existing.result } : change.detail ? { detail: change.detail } : {}) }, onActivity);
      return this.settleRun(run, undefined, saved())!;
    } catch (error) {
      this.settleRun(run, error, saved());
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
      this.saveJournal();
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
        return this.callRunAI(run, prompt, controller.signal, undefined, undefined, 'draft');
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
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Search took too long. Narrow the question or date range and try again.'), { code: 'ASSISTANT_TIMEOUT' })), 300_000);
    timeout.unref?.();
    const generation = this.generations.get(request.chatId) ?? 0;
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== (this.generations.get(request.chatId) ?? 0)) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Search cancelled.');
      const current = new Set(this.accounts().map(account => account.id));
      if (request.accountIds.some(id => !current.has(id))) throw new Error('A selected account was disconnected during the search.');
    };
    const run = this.beginRequest(request.requestId, request.chatId, controller, 'question', request.question, request.accountIds, randomUUID());
    const report = (progress: InboxAssistantProgress) => this.reportRun(run, progress, onActivity);
    // Why this run ends the way it does. Saved with the run, so every progress
    // write also saves how far it got; see InboxAssistantRunDiagnostics.
    const diagnostics: InboxAssistantRunDiagnostics = { version: 1 };
    run.record.diagnostics = diagnostics;
    let stage: NonNullable<InboxAssistantRunDiagnostics['failure']>['stage'] = 'route';
    // The agent's change sets, kept even if the run fails afterwards: one it
    // already applied must keep its Undo.
    const agentChangeSets: HeldChangeSet[] = [];
    const agentSettingChanges: HeldSettingChange[] = [];
    const agentUndoRequests: InboxAgentChangeContext['undoRequests'] = [];
    let knownCards = new Map<string, string>();
    const conclude = (outcome: NonNullable<InboxAssistantRunDiagnostics['outcome']>) => {
      diagnostics.outcome = outcome;
      diagnostics.durationMs = Math.max(0, Date.now() - run.record.startedAt);
    };
    try {
      diagnostics.route = 'agent';
      stage = 'agent';
      const timeZone = researchTimeZone(this.deps);
      const nowMs = this.deps.now?.() ?? Date.now();
      const identity = this.deps.providerIdentity?.() ?? 'default';
      if (historyContext) report({ stage: 'context', status: 'done', message: 'Loaded conversation context', detail: 'Earlier questions supply context; original emails and attachments are checked again for facts.' });
      report({ stage: 'search', status: 'running', message: 'Working on your request', detail: `Using ${selected.length} selected ${selected.length === 1 ? 'account' : 'accounts'}.` });
      const now = () => this.deps.now?.() ?? Date.now();
      knownCards = this.cardExchanges(request.chatId);
      const changes: InboxAgentChangeContext | undefined = this.deps.mailActions ? {
        mode: this.deps.history.load(request.chatId, { select: false }).actionMode ?? 'review',
        sets: agentChangeSets, autoApplied: 0, autoUndone: 0, atStart: new Map(), nowMs: now, settingChanges: agentSettingChanges, undoRequests: agentUndoRequests,
        ...this.earlierChanges(request.chatId),
        ...(this.deps.settingActions ? { settings: this.agentSettings(controller.signal, selected) } : {}),
        apply: held => this.withMailActions(run, async () => {
          try { await applyChangeSet(held, { ...this.agentMail(controller.signal, selected), nowMs: now(), auto: true, signal: controller.signal }); }
          finally { this.keepRunSet(run, selected, held, true); }
        }, true),
        // An earlier set is checked against the accounts it was prepared for, not this request's.
        undo: held => this.withMailActions(run, async () => {
          try { await undoChangeSet(held, { ...this.agentMail(controller.signal, this.changeSets.get(held.set.id)?.accounts ?? selected), nowMs: now(), signal: controller.signal }); }
          finally { this.keepRunSet(run, selected, held, agentChangeSets.includes(held)); }
        }, true),
      } : undefined;
      if (changes) run.changes = changes;
      const result = await runInboxAgent({
        question: request.question, ...(historyContext ? { historyContext } : {}), accounts: selected, timeZone, nowMs,
        signal: controller.signal, protocol: this.agentProtocols.get(identity), diagnostics, ...(changes ? { changes } : {}),
        deps: {
          research: this.deps,
          progress: report,
          chat: chatRequest => { assertCurrent(); return this.callRunChat(run, chatRequest, controller.signal); },
          // Through the chat call, whose retry gives a reasoning model that
          // spent its whole budget thinking a second, larger budget.
          classify: async prompt => {
            assertCurrent();
            const reply = await this.callRunChat(run, { messages: [{ role: 'system', content: INBOX_ASSISTANT_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
              maxOutputTokens: 4_000 }, controller.signal, 'classify');
            return reply.text;
          },
          // The run keeps its latest deep search's plan and per-account
          // coverage (content-free), as the one-shot search did.
          deepSearch: async question => {
            assertCurrent();
            const plan = await planInboxAssistantSearch(question, prompt => {
              assertCurrent();
              return this.callRunAI(run, prompt, controller.signal, INBOX_ASSISTANT_OUTPUT_TOKENS.plan, undefined, 'plan');
            }, { nowMs, timeZone, diagnostics,
              // A follow-up (by the user's own words) keeps the earlier topic, people and
              // direction, however the model phrased its search.
              ...(context.isFollowUp ? { historyContext, topicTerms: context.topicTerms, participantTerms: context.participantTerms, intent: context.intent } : {}) });
            // A plan call interrupted by Stop or the time limit is not a planner failure.
            if (controller.signal.aborted) delete diagnostics.plan;
            assertCurrent();
            // The latest search's coverage replaces an earlier one's, never adds to it.
            delete diagnostics.accounts;
            delete diagnostics.searchBroadened;
            const research = await waitForAbortableOperation(researchInboxAssistant(selected, plan, this.deps, controller.signal, {
              // A follow-up reopens the emails the earlier answers rested on.
              onProgress: report, diagnostics, ...(context.isFollowUp ? { sourceRefs: context.sourceRefs } : {}),
            }), controller.signal);
            // Excerpts carry their local date and time, as the prompt promises.
            return { ...research, evidence: research.evidence.map(source => ({ ...source, dateTimeZone: timeZone })) };
          },
        },
      });
      this.agentProtocols.set(identity, result.protocol);
      assertCurrent();
      // Before rememberChangeSets drops cards whose windows ended during the run.
      const undoRequests = this.undoRequests(agentUndoRequests, knownCards);
      // Before the cards are copied into the exchange: their windows open here.
      this.rememberChangeSets(request.chatId, run.record.exchangeId!, selected, agentChangeSets, agentSettingChanges);
      const exchange: InboxAssistantExchange = {
        id: run.record.exchangeId!, chatId: request.chatId, question: request.question, accountIds: request.accountIds, createdAt: run.record.startedAt,
        answer: result.answer, ...(agentChangeSets.length ? { changeSets: agentChangeSets.map(held => structuredClone(held.set)) } : {}),
        ...(agentSettingChanges.length ? { settingChanges: agentSettingChanges.map(held => structuredClone(held.change)) } : {}),
        ...(undoRequests.length ? { undoRequests } : {}),
      };
      const verified = result.outcome === 'verified' || result.outcome === 'answered';
      report({ stage: 'complete', status: verified ? 'done' : 'warning',
        message: result.outcome === 'verified' ? 'Answer verified against sources' : result.outcome === 'answered' ? 'Answer ready'
          : result.outcome === 'related' ? 'Related emails found; answer not verified' : 'No supporting email found',
        detail: result.outcome === 'verified' ? `${result.answer.sources.length} cited ${result.answer.sources.length === 1 ? 'source' : 'sources'}.`
          : result.answer.sources.length ? 'Related originals are available to inspect. They do not support a verified answer.' : 'No email was cited.' });
      conclude(result.outcome);
      return this.settleRun(run, undefined, exchange)!;
    } catch (error) {
      if (!controller.signal.aborted && generation === (this.generations.get(request.chatId) ?? 0)) {
        report({ stage: 'complete', status: 'warning', message: 'Could not finish this question', detail: error instanceof Error ? error.message : 'Please try again.' });
      }
      // Stopping is the user's choice. A run that broke records a failure, and
      // only its class.
      if (run.cancelled) conclude('stopped');
      else { diagnostics.failure = { stage, error: errorDiagnostic(error) }; conclude('failed'); }
      if (agentChangeSets.length || agentSettingChanges.length || agentUndoRequests.length) {
        // Cards for what was staged, applied or undone before the run stopped.
        const exchangeId = run.record.exchangeId!;
        const undoRequests = this.undoRequests(agentUndoRequests, knownCards);
        this.rememberChangeSets(request.chatId, exchangeId, selected, agentChangeSets, agentSettingChanges);
        this.settleRun(run, error, { id: exchangeId, chatId: request.chatId, question: request.question, accountIds: request.accountIds,
          createdAt: run.record.startedAt, answer: { text: '', sources: [], coverage: [], warnings: [] },
          ...(agentChangeSets.length ? { changeSets: agentChangeSets.map(held => structuredClone(held.set)) } : {}),
          ...(agentSettingChanges.length ? { settingChanges: agentSettingChanges.map(held => structuredClone(held.change)) } : {}),
          ...(undoRequests.length ? { undoRequests } : {}) });
      } else this.settleRun(run, error);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.finishRequest(controller);
      this.logRun(run, diagnostics);
    }
  }

  /** One content-free line per question, and one more when a step was degraded. */
  private logRun(run: ActiveRun, diagnostics: InboxAssistantRunDiagnostics): void {
    logger.info(inboxAssistantRunSummary(run.id, run.record.status, diagnostics, run.record.usage));
    const degraded = inboxAssistantDegradedStages(diagnostics, run.record.usage);
    if (degraded.length) logger.warn(`run=${run.id} degraded: ${degraded.join(' ')}`);
  }
}
