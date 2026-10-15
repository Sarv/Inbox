import { describe, expect, it, vi } from 'vitest';

import { fallbackInboxAssistantSearchPlan, planInboxAssistantSearch } from '../../../../electron/services/inbox-assistant-answer';
import { buildInboxAssistantContext } from '../../../../electron/services/inbox-assistant-context';
import type { InboxAssistantExchange, InboxAssistantRequest, InboxAssistantSource } from '../../../../src/types/inbox-assistant';

const request = (overrides: Partial<InboxAssistantRequest> = {}): InboxAssistantRequest => ({
  requestId: 'next', chatId: 'chat-main', question: 'How long was it valid?', accountIds: ['primary', 'secondary'], previousExchangeId: 'second', ...overrides,
});
const source = (overrides: Partial<InboxAssistantSource> = {}): InboxAssistantSource => ({
  id: 'S1', kind: 'message', accountId: 'primary', accountEmail: 'sales@sarv.example', emailId: 'tcs-quote',
  subject: 'TCS quotation Q-104 revision 2', from: 'sales@sarv.example', to: ['buyer@tcs.example'],
  date: 1_791_600_000, folder: 'Sent', sent: true, excerpt: 'PRIVATE FULL SOURCE EXCERPT MUST BE RE-READ', ...overrides,
});
const exchange = (overrides: Partial<InboxAssistantExchange> = {}): InboxAssistantExchange => ({
  id: 'first', question: 'What quote did I send to TCS?', accountIds: ['primary', 'secondary'], createdAt: 1_000,
  answer: { text: 'The TCS quote had two revisions.', sources: [source()], coverage: [], warnings: [] }, ...overrides,
});
const history = () => [exchange(), exchange({ id: 'second', question: 'Which was the latest revision?', createdAt: 2_000,
  answer: { text: 'Revision 2 was the latest observed sent revision.', sources: [source({ accountId: 'secondary', accountEmail: 'rc@sarv.example', emailId: 'revision-2' })], coverage: [], warnings: [] } })];

describe('Inbox Agent persisted conversation context', () => {
  it('keeps the customer context when a follow-up switches from my sent quote to a team member submission', () => {
    const context = buildInboxAssistantContext(history(), request({ question: 'This was sent by my team members, what did Prakash submit last?' }));
    expect(context.historyContext).toContain('TCS');
    expect(fallbackInboxAssistantSearchPlan(context.contextualizedQuestion).intent).toBe('all');
    expect(fallbackInboxAssistantSearchPlan('What quote did I send to my team?').intent).toBe('sent');
  });
  it('reconstructs all relevant earlier turns for a third question after restoring persisted history', () => {
    const restored = JSON.parse(JSON.stringify(history())) as InboxAssistantExchange[];
    const context = buildInboxAssistantContext(restored, request());
    expect(context.isFollowUp).toBe(true);
    expect(context.historyContext).toContain('What quote did I send to TCS?');
    expect(context.historyContext).toContain('Which was the latest revision?');
    expect(context.contextualizedQuestion).toContain('How long was it valid?');
    expect(context.contextualizedQuestion).toContain('What quote did I send to TCS?');
    expect(context.sourceRefs).toEqual([
      { accountId: 'secondary', emailId: 'revision-2' }, { accountId: 'primary', emailId: 'tcs-quote' },
    ]);
    expect(context.historyContext).toContain('answerContextOnly');
    expect(context.historyContext).toContain('Re-read the scoped sources');
    expect(context.historyContext).not.toContain('PRIVATE FULL SOURCE EXCERPT');
  });

  it('retains sent quotation intent in deterministic planning when the AI provider is unavailable', async () => {
    const context = buildInboxAssistantContext(history(), request());
    const fallback = await planInboxAssistantSearch(context.contextualizedQuestion, vi.fn().mockRejectedValue(new Error('offline')), { historyContext: context.historyContext });
    expect(fallback.intent).toBe('sent');
    expect(fallback.quoteIntent).toBe(true);
    expect(fallback.entityTerms).toContain('TCS');
  });

  it('allows the latest question to explicitly include received mail instead of inheriting Sent only', () => {
    const context = buildInboxAssistantContext(history(), request({ question: 'What changed in the received revision?' }));
    expect(context.isFollowUp).toBe(true);
    expect(fallbackInboxAssistantSearchPlan(context.contextualizedQuestion).intent).toBe('all');
  });

  it('never includes later turns after the referenced previous exchange', () => {
    const context = buildInboxAssistantContext([...history(), exchange({ id: 'future', question: 'What quote did I send to SECRET-FUTURE?' })], request());
    expect(context.historyContext).not.toContain('SECRET-FUTURE');
  });

  it('retains user questions across scope changes without leaking excluded account answers or sources', () => {
    for (const accountIds of [['primary'], ['secondary'], ['primary', 'secondary', 'third']]) {
      const context = buildInboxAssistantContext(history(), request({ accountIds }));
      expect(context.isFollowUp).toBe(true);
      expect(context.historyContext).toContain('What quote did I send to TCS?');
      expect(context.historyContext).not.toContain('answerContextOnly');
      expect(context.historyContext).not.toContain('The TCS quote had two revisions.');
      expect(context.historyContext).not.toContain('Revision 2 was the latest observed sent revision.');
      expect(context.sourceRefs.every(ref => accountIds.includes(ref.accountId))).toBe(true);
      const excluded = ['primary', 'secondary'].filter(id => !accountIds.includes(id));
      const parsed = JSON.parse(context.historyContext!);
      expect(parsed.sourceMetadata.every((item: { account: string }) => !excluded.some(id => item.account === (id === 'primary' ? 'sales@sarv.example' : 'rc@sarv.example')))).toBe(true);
    }
  });

  it('matches account scope without depending on selection order', () => {
    expect(buildInboxAssistantContext(history(), request({ accountIds: ['secondary', 'primary'] })).sourceRefs).toHaveLength(2);
  });

  it('keeps older exact-scope topic turns across unrelated account-scope turns without their private context', () => {
    const scoped = [history()[0]!, exchange({ id: 'private', question: 'PRIVATE OTHER ACCOUNT QUESTION', accountIds: ['third'],
      answer: { text: 'PRIVATE OTHER ACCOUNT ANSWER', sources: [source({ accountId: 'third', emailId: 'private' })], coverage: [], warnings: [] } }), history()[1]!];
    const context = buildInboxAssistantContext(scoped, request());
    expect(context.historyContext).toContain('TCS');
    expect(context.historyContext).not.toContain('PRIVATE OTHER ACCOUNT');
    expect(context.sourceRefs.every(ref => ref.accountId !== 'third')).toBe(true);
  });

  it('also rejects an excluded-account source attached to an otherwise same-scope historical turn', () => {
    const saved = history();
    saved[1]!.answer.sources.push(source({ accountId: 'third', emailId: 'do-not-read', subject: 'SECRET THIRD ACCOUNT SUBJECT' }));
    const context = buildInboxAssistantContext(saved, request());
    expect(context.historyContext).not.toContain('SECRET THIRD');
    expect(context.sourceRefs).not.toContainEqual({ accountId: 'third', emailId: 'do-not-read' });
  });

  it('does not pin old quotes or add prior context to an unrelated new customer question', () => {
    for (const question of ['What quote did I send to Acme?', 'And what about the latest quote I sent to Acme?', 'What about the quote to IBM?', 'How much was the IBM quotation?', 'How much was the Acme quotation?', 'Show all unread mail']) {
      expect(buildInboxAssistantContext(history(), request({ question }))).toEqual({ sourceRefs: [], contextualizedQuestion: question, isFollowUp: false });
    }
  });

  it.each(['How much?', 'Amount?', 'Tell me more', 'Who received it?'])('retains genuine short follow-up context for %s', question => {
    expect(buildInboxAssistantContext(history(), request({ question })).isFollowUp).toBe(true);
  });

  it('can return to an earlier named quotation after an unrelated customer turn', () => {
    const saved = [...history(), exchange({ id: 'acme', question: 'What quote did I send to Acme?',
      answer: { text: 'Acme quotation.', sources: [source({ subject: 'Acme quotation', emailId: 'acme-quote', to: ['buyer@acme.example'] })], coverage: [], warnings: [] } })];
    const context = buildInboxAssistantContext(saved, request({ previousExchangeId: 'acme', question: 'Back to the TCS quote, how long was it valid?' }));
    expect(context.sourceRefs).toContainEqual({ accountId: 'primary', emailId: 'tcs-quote' });
    expect(context.sourceRefs).not.toContainEqual({ accountId: 'primary', emailId: 'acme-quote' });
    expect(context.historyContext).not.toContain('Acme');
  });

  it('bounds JSON context and source references while retaining every relevant prior question', () => {
    const saved = Array.from({ length: 20 }, (_, index) => exchange({
      id: `turn-${index}`, question: index === 0 ? 'What quote did I send to TCS?' : `What changed in revision stage-${index}? ${'Extra question detail '.repeat(300)}`,
      answer: { text: 'Long prior answer '.repeat(500), sources: Array.from({ length: 8 }, (_, number) => source({
        emailId: `message-${index}-${number}`, subject: 'TCS subject '.repeat(100), filename: 'quotation.pdf',
      })), coverage: [], warnings: [] },
    }));
    const context = buildInboxAssistantContext(saved, request({ previousExchangeId: 'turn-19' }));
    expect(context.historyContext!.length).toBeLessThanOrEqual(6_000);
    const parsed = JSON.parse(context.historyContext!);
    expect(parsed.turns).toHaveLength(20);
    expect(parsed.turns[0].question).toContain('TCS');
    expect(parsed.turns.at(-1).question).toContain('stage-19');
    expect(context.sourceRefs).toHaveLength(12);
  });

  it('returns clean no-context results for a new conversation or unknown prior exchange', () => {
    expect(buildInboxAssistantContext(history(), request({ previousExchangeId: undefined })).isFollowUp).toBe(false);
    expect(buildInboxAssistantContext(history(), request({ previousExchangeId: 'missing' })).historyContext).toBeUndefined();
  });

  it('never treats a different named chat as conversation context', () => {
    const other = history().map(item => ({ ...item, chatId: 'other-chat' }));
    expect(buildInboxAssistantContext(other, request()).historyContext).toBeUndefined();
    expect(buildInboxAssistantContext(other, request()).sourceRefs).toEqual([]);
  });

  it('windows long persisted conversations around the original topic and newest follow-ups without changing history', () => {
    const saved = Array.from({ length: 60 }, (_, index) => exchange({ id: `long-${index}`,
      question: index === 0 ? 'What quote did I send to TCS?' : `What changed in revision ${index}?` }));
    const context = buildInboxAssistantContext(saved, request({ previousExchangeId: 'long-59' }));
    const parsed = JSON.parse(context.historyContext!);
    expect(parsed.turns).toHaveLength(20);
    expect(parsed.turns[0].question).toContain('TCS');
    expect(parsed.turns.at(-1).question).toContain('revision 59');
    expect(parsed.omittedMiddleTurns).toBe(40);
    expect(context.historyContext!.length).toBeLessThanOrEqual(6_000);
    expect(saved).toHaveLength(60);
  });
});
