import { describe, expect, it, vi } from 'vitest';

import {
  buildInboxAssistantSearchPlanPrompt,
  fallbackInboxAssistantSearchPlan,
  INBOX_ASSISTANT_OUTPUT_TOKENS,
  inboxAssistantAIFailure,
  inboxAssistantCoverageWarnings,
  inboxAssistantEvidenceText,
  InboxAssistantResponseError,
  jsonObject,
  normalizeExcerpt,
  parseInboxAssistantSearchPlan,
  planInboxAssistantSearch,
  verifyInboxAssistantFacts,
} from '../../../../electron/services/inbox-assistant-answer';
import type { InboxAssistantAccountCoverage, InboxAssistantEvidence, InboxAssistantRunDiagnostics } from '../../../../src/types/inbox-assistant';

const question = 'What quote did I sent to TCS?';
const makeCoverage = (overrides: Partial<InboxAssistantAccountCoverage> = {}): InboxAssistantAccountCoverage => ({
  accountId: 'primary', email: 'rc@sarv.example', status: 'searched', matchedMessages: 2, reviewedMessages: 2,
  missingBodies: 0, attachmentsRead: 1, attachmentsSkipped: 0, truncated: false, warnings: [], ...overrides,
});
const makeSource = (overrides: Partial<InboxAssistantEvidence> = {}): InboxAssistantEvidence => ({
  id: 'S1', kind: 'message', accountId: 'primary', accountEmail: 'rc@sarv.example', emailId: 'same-email-id',
  subject: 'TCS quotation Q-104 revision 1', from: 'rc@sarv.example', to: ['procurement@tcs.example'],
  date: Date.UTC(2026, 9, 1) / 1_000, folder: 'Sent', sent: true, excerpt: 'Please find attached our quotation.',
  text: 'Please find attached our quotation Q-104 revision 1 for TCS. Total INR 100,000 excluding GST. Valid for 30 days.',
  ...overrides,
});
const firstQuote = makeSource();
const latestQuote = makeSource({
  id: 'S2', kind: 'attachment', accountId: 'secondary', accountEmail: 'sales@sarv.example',
  subject: 'TCS quotation Q-104 revision 2', from: 'sales@sarv.example', date: Date.UTC(2026, 9, 8) / 1_000,
  attachmentId: 'quote-pdf', filename: 'TCS-quote-revision-2.pdf', location: 'page 1',
  text: 'Quotation Q-104 revision 2. Recipient: TCS. Cloud services. Total INR 90,000 excluding GST. Valid for 15 days.',
});
const plan = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  queries: ['TCS', 'quotation', 'proposal'], entityTerms: ['TCS', 'Tata Consultancy Services'],
  intent: 'sent', quoteIntent: true, filters: {}, ...overrides,
});
const fact = (text: string, sourceId: string, quote: string) => ({ text, sourceIds: [sourceId], quotes: [{ sourceId, text: quote }] });
/** The verifier as the agent runs it: each source checked against the evidence text it was shown as. */
const verify = (facts: unknown[], sources: InboxAssistantEvidence[]) => verifyInboxAssistantFacts(facts,
  new Map(sources.map(source => [source.id, normalizeExcerpt(inboxAssistantEvidenceText(source))])), sources);
const factTexts = (result: ReturnType<typeof verify>) => result.facts.map(item => item.text).join('\n');

describe('Inbox Agent read-only search planning', () => {
  it('keeps literal company aliases and quotation variants for all-account Sent retrieval', () => {
    expect(parseInboxAssistantSearchPlan(plan(), question)).toEqual({
      queries: ['TCS', 'quotation', 'proposal'], entityTerms: ['TCS', 'Tata Consultancy Services'],
      intent: 'sent', quoteIntent: true, filters: {},
    });
  });

  it('uses human sent intent and cannot narrow generic questions using a model guess', () => {
    expect(parseInboxAssistantSearchPlan(plan({ intent: 'all' }), 'What quote have I sent to TCS?').intent).toBe('sent');
    expect(parseInboxAssistantSearchPlan(plan(), 'What quote did TCS send?').intent).toBe('all');
  });

  it.each(['What EPFO proposal did I personally send?', 'What quote have I sent?', 'What did I send to buyer@example.test?', 'Which proposal was sent by me?', 'Find this proposal in our Sent folder'])('retains explicit personal Sent scope for %s', question => {
    expect(parseInboxAssistantSearchPlan(plan({ intent: 'all' }), question).intent).toBe('sent');
  });

  it.each(['check aabout epfo final propsal we send', 'What proposal have we sent to EPFO?', 'Which quotation did we actually send?', 'Which final proposal was sent by us?', 'What did our team submit?'])('includes team and received copies for collective sender scope: %s', question => {
    expect(parseInboxAssistantSearchPlan(plan({ intent: 'sent' }), question).intent).toBe('all');
    expect(fallbackInboxAssistantSearchPlan(question).intent).toBe('all');
  });

  it('accepts structured optional date, participant and attachment filters', () => {
    expect(parseInboxAssistantSearchPlan(plan({ filters: {
      after: '2026-09-01', before: '2026-10-01', to: 'procurement@tcs.example', hasAttachment: true,
    } }), question).filters).toEqual({ after: '2026-09-01', before: '2026-10-01', to: 'procurement@tcs.example', hasAttachment: true });
  });

  it('keeps separately requested company and product anchors while grouping an explicit acronym alias', async () => {
    const question = 'What quote did I send to TCS for Sarv User Directory (UD) licensing?';
    const result = await planInboxAssistantSearch(question, vi.fn().mockResolvedValue(plan({
      entityTerms: ['TCS', 'Tata Consultancy Services', 'Sarv', 'User Directory', 'UD'],
      topicTerms: ['TCS', 'Sarv User Directory', 'UD'],
    })));
    expect(result.requiredTopicGroups).toEqual([['TCS'], ['Sarv User Directory', 'UD']]);
    const fallback = await planInboxAssistantSearch(question, vi.fn().mockRejectedValue(new Error('unavailable')));
    expect(fallback.requiredTopicGroups).toEqual([['TCS'], ['Sarv User Directory', 'UD']]);
    const generic = await planInboxAssistantSearch('What quote did I send to TCS?', vi.fn().mockResolvedValue(plan()));
    expect(generic.requiredTopicGroups).toBeUndefined();
  });

  // Breaks: an article, an auxiliary or a possessive from the question becomes
  // part of a phrase every email must contain, so mail about the right thing is
  // thrown away and the agent says it found nothing.
  it.each([
    ['How much did we quote BHEL for the SCADA upgrade?', [['BHEL'], ['SCADA upgrade']]],
    ['What price did Redington quote for the Cisco switches?', [['Redington'], ['Cisco switches']]],
    ["What did the NASSCOM newsletter say about Karnataka's GCC policy?", [['NASSCOM'], ['Karnataka GCC policy']]],
    ['Has Wipro replied about the overdue invoice?', [['Wipro'], ['overdue invoice']]],
    // "PO" is a thing the question names, so it stays required; "Did" does not.
    ['Did HDFC Bank send the PO for the AMC renewal?', [['PO'], ['HDFC Bank'], ['AMC renewal']]],
  ])('requires only the meaningful words of each named topic: %s', async (question, groups) => {
    const fallback = await planInboxAssistantSearch(question, vi.fn().mockRejectedValue(new Error('unavailable')));
    expect(fallback.requiredTopicGroups).toEqual(groups);
  });

  // Breaks: a model plan's clean topic ("SCADA upgrade") is displaced by the
  // host's longer phrase from the question ("the SCADA upgrade").
  it('keeps the model\'s own wording of a topic when the question adds only an article', async () => {
    const result = await planInboxAssistantSearch('how much did we quote bhel for the scada upgrade', vi.fn().mockResolvedValue(plan({
      entityTerms: ['BHEL'], topicTerms: ['BHEL', 'SCADA upgrade'],
    })));
    expect(result.requiredTopicGroups).toEqual([['BHEL'], ['SCADA upgrade']]);
  });

  it('does not turn model-invented products or a requested team member into required literal topics', async () => {
    const result = await planInboxAssistantSearch('What did Prakash submit for EPFO?', vi.fn().mockResolvedValue(plan({
      topicTerms: ['EPFO', 'Server licensing'], entityTerms: ['EPFO', 'Prakash'], participantTerms: ['Prakash'],
    })));
    expect(result.requiredTopicGroups).toBeUndefined();
  });

  it.each(['Compare TCS User Directory and SIP proposals', 'TCS quotes for User Directory or SIP', 'TCS quotes except User Directory'])('does not invent an AND constraint for alternatives, comparisons or exclusions: %s', async question => {
    const result = await planInboxAssistantSearch(question, vi.fn().mockResolvedValue(plan({
      entityTerms: ['TCS', 'User Directory', 'SIP'], topicTerms: ['TCS', 'User Directory', 'SIP'],
    })));
    expect(result.requiredTopicGroups).toBeUndefined();
  });

  it('does not treat a search year as a product anchor', async () => {
    const result = await planInboxAssistantSearch('What quote did I send to TCS in 2026?', vi.fn().mockResolvedValue(plan({ entityTerms: ['TCS', '2026'] })));
    expect(result.requiredTopicGroups).toBeUndefined();
    expect(() => parseInboxAssistantSearchPlan(plan({ requiredTopicGroups: [['TCS'], ['invented product']] }), question)).toThrow();
  });

  it('validates separate literal topic and participant hints without treating a person as the project', () => {
    const parsed = parseInboxAssistantSearchPlan(plan({ topicTerms: ['EPFO'], participantTerms: ['Prakash'] }), 'What did Prakash submit for EPFO?');
    expect(parsed.topicTerms).toEqual(['EPFO']);
    expect(parsed.participantTerms).toEqual(['Prakash']);
    expect(parsed.intent).toBe('all');
    for (const fields of [{ topicTerms: Array(7).fill('EPFO') }, { participantTerms: ['Prakash OR *'] }, { topicTerms: 'EPFO' }]) {
      expect(() => parseInboxAssistantSearchPlan(plan(fields), question)).toThrow();
    }
  });

  it('accepts a single JSON fence but rejects prose, arrays and mutation fields', () => {
    expect(parseInboxAssistantSearchPlan(`\`\`\`json\n${plan()}\n\`\`\``, question).queries).toContain('TCS');
    for (const raw of [`Here is the plan: ${plan()}`, '[]', 'null', plan({ deleteAll: true }), plan({ filters: { action: 'delete' } })]) {
      expect(() => parseInboxAssistantSearchPlan(raw, question)).toThrow();
    }
  });

  it('discards complete provider reasoning envelopes before parsing a search plan', () => {
    const result = parseInboxAssistantSearchPlan(`<think>PRIVATE SEARCH REASONING</think>\n<analysis>MORE PRIVATE REASONING</analysis>\n${plan()}`, question);
    expect(result.queries).toContain('TCS');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('accepts a complete leading Gemma thought channel while rejecting unfinished or tool-control output', () => {
    const raw = `<|channel>thought\nPRIVATE REASONING {not a plan}\n<channel|>\n\`\`\`json\n${plan()}\n\`\`\``;
    expect(parseInboxAssistantSearchPlan(raw, question).queries).toContain('TCS');
    for (const invalid of [`<|channel>thought PRIVATE ${plan()}`, `<|tool_call>${plan()}<tool_call|>`, `<|channel>analysis ${plan()}`]) {
      expect(() => parseInboxAssistantSearchPlan(invalid, question)).toThrow();
    }
  });

  it('retains host-local today and meeting terms when model planning fails or guesses another date', async () => {
    const options = { nowMs: Date.UTC(2026, 9, 22, 22), timeZone: 'Asia/Kolkata' };
    const query = 'is any meetings invite today';
    const failed = await planInboxAssistantSearch(query, vi.fn().mockResolvedValue('not JSON'), options);
    expect(failed.filters).toEqual({ after: '2026-10-23', before: '2026-10-24' });
    expect(failed.scope).toMatchObject({ meetingIntent: true, timeWindow: { timeZone: 'Asia/Kolkata' } });
    expect(failed.queries).not.toContain('any');
    expect(failed.queries).not.toContain('today');
    expect(failed.queries).toContain('meeting');
    const guessed = await planInboxAssistantSearch(query, vi.fn().mockResolvedValue(plan({
      queries: ['meeting'], entityTerms: [], filters: { after: '2020-01-01', before: '2020-01-02' },
    })), options);
    expect(guessed.filters).toEqual(failed.filters);
    expect(guessed.scope).toEqual(failed.scope);
  });

  it('drops model-invented date, participant-address and attachment restrictions from a company quote search', async () => {
    const callAI = vi.fn().mockResolvedValue(plan({ filters: {
      after: '2026-10-01', before: '2026-10-02', from: 'invented@tcs.example', to: 'invented-buyer@tcs.example', hasAttachment: true,
    } }));
    const result = await planInboxAssistantSearch('What quote did I send to TCS? Read the attachment too.', callAI);
    expect(result.filters).toEqual({});
    expect(result.intent).toBe('sent');
    expect(result.entityTerms).toContain('TCS');
    const wording = await planInboxAssistantSearch('May I see the TCS quote with validity of 30 days?', callAI);
    expect(wording.filters).toEqual({});
  });

  it('retains user-requested calendar dates and literal from/to addresses but not guessed addresses', async () => {
    const filters = { after: '2025-01-01', before: '2026-01-01', from: 'alice@example.test', to: 'bob@example.test' };
    const question = 'Find emails from alice@example.test to bob@example.test in 2025';
    expect((await planInboxAssistantSearch(question, vi.fn().mockResolvedValue(plan({ filters })))).filters).toEqual(filters);
    const guessed = await planInboxAssistantSearch(question, vi.fn().mockResolvedValue(plan({ filters: { ...filters, from: 'carol@example.test' } })));
    expect(guessed.filters.from).toBe('alice@example.test');
    expect(guessed.filters.to).toBe('bob@example.test');
    const failed = await planInboxAssistantSearch('Find emails from alice@example.test to bob@example.test', vi.fn().mockResolvedValue('not JSON'));
    expect(failed.filters).toEqual({ from: 'alice@example.test', to: 'bob@example.test' });
  });

  it.each([
    ['Find emails with attachments', true],
    ['Find emails without attachments', false],
    ['Find emails with no attachments', false],
  ])('uses only an explicit attachment restriction and keeps its requested direction: %s', async (question, expected) => {
    const result = await planInboxAssistantSearch(question, vi.fn().mockResolvedValue(plan({ filters: { hasAttachment: !expected } })));
    expect(result.filters.hasAttachment).toBe(expected);
  });

  it.each([
    { queries: [] }, { queries: Array(7).fill('TCS') }, { queries: ['TCS OR *'] }, { queries: ['"TCS"'] },
    { queries: ['SELECT * FROM emails'] }, { queries: ['TCS\u0000'] }, { queries: [false] },
    { entityTerms: ['x'.repeat(101)] }, { intent: 'trash' }, { quoteIntent: 'yes' },
    { filters: { after: '2026-02-30' } }, { filters: { after: '9999-99-99' } },
    { filters: { after: '2026-11-01', before: '2026-10-01' } }, { filters: { from: 'TCS' } },
    { filters: { to: 'person@tcs.example\nBcc: thief@example.test' } }, { filters: { hasAttachment: 'yes' } },
  ])('rejects an invalid plan %j', (invalid) => {
    expect(() => parseInboxAssistantSearchPlan(plan(invalid), question)).toThrow();
  });

  it('deduplicates case variants and falls back to bounded useful terms when the provider fails', async () => {
    expect(parseInboxAssistantSearchPlan(plan({ queries: ['TCS', 'tcs', 'quotation'] }), question).queries).toEqual(['TCS', 'quotation']);
    const fallback = fallbackInboxAssistantSearchPlan('What quote did I send to TCS?');
    expect(fallback.queries).toContain('TCS');
    expect(fallback.intent).toBe('sent');
    expect(fallback.quoteIntent).toBe(true);
    expect(await planInboxAssistantSearch(question, vi.fn().mockRejectedValue(new Error('Provider offline')))).toEqual(fallbackInboxAssistantSearchPlan(question));
  });

  it('does not promote a malformed action-oriented AI response to a search plan', async () => {
    const callAI = vi.fn().mockResolvedValue('{"tool":"delete_mail","query":"*"}');
    const result = await planInboxAssistantSearch('Delete promotional email', callAI);
    expect(result).not.toHaveProperty('tool');
    expect(result.queries).not.toContain('*');
    expect(callAI).toHaveBeenCalledOnce();
  });

  it('supplies current-date context and treats follow-up history as untrusted context', async () => {
    const callAI = vi.fn().mockResolvedValue(plan());
    await planInboxAssistantSearch(question, callAI, { today: '2026-10-15', historyContext: 'Last question concerned TCS.' });
    expect(callAI.mock.calls[0][0]).toContain('2026-10-15');
    expect(callAI.mock.calls[0][0]).toContain('PREVIOUS_CONVERSATION_UNTRUSTED_JSON');
    expect(buildInboxAssistantSearchPlanPrompt(question)).toContain('READ-ONLY');
    expect(buildInboxAssistantSearchPlanPrompt(question, '2026-10-23', 'Asia/Kolkata')).toContain('Today (Asia/Kolkata calendar date');
    expect(buildInboxAssistantSearchPlanPrompt(question, '2026-10-23', 'Asia/Kolkata')).not.toContain('Today (UTC date');
  });
});

// Real planner replies (shapes recorded from a live model, terms replaced) that
// were thrown away for the weaker keyword fallback on 8 of 16 questions.
describe('Inbox Agent search plans that leave out what the question did not need', () => {
  const bare = (fields: Record<string, unknown>) => JSON.stringify(fields);
  const newDiagnostics = (): InboxAssistantRunDiagnostics => ({ version: 1 });

  // Breaks: a plan with no filters object (the prompt says to omit absent
  // filters) is rejected and the question is searched by keyword rules instead.
  it('uses a model plan that leaves out the filters object', async () => {
    const diagnostics = newDiagnostics();
    const reply = bare({ queries: ['Northwind follow up', 'Northwind'], entityTerms: ['Northwind'], participantTerms: ['Northwind'], intent: 'all', quoteIntent: false });
    const result = await planInboxAssistantSearch('What did Northwind follow up about?', vi.fn().mockResolvedValue(reply), { diagnostics });
    expect(diagnostics.plan?.source).toBe('model');
    expect(diagnostics.plan?.failure).toBeUndefined();
    expect(result.queries).toEqual(expect.arrayContaining(['Northwind follow up', 'Northwind']));
    expect(result.filters).toEqual({});
  });

  // Breaks: null or empty optional fields, which models send instead of
  // leaving them out, reject an otherwise usable plan.
  it.each([
    ['filters null', { filters: null }],
    ['empty filter values', { filters: { after: null, before: '', from: '', to: null, hasAttachment: null } }],
    ['empty participant list', { participantTerms: [] }],
    ['null topic and participant lists', { topicTerms: null, participantTerms: null }],
    ['no entity terms', { entityTerms: undefined }],
    ['null entity terms', { entityTerms: null }],
  ])('accepts %s', (_label, fields) => {
    const parsed = parseInboxAssistantSearchPlan(plan(fields), question);
    expect(parsed.queries).toEqual(['TCS', 'quotation', 'proposal']);
    expect(parsed.filters).toEqual({});
    expect(parsed.topicTerms).toBeUndefined();
    expect(parsed.participantTerms).toBeUndefined();
  });

  // Breaks: a plan without intent or quoteIntent is rejected, or a missing
  // quoteIntent turns a quotation question into a plain one. Both are decided
  // from the question in any case.
  it('derives intent and quoteIntent from the question when the plan leaves them out', () => {
    const parsed = parseInboxAssistantSearchPlan(bare({ queries: ['TCS'] }), question);
    expect(parsed).toEqual({ queries: ['TCS'], entityTerms: [], intent: 'sent', quoteIntent: true, filters: {} });
    expect(parseInboxAssistantSearchPlan(bare({ queries: ['TCS'] }), 'What did TCS say?')).toMatchObject({ intent: 'all', quoteIntent: false });
  });

  // Breaks: leniency about absent fields lets a present but malformed field,
  // an action field or an operator through; or the diagnostics cannot say
  // which field the model got wrong.
  it.each([
    [{ deleteMessages: true }, 'unknown_field'],
    [{ queries: undefined }, 'queries'],
    [{ queries: null }, 'queries'],
    [{ queries: [] }, 'queries'],
    [{ queries: ['TCS OR *'] }, 'queries'],
    [{ entityTerms: 'TCS' }, 'entity_terms'],
    [{ topicTerms: 'EPFO' }, 'topic_terms'],
    [{ participantTerms: ['Prakash OR *'] }, 'participant_terms'],
    [{ intent: 'trash' }, 'intent'],
    [{ intent: '' }, 'intent'],
    [{ quoteIntent: 'yes' }, 'quote_intent'],
    [{ filters: 'none' }, 'filters'],
    [{ filters: [] }, 'filters'],
    [{ filters: { cc: 'a@b.example' } }, 'unknown_filter'],
    [{ filters: { after: '2026-02-30' } }, 'date'],
    [{ filters: { after: '2026-11-01', before: '2026-10-01' } }, 'date_range'],
    [{ filters: { from: 'TCS' } }, 'address'],
    [{ filters: { hasAttachment: 'yes' } }, 'attachment'],
  ])('rejects %j and names the field %s', (fields, field) => {
    let thrown: unknown;
    try { parseInboxAssistantSearchPlan(plan(fields), question); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(InboxAssistantResponseError);
    expect(inboxAssistantAIFailure(thrown)).toEqual({ failure: 'invalid_shape', failedField: field });
  });

  // Breaks: a rejected plan's diagnostics say only "not a usable search plan",
  // so the next planner regression needs raw model output to diagnose.
  it('records which field made the plan unusable, never its value', async () => {
    const diagnostics = newDiagnostics();
    await planInboxAssistantSearch(question, vi.fn().mockResolvedValue(plan({ filters: { from: 'secret-term' } })), { diagnostics });
    expect(diagnostics.plan).toMatchObject({ source: 'fallback', failure: 'invalid_shape', failedField: 'address' });
    expect(JSON.stringify({ ...diagnostics.plan, terms: undefined })).not.toContain('secret-term');
    const notJson = newDiagnostics();
    await planInboxAssistantSearch(question, vi.fn().mockResolvedValue('not JSON'), { diagnostics: notJson });
    expect(notJson.plan).toMatchObject({ source: 'fallback', failure: 'invalid_json' });
    expect(notJson.plan?.failedField).toBeUndefined();
  });

  // Breaks: the prompt keeps telling the model only to omit absent filters,
  // and providers that follow it literally keep sending no filters object.
  it('tells the model to send an empty filters object when none was requested', () => {
    expect(buildInboxAssistantSearchPlanPrompt(question, '2026-11-17', 'UTC')).toContain('use "filters":{} when the user requested none');
  });
});

describe('Inbox Agent grounded-fact verification', () => {
  // Breaks: a local-time claim is checked against the UTC header only, so a right local date is rejected or a wrong one kept.
  it('validates a host-local date and time across the previous UTC day using the exact trusted header', () => {
    const source = makeSource({ date: Date.UTC(2026, 9, 22, 18, 45) / 1000, dateTimeZone: 'Asia/Kolkata',
      text: 'Planning review invitation. Fee INR 12,000. GST 18%.' });
    const local = 'Local date/time (Asia/Kolkata): 2026-10-23T00:15:00+05:30';
    expect(inboxAssistantEvidenceText(source)).toContain('Date: 2026-10-22T18:45:00.000Z');
    expect(inboxAssistantEvidenceText(source)).toContain(local);
    const result = verify([
      { text: 'The invitation was received on 2026-10-23 at 00:15; the fee is INR 12,000 with GST 18%.', sourceIds: ['S1'], quotes: [
        { sourceId: 'S1', text: local }, { sourceId: 'S1', text: source.text },
      ] },
      fact('The invitation was received on 2026-10-24 at 00:15.', 'S1', local),
      fact('The invitation was received on 2026-10-23 at 00:00.', 'S1', local),
      fact('The invitation was received on 2026-10-23 at 00:16.', 'S1', local),
      fact('The invitation was received at 2026-10-23T00:15:00+04:30.', 'S1', local),
      { text: 'The invitation was received on 2026-10-23 at 00:15; the fee is INR 12,001.', sourceIds: ['S1'], quotes: [
        { sourceId: 'S1', text: local }, { sourceId: 'S1', text: source.text },
      ] },
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.text).toContain('2026-10-23 at 00:15');
    expect(result.facts[0]!.quotes[0]!.text).toBe(local);
    expect(factTexts(result)).not.toContain('12,001');
  });

  // Breaks: a bad or injected timezone adds a forged "Local date/time" header the model can quote as proof.
  it.each([undefined, '', 'Invalid/Timezone', 'UTC\nInjected: header'])('omits an invalid or absent host timezone without changing the UTC header: %s', dateTimeZone => {
    const source = makeSource({ dateTimeZone });
    const represented = inboxAssistantEvidenceText(source);
    expect(represented).toContain('Date: 2026-10-01T00:00:00.000Z');
    expect(represented).not.toContain('Local date/time');
    expect(verify([fact('The date is 2026-10-02.', 'S1', 'Local date/time (Invalid/Timezone): 2026-10-02T00:00:00Z')], [source]).facts).toEqual([]);
  });

  // Breaks: Unix-second dates are read as milliseconds and every source claims to be from 1970.
  it('formats Unix-second email timestamps as their actual send date', () => {
    const shown = inboxAssistantEvidenceText(latestQuote);
    expect(shown).toContain('2026-10-08T00:00:00.000Z');
    expect(shown).not.toContain('1970-');
  });

  // Breaks: facts from two revisions in two accounts are merged or one is dropped.
  it('keeps revisions, amounts, accounts and attachment citations separate despite duplicate message IDs', () => {
    const result = verify([
      fact('The earlier sent quotation Q-104 revision 1 was INR 100,000 excluding GST, valid for 30 days.', 'S1', firstQuote.text),
      fact('The latest observed sent quotation Q-104 revision 2 is INR 90,000 excluding GST, valid for 15 days.', 'S2', latestQuote.text),
    ], [firstQuote, latestQuote]);
    expect(result.facts).toHaveLength(2);
    expect(result.rejectedFacts).toEqual([]);
    expect(factTexts(result)).toContain('INR 100,000');
    expect(factTexts(result)).toContain('INR 90,000');
    expect(result.facts.map(item => item.sourceIds)).toEqual([['S1'], ['S2']]);
  });

  // Breaks: a made-up source id or a model-written link reaches the answer.
  it('only keeps supplied source IDs and rejects fabricated citation links in fact text', () => {
    const result = verify([
      fact('The quotation is INR 90,000.', 'S99', latestQuote.text),
      fact('Read [the quote](https://attacker.example/quote).', 'S2', latestQuote.text),
      fact('The quotation is INR 90,000.', 'S2', latestQuote.text),
    ], [latestQuote]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.sourceIds).toEqual(['S2']);
    expect(factTexts(result)).not.toContain('attacker');
    expect(result.rejectedFacts).toEqual([{ index: 1, reason: 'unknown_source' }, { index: 2, reason: 'invalid_fact_shape' }]);
  });

  // Breaks: a fact citing two sources is kept with a quote from only one of them.
  it('requires each cited source to have its own exact supporting excerpt', () => {
    const result = verify([{ text: 'The quotation changed.', sourceIds: ['S1', 'S2'], quotes: [{ sourceId: 'S1', text: firstQuote.text }] }], [firstQuote, latestQuote]);
    expect(result.facts).toEqual([]);
    expect(result.rejectedFacts).toEqual([{ index: 1, reason: 'missing_exact_quote' }]);
  });

  // Breaks: an invented amount is kept because its source id is real.
  it('rejects invented excerpt amounts even when the source ID exists', () => {
    const result = verify([
      fact('The quotation is INR 500,000.', 'S2', 'Total INR 500,000 excluding GST.'),
      fact('The quotation is INR 500,000.', 'S2', latestQuote.text),
    ], [latestQuote]);
    expect(result.facts).toEqual([]);
    expect(result.rejectedFacts).toEqual([{ index: 1, reason: 'missing_exact_quote' }, { index: 2, reason: 'unsupported_number_or_currency' }]);
  });

  // Breaks: a changed tax rate, reference or currency is accepted as long as the quote is real.
  it('rejects a changed tax percentage, reference number or invented currency', () => {
    const source = makeSource({ text: 'Quotation Q-104. Total INR 100,000. GST 18%. Discount 2%.' });
    const result = verify([
      fact('The quotation Q-105 is INR 100,000.', 'S1', source.text),
      fact('The quotation Q-104 includes GST 28%.', 'S1', source.text),
      fact('The quotation Q-104 is USD 100,000.', 'S1', source.text),
      fact('The quotation Q-104 is INR 100000 with GST 18%.', 'S1', source.text),
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(factTexts(result)).toContain('GST 18%');
    expect(factTexts(result)).not.toContain('USD');
  });

  // Breaks: a correct amount written in another unit (crore, lakh, million) or symbol is rejected.
  it.each([
    ['The total commercial value is ₹7.25 Cr.', 'The quotation is INR 72,500,000 (₹7.25 crore).'],
    ['The total commercial value is Rs. 7.25 crore.', 'The quotation is ₹7,25,00,000.'],
    ['Total: 7,25,00,000 rupees.', 'The quotation is INR 7.25 crore.'],
    ['Total INR 25 lakh excluding GST.', 'The quotation is ₹2,500,000 excluding GST.'],
    ['Total USD 1.25 million.', 'The quotation is USD 1,250,000.'],
  ])('supports faithful monetary unit and currency formatting: %s', (quote, claim) => {
    const source = makeSource({ text: quote });
    const result = verify([fact(claim, 'S1', quote)], [source]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.text).toContain(claim);
  });

  // Breaks: a lakh-crore amount is checked only against its first unit and a wrong magnitude passes.
  it.each([
    ['Total ₹8.2 lakh crore.', 'The quotation is ₹8.2 lakh crore.'],
    ['Total ₹8.2 lakh crore.', 'The quotation is INR 8,200,000,000,000.'],
    ['Total Rs. 8.2 lacs Cr.', 'The quotation is ₹82,00,00,00,00,000.'],
    ['Total 8.2 lakh-crore rupees.', 'The quotation is INR 8,200,000,000,000.'],
    ['Total INR 8,200,000,000,000.', 'The quotation is ₹8.2 lakh crore.'],
  ])('verifies the complete lakh-crore monetary scale: %s', (quote, claim) => {
    const source = makeSource({ text: quote });
    const result = verify([fact(claim, 'S1', quote)], [source]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.text).toContain(claim);
    expect(result.facts[0]!.quotes[0]!.text).toBe(quote);
  });

  // Breaks: a truncated scale, an off-by-one amount or a swapped currency is accepted.
  it('rejects truncated compound scales, changed magnitudes and changed currency', () => {
    const quote = 'Total ₹8.2 lakh crore.';
    const source = makeSource({ text: quote });
    const result = verify([
      fact('The quotation is INR 820,000.', 'S1', quote),
      fact('The quotation is INR 82,000,000.', 'S1', quote),
      fact('The quotation is INR 820,000,000,000.', 'S1', quote),
      fact('The quotation is INR 8,200,000,000,001.', 'S1', quote),
      fact('The quotation is ₹8.2 lakh.', 'S1', quote),
      fact('The quotation is ₹8.2 crore.', 'S1', quote),
      fact('The quotation is USD 8,200,000,000,000.', 'S1', quote),
      fact('The quotation is INR 8,200,000,000,000.', 'S1', quote),
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.text).toBe('The quotation is INR 8,200,000,000,000.');
    expect(result.rejectedFacts).toHaveLength(7);
  });

  // Breaks: an unsupported unit after a supported one is ignored and the amount is accepted.
  it.each([
    ['Total ₹8.2 crore lakh.', 'The quotation is INR 82,000,000.'],
    ['Total ₹8.2 lakh lakh.', 'The quotation is INR 820,000.'],
    ['Total ₹8.2 lakh crore million.', 'The quotation is INR 8,200,000,000,000.'],
    ['Total ₹8.2 crore lakh.', 'The quotation is ₹8.2 crore lakh.'],
    ['Total INR 82,000,000.', 'The quotation is ₹8.2 crore lakh.'],
  ])('fails closed instead of validating only the first unsupported monetary unit: %s', (quote, claim) => {
    const source = makeSource({ text: quote });
    const result = verify([fact(claim, 'S1', quote)], [source]);
    expect(result.facts).toEqual([]);
    expect(result.rejectedFacts).toHaveLength(1);
  });

  // Breaks: unit tolerance for money leaks into references and tax figures.
  it('rejects changed monetary magnitude and keeps unrelated references and tax figures strict', () => {
    const quote = 'Quotation Q-104. Total Rs. 7.25 crore excluding GST. GST 18%.';
    const source = makeSource({ text: quote });
    const result = verify([
      fact('The quotation is ₹7.25 billion.', 'S1', quote),
      fact('The quotation is INR 725,000,000.', 'S1', quote),
      fact('Quotation Q-72500000 is ₹72,500,000.', 'S1', quote),
      fact('The quotation is ₹72,500,000 with GST 28%.', 'S1', quote),
      fact('The quotation Q-104 is INR 72,500,000 excluding GST, with GST 18%.', 'S1', quote),
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(factTexts(result)).toContain('Q-104');
  });

  // Breaks: a spreadsheet's saved formula value cannot be stated in rupees, or is rounded to a wrong figure or currency.
  it('accepts two-decimal INR presentation of a currency-labelled saved XLSX formula value', () => {
    const quote = 'Currency: INR\nB17: Total Bid Value including GST | D17: 123456789.12000001 (saved formula value)';
    const source = makeSource({ kind: 'attachment', filename: 'price-bid.xlsx', text: quote });
    const result = verify([
      fact('The total bid value including GST is INR 12,34,56,789.12.', 'S1', quote),
      fact('The total bid value including GST is INR 12,34,56,789.13.', 'S1', quote),
      fact('The total bid value including GST is INR 1,23,45,67,891.20.', 'S1', quote),
      fact('The total bid value including GST is USD 123,456,789.12.', 'S1', quote),
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(factTexts(result)).toContain('INR 12,34,56,789.12');
    expect(factTexts(result)).not.toContain('USD');
  });

  // Breaks: floating-point storage tolerance lets a rounded tax rate or reference through.
  it('limits floating storage tolerance to monetary values and keeps reference/tax precision exact', () => {
    const quote = 'Total INR 123456789.12000001. Tax 18.00000001%. Reference Q-104.00000001.';
    const source = makeSource({ text: quote });
    const result = verify([
      fact('The total is INR 123,456,789.12.', 'S1', quote),
      fact('The total is INR 123,456,789.13.', 'S1', quote),
      fact('The tax is 18%.', 'S1', quote),
      fact('The quotation reference is Q-104.', 'S1', quote),
    ], [source]);
    expect(result.facts).toHaveLength(1);
  });

  // Breaks: a spreadsheet number with no currency, or a non-total cell, is presented as a rupee total.
  it.each([
    'B17: Total Bid Value including GST | D17: 123456789.12000001 (saved formula value)',
    'Currency: INR\nB17: Quotation reference | D17: 123456789.12000001 (saved formula value)',
    'Currency: INR and USD\nB17: Total Bid Value including GST | D17: 123456789.12000001 (saved formula value)',
    'Currency: INR\nB17: Total Bid Value including GST | D17: 123456789.125 (saved formula value)',
  ])('does not infer a currency or broadly round other spreadsheet numbers: %s', quote => {
    const source = makeSource({ text: quote });
    const result = verify([fact('The total is INR 123,456,789.12.', 'S1', quote)], [source]);
    expect(result.facts).toHaveLength(0);
  });

  // Breaks: PDF line breaks make an exact quote fail, or whitespace normalising lets a changed word match.
  it('accepts whitespace-only PDF extraction differences without fuzzy matching missing words', () => {
    const source = makeSource({ text: 'Quotation Q-104.\nTotal INR\n100,000 excluding\tGST.' });
    const result = verify([
      fact('The quotation is INR 100,000 excluding GST.', 'S1', 'Total INR 100,000 excluding GST.'),
      fact('The quotation includes GST.', 'S1', 'Total INR 100,000 including GST.'),
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(factTexts(result)).toContain('excluding GST');
  });

  // Breaks: the agent tells the user they sent a quotation they only received.
  it('cannot call a received or forwarded quotation something the user sent', () => {
    const source = makeSource({ sent: false, folder: 'Inbox', from: 'vendor@tcs.example', text: 'Please review our quotation for INR 100,000.' });
    const result = verify([
      fact('You sent a quotation for INR 100,000.', 'S1', source.text),
      fact('The received quotation is for INR 100,000.', 'S1', source.text),
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(factTexts(result)).toContain('received quotation');
    expect(result.rejectedFacts).toEqual([{ index: 1, reason: 'personal_sent_attribution' }]);
  });

  // Breaks: an answer hides that an account was not searched, results were cut off or attachments were unreadable.
  it('deterministically reports unavailable accounts, local result limits and unreadable attachments', () => {
    const coverage = [makeCoverage({ truncated: true, missingBodies: 1, attachmentsSkipped: 2, warnings: ['A password-protected PDF was skipped.'] }),
      makeCoverage({ accountId: 'other', email: 'other@example.test', status: 'unavailable' })];
    const warnings = inboxAssistantCoverageWarnings(coverage);
    expect(warnings.join(' ')).toContain('other@example.test');
    expect(warnings.join(' ')).toContain('1 matching message has');
    expect(warnings.join(' ')).toContain('2 attachments could');
    expect(warnings.join(' ')).toContain('result limit');
    expect(warnings).toContain('A password-protected PDF was skipped.');
    expect(inboxAssistantCoverageWarnings([makeCoverage()])).toEqual([]);
  });

  // Breaks: an equivalent timestamp in another offset is rejected, or allowing it relaxes amounts, tax or the time itself.
  it('accepts a provably equivalent offset timestamp without relaxing amounts, tax or changed times', () => {
    const quote = 'Meeting time: 2026-10-23T09:30:00.000Z. Fee INR 12,000. GST 18%. Reference MT-15.';
    const source = makeSource({ text: quote });
    const result = verify([
      fact('The meeting time is 2026-10-23T15:00:00+05:30; the fee is INR 12,000 with GST 18%.', 'S1', quote),
      fact('The meeting time is 2026-10-23T09:00:00Z.', 'S1', quote),
      fact('The meeting time is 2026-10-23T15:00:00+05:30; the fee is INR 12,001.', 'S1', quote),
      fact('The meeting time is 2026-10-23T15:00:00+05:30 with GST 28%.', 'S1', quote),
      fact('The meeting date is 2026-23-10.', 'S1', quote),
    ], [source]);
    expect(result.facts).toHaveLength(1);
    expect(factTexts(result)).toContain('2026-10-23T15:00:00+05:30');
    expect(factTexts(result)).not.toContain('12,001');
  });

  // Breaks: binary storage noise (.12000001) is shown to the user, or tidying it changes a tax rate, reference, rate or the quoted source.
  it('presents only sub-micro-unit monetary storage noise to cents and leaves quoted source values intact', () => {
    const quote = 'Total INR 123456789.12000001. GST 18.00000001%. Reference Q-104.00000001. Rate USD 10.615. Offer ₹7.25 crore.';
    const source = makeSource({ text: quote });
    const claim = 'Total INR 123456789.12000001 with GST 18.00000001%, reference Q-104.00000001, rate USD 10.615, and offer ₹7.25 crore.';
    const result = verify([fact(claim, 'S1', quote)], [source]);
    const shown = factTexts(result);
    expect(shown).toContain('INR 12,34,56,789.12');
    expect(shown).toContain('GST 18.00000001%');
    expect(shown).toContain('Q-104.00000001');
    expect(shown).toContain('USD 10.615');
    expect(shown).toContain('₹7.25 crore');
    expect(result.facts[0]!.quotes[0]!.text).toBe(quote);
  });

  // Breaks: model-control markers in a fact reach the answer, or the same literal text inside an email cannot be quoted.
  it('rejects a Gemma thought channel in fact text while accepting the same literal control strings quoted from a source', () => {
    const source = makeSource({ text: 'The literal marker <|channel>thought SOURCE TEXT <channel|> appears in this message.' });
    const quoted = verify([fact('The message contains a literal marker.', 'S1', source.text)], [source]);
    expect(quoted.facts).toHaveLength(1);
    expect(quoted.facts[0]!.quotes[0]!.text).toBe(source.text);
    const invalid = verify([fact('<|channel>thought PRIVATE <channel|> The quotation is INR 100,000.', 'S1', firstQuote.text)], [firstQuote]);
    expect(invalid.facts).toEqual([]);
    expect(invalid.rejectedFacts).toEqual([{ index: 1, reason: 'invalid_fact_shape' }]);
  });

  // Breaks: a model's private reasoning embedded in a fact is shown to the user.
  it('never keeps reasoning markup embedded in a model fact', () => {
    const result = verify([fact('<think>Private reasoning</think> The quotation is INR 100,000.', 'S1', firstQuote.text)], [firstQuote]);
    expect(result.facts).toEqual([]);
    expect(result.rejectedFacts).toEqual([{ index: 1, reason: 'invalid_fact_shape' }]);
  });

  // Breaks: a quote from past the per-source text limit, which the model was never shown, verifies a fact.
  it('does not validate excerpts outside the bounded source text the model was shown', () => {
    const source = makeSource({ text: `${'A'.repeat(24_100)} Hidden price INR 999999.` });
    expect(inboxAssistantEvidenceText(source)).not.toContain('Hidden price');
    const result = verify([fact('The quote is INR 999999.', 'S1', 'Hidden price INR 999999.')], [source]);
    expect(result.facts).toEqual([]);
    expect(result.rejectedFacts).toEqual([{ index: 1, reason: 'missing_exact_quote' }]);
  });
});

describe('model reply parsing', () => {
  // Breaks: a provider's reasoning around the JSON reaches the parsed reply, or an unfinished, oversized or non-object reply is accepted.
  it('strips complete reasoning envelopes around a JSON reply and rejects unfinished, oversized or non-object replies', () => {
    const raw = `<think>PRIVATE ANSWER REASONING WITH INR 999999</think>\n\`\`\`json\n{"facts":[]}\n\`\`\`\n<analysis>PRIVATE POST-ANSWER REASONING</analysis>`;
    expect(jsonObject(raw, 48_000)).toEqual({ facts: [] });
    for (const invalid of ['<analysis>Unfinished private reasoning', 'I think the quote is 100000.', '[]', '<|tool_call>{"facts":[]}<tool_call|>']) {
      expect(() => jsonObject(invalid, 48_000)).toThrow(InboxAssistantResponseError);
    }
    expect(() => jsonObject('x'.repeat(48_001), 48_000)).toThrow('too large');
  });
});

describe('diagnostics helpers for model replies', () => {
  // Breaks: a run's record blames the provider for a Stop, or a parser bug is
  // filed under the wrong failure class.
  it('classifies why a model call or its reply could not be used', () => {
    expect(inboxAssistantAIFailure(new InboxAssistantResponseError('too big', 'too_large'))).toEqual({ failure: 'too_large' });
    expect(inboxAssistantAIFailure(new InboxAssistantResponseError('bad json', 'invalid_json'))).toEqual({ failure: 'invalid_json' });
    expect(inboxAssistantAIFailure(new InboxAssistantResponseError('bad plan'))).toEqual({ failure: 'invalid_shape' });
    expect(inboxAssistantAIFailure(new DOMException('Aborted', 'AbortError'))).toEqual({ failure: 'cancelled' });
    expect(inboxAssistantAIFailure(Object.assign(new Error('nope'), { status: 403 }))).toEqual({ failure: 'auth', httpStatus: 403 });
    expect(inboxAssistantAIFailure('a thrown string')).toEqual({ failure: 'unknown' });
  });

  // Breaks: the app and the provider evaluation ask for different output sizes,
  // so the evaluation measures truncation the app would not have.
  it('defines the output limits once', () => {
    expect(INBOX_ASSISTANT_OUTPUT_TOKENS).toEqual({ plan: 1_600 });
  });
});
