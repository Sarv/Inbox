import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compactInboxAgentMessages, INBOX_AGENT_BUDGET } from '../../../../electron/services/inbox-assistant-agent';
import { inboxAssistantRunSummary } from '../../../../electron/services/inbox-assistant-diagnostics';
import { createAssistantHarness, lastToolResult, NO_FACTS, type AgentReply, type AgentTurn, type AssistantHarness } from '../../../helpers/assistant-harness';

// The Inbox Agent as a loop (docs/INBOX_AGENT_HARNESS.md, Phase 1): the model
// picks tools, the host runs them over REAL account databases, and the answer
// is kept only where its quotes appear in what a tool showed. A regression here
// looks like an answer that cites mail the agent never read, a count the mailbox
// does not have, a model that cannot use tools getting nothing, or a run that
// never ends. The model is scripted; everything else is production code.

const T0 = 1_780_000_000;
const DAY = 86_400;

let harness: AssistantHarness;

/** A scripted model: each turn's reply, in order. A function sees the turn. */
function script(...replies: Array<AgentReply | ((turn: AgentTurn) => AgentReply)>): void {
  let index = 0;
  harness.agent = turn => {
    const reply = replies[Math.min(index++, replies.length - 1)]!;
    return typeof reply === 'function' ? reply(turn) : reply;
  };
}

const call = (name: string, args: Record<string, unknown> = {}): AgentReply => ({ tools: [{ name, arguments: args }] });
const answer = (facts: unknown[], message?: string): AgentReply => call('answer', { facts, ...(message ? { message } : {}) });
const fact = (text: string, sourceIds: string[], quotes: Array<[string, string]>) => ({ text, sourceIds, quotes: quotes.map(([sourceId, quote]) => ({ sourceId, text: quote })) });

async function mail(accountId: string, id: string, over: Record<string, unknown> = {}): Promise<void> {
  await harness.mail(accountId, `t-${id}`, { id, subject: `Subject ${id}`, cleanBody: `${id} body`, rawBody: `<p>${id} body</p>`, ...over });
}

async function ask(question: string) {
  harness.newChat();
  return harness.ask(question);
}

beforeEach(async () => {
  harness = await createAssistantHarness({ agent: () => answer([]) });
});
afterEach(async () => { await harness.close(); });

describe('every typed question', () => {
  // Breaks: a question the old fixed pipeline claimed (a capability question, an
  // unread review, a mail command) is answered by a removed path instead of the agent.
  it('reaches the agent, and is recorded as its route', async () => {
    for (const question of ['What can you do?', 'Review my unread emails', 'Mark all BigBlueButton emails as read']) {
      harness.agentTurns.length = 0;
      script(answer([], 'Done.'));
      const exchange = await ask(question);
      expect(harness.agentTurns, question).toHaveLength(1);
      expect(harness.agentTurns[0]!.messages[1]!.content).toBe(`User request: ${question}`);
      expect(exchange.diagnostics).toMatchObject({ route: 'agent', outcome: 'answered' });
    }
    expect(harness.calls).toEqual([]);
  });
});

describe('answers grounded in what the tools showed', () => {
  // Breaks: the model is never told the rules the grounding check enforces on
  // money and on each fact's size (they were only in the retired one-shot
  // answer prompt), so its totals and spending answers are thrown away.
  it('tells the model the limits and money rules the check enforces', async () => {
    script(answer([], 'Done.'));
    await ask('How much did I spend this month?');
    const system = harness.agentTurns[0]!.messages[0]!.content!;
    expect(system).toContain('At most 6 ids and 12 quotes per fact.');
    expect(system).toContain('A total may be stated only by also naming each amount it adds');
    expect(system).toContain('never a reminder, a scheduled or upcoming autopay');
  });

  // Breaks: "how many" is answered from the model's guess instead of the mailbox.
  it('answers a count from a tool result, with no email cited', async () => {
    await mail('primary', 'a');
    await mail('primary', 'b');
    await mail('secondary', 'c', { tags: '|INBOX|read|' });
    script(
      call('count_mail', { unread: true }),
      turn => {
        expect(lastToolResult(turn)).toContain('Total: 2');
        return answer([fact('You have 2 unread emails.', ['T1'], [['T1', 'Total: 2']])]);
      },
    );
    const exchange = await ask('How many unread emails do I have?');
    expect(exchange.answer.text).toBe('You have 2 unread emails.');
    expect(exchange.answer.sources).toEqual([]);
    expect(exchange.diagnostics).toMatchObject({ route: 'agent', outcome: 'answered', agent: { mode: 'native', steps: 2, toolCalls: { count_mail: 1 }, stop: 'answered' } });
    expect(exchange.answer.coverage.map(item => item.matchedMessages)).toEqual([2, 0]);
  });

  // Breaks: a fact read from an email is shown without the link to that email.
  it('cites the email a fact was read from', async () => {
    await mail('primary', 'quote', { subject: 'Quotation for Acme', fromAddress: 'sales@acme.example', cleanBody: 'Our total price is INR 12,000 for the annual plan.' });
    script(
      call('search_mail', { text: 'Acme quotation' }),
      call('read_message', { id: 'S1' }),
      answer([fact('Acme quoted INR 12,000.00 for the annual plan.', ['S1'], [['S1', 'Our total price is INR 12,000 for the annual plan.']])]),
    );
    const exchange = await ask('What did Acme quote?');
    expect(exchange.answer.text).toBe('Acme quoted INR 12,000.00 for the annual plan. [S1]');
    expect(exchange.answer.sourceStatus).toBe('verified');
    expect(exchange.answer.sources).toEqual([expect.objectContaining({ id: 'S1', emailId: 'quote', subject: 'Quotation for Acme', excerpt: 'Our total price is INR 12,000 for the annual plan.' })]);
    expect(exchange.diagnostics?.outcome).toBe('verified');
    expect(exchange.answer.coverage[0]).toMatchObject({ reviewedMessages: 1 });
  });

  // Breaks: an invented quote passes, or a correct second attempt is thrown away.
  it('turns away a quote the email does not contain, and keeps the corrected answer', async () => {
    await mail('primary', 'quote', { cleanBody: 'Total price INR 12,000.' });
    script(
      call('read_message', { id: 'S1' }),
      call('search_mail', {}),
      turn => {
        expect(lastToolResult(turn)).toContain('Total matching: 1');
        return answer([fact('The price is INR 15,000.', ['S1'], [['S1', 'Total price INR 15,000.']])]);
      },
      turn => {
        expect(lastToolResult(turn)).toContain('fact 1: missing exact quote');
        return answer([fact('The price is INR 12,000.', ['S1'], [['S1', 'Total price INR 12,000.']])]);
      },
    );
    const exchange = await ask('What is the price?');
    expect(exchange.answer.text).toBe('The price is INR 12,000. [S1]');
    expect(exchange.diagnostics?.answer).toMatchObject({
      first: { format: 'valid', factsReturned: 1, factsVerified: 0, rejected: { missing_exact_quote: 1 } },
      repair: { reason: 'rejected_facts', pass: { factsVerified: 1 }, factsRecovered: 1 }, factsFinal: 1,
    });
    // The first turn asked to read an id no tool had returned yet.
    expect(harness.agentTurns[1]!.messages.at(-1)!.content).toContain('S1 is not an email id from this conversation');
  });

  // Breaks: two bad answers leave the user with an invented fact instead of an honest "not verified".
  it('drops facts that fail twice and says so', async () => {
    await mail('primary', 'quote', { cleanBody: 'Total price INR 12,000.' });
    script(
      call('search_mail', {}),
      answer([fact('Price INR 15,000.', ['S1'], [['S1', 'INR 15,000']])]),
      answer([fact('Price INR 15,000.', ['S9'], [['S9', 'INR 15,000']])]),
    );
    const exchange = await ask('What is the price?');
    expect(exchange.answer.text).toMatch(/^I found related mail, but could not verify/);
    expect(exchange.answer.warnings).toContain('Some AI statements were omitted because their source references or excerpts could not be verified.');
    expect(exchange.diagnostics?.answer?.repair?.pass?.rejected).toEqual({ unknown_source: 1 });
    expect(exchange.diagnostics?.outcome).toBe('no_evidence');
  });

  // Breaks: a number slips into the free-text message, where nothing checks it.
  it('refuses a number in the message that no tool showed', async () => {
    script(
      answer([], 'You have 57 unread emails.'),
      turn => {
        expect(lastToolResult(turn)).toContain('message: contains a number that is not in any result');
        return answer([], 'Which account do you mean?');
      },
    );
    const exchange = await ask('How many unread?');
    expect(exchange.answer.text).toBe('Which account do you mean?');
    expect(exchange.diagnostics?.outcome).toBe('answered');
  });

  // Breaks: an over-long message floods the chat, or a malformed answer is shown as is.
  it('refuses an over-long message and a malformed answer', async () => {
    script(
      answer([], 'x'.repeat(INBOX_AGENT_BUDGET.messageChars + 1)),
      call('answer', { facts: 'not a list' }),
    );
    const exchange = await ask('Hello?');
    expect(lastToolResult(harness.agentTurns[1]!)).toContain(`message: longer than ${INBOX_AGENT_BUDGET.messageChars} characters`);
    expect(exchange.answer.text).toMatch(/^I could not find supporting mail/);
    expect(exchange.diagnostics?.answer?.repair?.pass?.format).toBe('malformed');
  });

  // Breaks: a model that answers in prose is either lost entirely or trusted with numbers.
  it('asks a prose answer to use the answer tool once, then keeps prose only without numbers', async () => {
    script({ text: 'I think you have about 40.' }, { text: 'Sorry, I cannot tell.' });
    const exchange = await ask('How many?');
    expect(harness.agentTurns[1]!.messages.at(-1)!.content).toContain('Reply by calling a tool');
    expect(exchange.answer.text).toBe('Sorry, I cannot tell.');
    expect(exchange.diagnostics?.agent?.nudges).toBe(1);

    script({ text: 'one' }, { text: 'You have 40.' });
    const second = await ask('How many?');
    expect(second.answer.text).toMatch(/^I could not find supporting mail/);
  });
});

describe('what the agent may touch', () => {
  // Breaks: a tool name the model invents (or an email tells it to use) changes mail.
  it('has no tool that changes mail, and says so to the model', async () => {
    await mail('primary', 'a');
    script(call('search_mail', {}), call('mark_read', { ids: ['S1'] }), answer([], 'Changing mail is not available yet.'));
    const exchange = await ask('Mark everything read');
    expect(harness.agentTurns[0]!.tools).not.toContain('mark_read');
    expect(lastToolResult(harness.agentTurns[2]!)).toContain('there is no tool named "mark_read"');
    expect(harness.engine.ops).toEqual([]);
    expect(exchange.diagnostics?.agent?.toolErrors).toEqual({ unknown_tool: 1 });
  });

  // Breaks: a filename taken from an email's text makes the reader open some other file.
  it('reads only an attachment the email actually carries', async () => {
    await mail('primary', 'doc', { attachmentCount: 1, attachmentNames: JSON.stringify(['offer.pdf']) });
    const readAttachment = vi.fn(async (_ref: { accountId: string; emailId: string; filename: string }) => ({ ref: { accountId: 'primary', emailId: 'doc', filename: 'offer.pdf' }, status: 'ready' as const,
      segments: [{ text: 'Grand total INR 5,00,000', locator: { label: 'Page 1' } }], truncated: false }));
    harness.deps.readAttachment = readAttachment as never;
    script(
      call('search_mail', {}),
      call('read_attachment', { id: 'S1', filename: '../../etc/passwd' }),
      call('read_attachment', { id: 'S1', filename: 'notes.exe' }),
      call('read_attachment', { id: 'S1', filename: 'OFFER.PDF' }),
      answer([fact('The offer totals INR 5,00,000.', ['S2'], [['S2', 'Grand total INR 5,00,000']])]),
    );
    const exchange = await ask('What is the offer total?');
    expect(lastToolResult(harness.agentTurns[2]!)).toContain('has no attachment named "../../etc/passwd"');
    expect(lastToolResult(harness.agentTurns[3]!)).toContain('has no attachment named "notes.exe"');
    expect(readAttachment).toHaveBeenCalledTimes(1);
    expect(readAttachment.mock.calls[0]![0]).toEqual({ accountId: 'primary', emailId: 'doc', filename: 'offer.pdf' });
    expect(exchange.answer.sources).toEqual([expect.objectContaining({ id: 'S2', kind: 'attachment', filename: 'offer.pdf' })]);
    expect(exchange.answer.coverage[0]).toMatchObject({ attachmentsRead: 1 });
  });

  // Breaks: one account's search leaks into an account the user did not select.
  it('searches only the selected accounts, and one named account when asked', async () => {
    await mail('primary', 'p');
    await mail('secondary', 's');
    script(
      call('search_mail', {}),
      turn => {
        expect(lastToolResult(turn)).toContain('Total matching: 1');
        expect(lastToolResult(turn)).toContain('account rc@sarv.example');
        return call('search_mail', { account: 'sales@sarv.example' });
      },
      turn => {
        expect(lastToolResult(turn)).toContain('is not one of the selected accounts');
        return answer([]);
      },
    );
    harness.newChat();
    await harness.ask('List my mail', { accountIds: ['primary'] });
    expect(harness.agentTurns).toHaveLength(3);
  });

  // Breaks: a misspelt filter is dropped silently and the search widens to everything.
  it('refuses unknown or malformed arguments instead of ignoring them', async () => {
    script(
      call('search_mail', { unred: true }),
      call('search_mail', { after: '2026-13-01' }),
      call('search_mail', { after: '2026-05-02', before: '2026-05-01' }),
      call('search_mail', { limit: 500 }),
      call('search_mail', { sort: 'random' }),
      call('search_mail', { folder: 'Receipts' }),
      call('search_mail', { category: 'nonsense' }),
      { tools: [{ name: 'count_mail', arguments: 'not json' }] },
      answer([]),
    );
    await ask('Find mail');
    const results = harness.agentTurns.slice(1).map(lastToolResult);
    expect(results[0]).toContain('Unknown argument "unred"');
    expect(results[1]).toContain('"after" must be a date written YYYY-MM-DD');
    expect(results[2]).toContain('"after" must be earlier than "before"');
    expect(results[3]).toContain('"limit" must be a whole number from 1 to 50');
    expect(results[4]).toContain('"sort" must be newest, oldest or relevance');
    expect(results[5]).toContain('No folder named "receipts"');
    expect(results[6]).toContain('"nonsense" is not a category');
    expect(results[7]).toContain('The arguments were not valid JSON');
  });
});

describe('search filters over real mailboxes', () => {
  // Breaks: the agent cannot tell sent from received, or old from new, so "what did I send last week" is wrong.
  it('filters by folder role, date and sender, and pages', async () => {
    await mail('primary', 'old', { date: T0 - 40 * DAY, fromAddress: 'boss@corp.example' });
    await mail('primary', 'new', { date: T0, fromAddress: 'boss@corp.example' });
    await harness.mail('primary', 't-sent', { id: 'sent', subject: 'My reply', sent: true, date: T0 });
    await mail('primary', 'gone', { folderId: 'f-trash', tags: '|Trash|' });
    script(
      call('search_mail', { folder: 'sent' }),
      call('search_mail', { from: 'boss@corp', after: '2026-05-01' }),
      call('search_mail', { limit: 1, offset: 1, sort: 'oldest' }),
      call('search_mail', { folder: 'everywhere' }),
      call('search_mail', { folder: 'archive' }),
      call('list_folders', {}),
      answer([]),
    );
    await ask('Show my mail');
    const [sent, recent, paged, everywhere, archive, folders] = harness.agentTurns.slice(1).map(lastToolResult);
    expect(sent).toContain('Total matching: 1');
    expect(sent).toContain('Subject: My reply');
    expect(recent).toContain('Total matching: 1');
    expect(recent).toContain('Subject: Subject new');
    expect(paged).toMatch(/Total matching: 3\. Showing 2–2/);
    expect(everywhere).toContain('Total matching: 4');
    expect(archive).toContain('rc@sarv.example has no archive folder.');
    expect(archive).toContain('sales@sarv.example has no archive folder.');
    expect(folders).toContain('INBOX (inbox):');
  });

  // Breaks: "uncategorized unread" (the request that was refused) cannot even be found.
  it('finds unread mail with no category, and lists categories', async () => {
    await mail('primary', 'plain');
    await mail('primary', 'money', { tags: '|INBOX|finance|' });
    await mail('primary', 'seen', { tags: '|INBOX|read|' });
    script(
      call('search_mail', { unread: true, category: 'none', account: 'rc@sarv.example' }),
      call('search_mail', { category: 'finance' }),
      call('list_categories', { account: 'rc@sarv.example' }),
      answer([]),
    );
    await ask('Review my uncategorized unread emails');
    const [none, finance, categories] = harness.agentTurns.slice(1).map(lastToolResult);
    expect(none).toContain('Total matching: 1');
    expect(none).toContain('Subject: Subject plain');
    expect(none).toContain('Category: none');
    expect(finance).toContain('Category: finance');
    expect(categories).toContain('finance (Finance)');
  });

  // Breaks: an account that cannot be opened fails the whole question, or is reported as searched.
  it('keeps going when one account cannot be opened, and reports it', async () => {
    await mail('primary', 'a');
    const open = harness.deps.openMailbox;
    harness.deps.openMailbox = async accountId => {
      if (accountId === 'secondary') throw new Error('locked');
      return open(accountId);
    };
    script(call('count_mail', {}), answer([fact('There is 1 email.', ['T1'], [['T1', 'Total: 1']])]));
    const exchange = await ask('How many emails?');
    expect(lastToolResult(harness.agentTurns[1]!)).toContain('sales@sarv.example could not be opened and was not searched.');
    expect(exchange.answer.warnings).toContain('Unavailable accounts: sales@sarv.example. Their mail was not searched.');
  });
});

describe('reading and judging', () => {
  // Breaks: an email whose body was never downloaded is answered from its preview.
  it('downloads a missing body before reading it', async () => {
    await mail('primary', 'bare', { rawBody: '', cleanBody: '', hasBody: false });
    const open = harness.deps.openMailbox;
    const fetchBody = vi.fn(async (email: EmailRecord) => ({ ...email, rawBody: '<p>Downloaded content here.</p>', cleanBody: 'Downloaded content here.', hasBody: true }));
    harness.deps.openMailbox = async accountId => ({ ...(await open(accountId)), fetchBody });
    script(call('search_mail', {}), call('read_message', { id: 'S1' }), answer([fact('It says downloaded content here.', ['S1'], [['S1', 'Downloaded content here.']])]));
    const exchange = await ask('What does it say?');
    expect(fetchBody).toHaveBeenCalledTimes(1);
    expect(exchange.answer.sourceStatus).toBe('verified');
  });

  // Breaks: a body that cannot be downloaded is read as if complete.
  it('marks a body that could not be downloaded', async () => {
    await mail('primary', 'bare', { rawBody: '', cleanBody: 'short preview', hasBody: false });
    const open = harness.deps.openMailbox;
    harness.deps.openMailbox = async accountId => ({ ...(await open(accountId)), fetchBody: async () => { throw new Error('offline'); } });
    script(call('search_mail', {}), call('read_message', { id: 'S1' }), call('read_message', { id: 'S1' }), answer([]));
    const exchange = await ask('What does it say?');
    expect(lastToolResult(harness.agentTurns[2]!)).toContain('Content status: original unavailable');
    expect(exchange.answer.coverage[0]).toMatchObject({ reviewedMessages: 1, missingBodies: 1 });
    expect(exchange.answer.warnings).toContain('1 matching message has no locally available body.');
  });

  // Breaks: a follow-up about "the rest of that conversation" cannot see the replies.
  it('lists a whole conversation with ids for each email', async () => {
    await harness.mail('primary', 'thread-1', { id: 'first', subject: 'Plan', date: T0 - DAY });
    await harness.mail('primary', 'thread-1', { id: 'second', subject: 'Re: Plan', date: T0 });
    script(call('search_mail', { subject: 'Re: Plan' }), call('read_thread', { id: 'S1' }), answer([]));
    await ask('Show the conversation');
    const thread = lastToolResult(harness.agentTurns[2]!);
    expect(thread).toContain('Conversation of S1: 2 emails.');
    expect(thread.indexOf('Subject: Plan')).toBeLessThan(thread.indexOf('Subject: Re: Plan'));
  });

  // Breaks: "mark read if not business" cannot be judged across many emails, or a bad batch
  // labels mail it never read.
  it('sorts many emails against a question, and leaves a failed batch unsure', async () => {
    for (let index = 1; index <= 12; index++) await mail('primary', `m${index}`, { subject: index <= 2 ? 'Invoice from supplier' : 'Weekly newsletter' });
    let batch = 0;
    harness.ai = (prompt, purpose) => {
      if (purpose !== 'classify') return NO_FACTS;
      if (++batch === 2) return { status: 400 };
      const ids = [...prompt.matchAll(/"id":"(S\d+)"/g)].map(match => match[1]);
      return JSON.stringify({ results: ids.map(id => ({ id, label: prompt.includes(`"id":"${id}"`) && /Invoice/.test(prompt.split(`"id":"${id}"`)[1]!.slice(0, 200)) ? 'business' : 'not_business', reason: 'subject' })) });
    };
    script(
      call('search_mail', { unread: true, limit: 50 }),
      turn => call('classify_messages', { ids: [...lastToolResult(turn).matchAll(/^(S\d+) \|/gm)].map(match => match[1]), question: 'Is it related to business?', labels: ['business', 'not_business'] }),
      turn => {
        expect(lastToolResult(turn)).toMatch(/Label counts: business \d+, not_business \d+, unsure 2/);
        expect(lastToolResult(turn)).toContain('1 of 2 batches could not be sorted');
        return answer([], 'Changing mail from this chat is not available yet.');
      },
    );
    const exchange = await ask('Review my uncategorized unread emails. mark email read if email is not relived to business');
    expect(harness.calls.filter(item => item.purpose === 'classify')).toHaveLength(2);
    expect(harness.engine.ops).toEqual([]);
    expect(exchange.usage?.calls.map(item => item.purpose).sort()).toEqual(['agent', 'agent', 'agent', 'classify', 'classify']);
  });

  // Breaks: with a reasoning model (gpt-6-luna) that spends the whole budget thinking,
  // every batch comes back empty and every email is left "unsure".
  it('gives a classification that ran out of budget a second, larger budget', async () => {
    await mail('primary', 'a', { subject: 'Invoice' });
    let attempt = 0;
    harness.ai = (prompt, purpose) => {
      if (purpose !== 'classify') return NO_FACTS;
      if (++attempt === 1) return { content: '', finish: 'length' };
      return JSON.stringify({ results: [{ id: /"id":"(S\d+)"/.exec(prompt)![1], label: 'business', reason: 'invoice' }] });
    };
    script(
      call('search_mail', {}),
      call('classify_messages', { ids: ['S1'], question: 'Business?', labels: ['business', 'other'] }),
      turn => {
        expect(lastToolResult(turn)).toContain('S1: business (invoice)');
        return answer([]);
      },
    );
    const exchange = await ask('Which are business?');
    expect(attempt).toBe(2);
    expect(exchange.usage?.calls.filter(item => item.purpose === 'classify')).toHaveLength(1);
  });

  // Breaks: a typo'd id or label set makes the classifier spend calls on nothing.
  it('refuses a classification it cannot run', async () => {
    await mail('primary', 'a');
    script(
      call('search_mail', {}),
      call('classify_messages', { ids: ['S1'], question: 'Business?', labels: ['Business Mail', 'other'] }),
      call('classify_messages', { ids: ['S7'], question: 'Business?', labels: ['yes', 'no'] }),
      call('classify_messages', { ids: [], question: 'Business?', labels: ['yes', 'no'] }),
      answer([]),
    );
    await ask('Sort');
    const [, labels, unknown, empty] = harness.agentTurns.slice(1).map(lastToolResult);
    expect(labels).toContain('"labels" must be 2 to 6 short snake_case labels.');
    expect(unknown).toContain('Not email ids from this conversation\'s results: S7');
    expect(empty).toContain('"ids" must list email ids');
    expect(harness.calls.filter(item => item.purpose === 'classify')).toHaveLength(0);
  });

  // Breaks: the tuned search for "what did X quote" is lost to the agent, or its excerpts cannot be cited.
  it('runs the tuned deep search and lets its excerpts be cited', async () => {
    await mail('primary', 'tcs', { subject: 'Quotation for TCS', cleanBody: 'Quotation for TCS: total INR 4,50,000 including GST.', rawBody: '<p>Quotation for TCS: total INR 4,50,000 including GST.</p>' });
    harness.ai = (_prompt, purpose) => purpose === 'plan' ? { status: 400 } : NO_FACTS;
    script(
      call('deep_search', { question: 'What quotation did we send TCS?' }),
      turn => {
        expect(lastToolResult(turn)).toContain('Quotation for TCS: total INR 4,50,000 including GST.');
        return answer([fact('The TCS quotation totals INR 4,50,000 including GST.', ['S1'], [['S1', 'Quotation for TCS: total INR 4,50,000 including GST.']])]);
      },
    );
    const exchange = await ask('What quote did we send TCS?');
    expect(exchange.answer.sourceStatus).toBe('verified');
    expect(exchange.answer.sources[0]).toMatchObject({ emailId: 'tcs' });
    expect(exchange.usage?.calls.some(item => item.purpose === 'plan')).toBe(true);
  });
});

describe('budgets', () => {
  // Breaks: answers show bare ids ("Not business: S2 and S9", seen live) instead of
  // naming the emails, and a list of emails is rejected for citing too many at once.
  it('tells the model to name emails and cite each one in its own fact', async () => {
    script(answer([]));
    await ask('Which are business?');
    const system = harness.agentTurns[0]!.messages[0]!.content ?? '';
    expect(system).toContain('refer to an email by its sender and subject, never as "S3"');
    expect(system).toContain('For a list of emails, give one fact per email');
  });

  // Breaks: a model that never stops searching runs forever and bills the user for it.
  it('ends at the step limit, offering only the answer tool on the last turn', async () => {
    script(call('count_mail', {}));
    const exchange = await ask('Loop forever');
    expect(harness.agentTurns).toHaveLength(INBOX_AGENT_BUDGET.steps);
    expect(harness.agentTurns.at(-1)!.tools).toEqual(['answer']);
    expect(harness.agentTurns.at(-1)!.messages.at(-1)!.content).toContain('This is your last turn');
    expect(exchange.diagnostics?.agent?.stop).toBe('step_limit');
    expect(exchange.answer.warnings).toContain('The agent ran out of steps before it could finish. Ask a narrower question.');
  });

  // Breaks: one turn with dozens of calls slips past every per-run budget.
  it('limits calls per turn and per run', async () => {
    const many = (count: number): AgentReply => ({ tools: Array.from({ length: count }, () => ({ name: 'count_mail', arguments: {} })) });
    script(many(10), many(8), many(8), many(8), many(8), many(8), answer([]));
    const exchange = await ask('Count a lot');
    const turn2 = harness.agentTurns[1]!.messages.filter(message => message.role === 'tool');
    expect(turn2.slice(8).every(message => (message.content ?? '').includes(`at most ${INBOX_AGENT_BUDGET.callsPerTurn} tool calls per turn`))).toBe(true);
    expect(exchange.diagnostics?.agent?.toolErrors.budget).toBe(8 + 8 * 5 - INBOX_AGENT_BUDGET.toolCalls);
  });

  // Breaks: a long investigation grows the request past what any provider accepts.
  it('shortens the oldest tool results once the conversation is too long', () => {
    const big = 'x'.repeat(200_000);
    const messages = [
      { role: 'system' as const, content: 'system' },
      { role: 'user' as const, content: 'question' },
      { role: 'tool' as const, toolCallId: 'a', name: 'search_mail', content: `Result T1 (search_mail):\n${big}` },
      { role: 'user' as const, content: `Result T2 (count_mail):\n${big}` },
      { role: 'tool' as const, toolCallId: 'c', name: 'search_mail', content: `Result T3 (search_mail):\n${big}` },
    ];
    compactInboxAgentMessages(messages);
    expect(messages[2]!.content).toMatch(/^Result T1 \(search_mail\):\n\[Shortened/);
    expect(messages[3]!.content).toMatch(/^Result T2 \(count_mail\):\n\[Shortened/);
    expect(messages[4]!.content).toBe(`Result T3 (search_mail):\n${big}`);
    expect(messages[1]!.content).toBe('question');
  });
});

describe('models without tool calling', () => {
  // Breaks: gpt-6-luna (OpenAI) accepts tools on Chat Completions only with reasoning
  // off, so every question pays for a refused request and falls back to the slower
  // JSON protocol, or fails outright.
  it('turns reasoning off when tools are refused with it on, and remembers it', async () => {
    await mail('primary', 'a');
    let refused = 0;
    harness.agent = turn => {
      if (turn.reasoningEffort !== 'none') { refused++; return { status: 400, body: '{"error":{"message":"Function tools with reasoning_effort are not supported"}}' }; }
      return turn.call % 2 === 0 ? call('count_mail', {}) : answer([fact('There is 1 email.', ['T1'], [['T1', 'Total: 1']])]);
    };
    const exchange = await ask('How many emails?');
    expect(refused).toBe(1);
    expect(exchange.answer.text).toBe('There is 1 email.');
    expect(exchange.diagnostics?.agent).toMatchObject({ mode: 'native', reasoning: 'off', toolCalls: { count_mail: 1 } });
    expect(exchange.diagnostics?.agent?.fallback).toBeUndefined();
    expect(harness.agentTurns[1]!.tools).toContain('count_mail');

    harness.agentTurns.length = 0;
    harness.agent = turn => turn.reasoningEffort === 'none' ? answer([], 'Fine.') : { status: 400 };
    await ask('Again?');
    expect(harness.agentTurns).toHaveLength(1);
  });

  // Breaks: a local model that refuses tool definitions gets an error instead of an answer,
  // and every later question pays for the refused first requests again.
  it('switches to the JSON protocol when tools are refused either way, and remembers it', async () => {
    await mail('primary', 'a');
    let refused = 0;
    harness.agent = turn => {
      if (turn.tools.length) { refused++; return { status: 400, body: '{"error":{"message":"tools are not supported"}}' }; }
      const last = turn.messages.at(-1)!.content ?? '';
      if (last.startsWith('User request')) return { text: '{"tool":"count_mail","arguments":{}}' };
      return { text: JSON.stringify({ tool: 'answer', arguments: { facts: [fact('There is 1 email.', ['T1'], [['T1', 'Total: 1']])] } }) };
    };
    const exchange = await ask('How many emails?');
    expect(refused).toBe(2);
    expect(harness.agentTurns[1]!.reasoningEffort).toBe('none');
    expect(exchange.answer.text).toBe('There is 1 email.');
    expect(exchange.diagnostics?.agent).toMatchObject({ mode: 'json', fallback: 'tools_refused', toolCalls: { count_mail: 1 } });
    expect(exchange.diagnostics?.agent?.reasoning).toBeUndefined();
    expect(harness.agentTurns[2]!.messages[0]!.content).toContain('Reply with exactly ONE JSON object per turn');

    await ask('How many emails?');
    expect(refused).toBe(2);
  });

  // Breaks: a real failure after tools worked is hidden by a pointless protocol switch.
  it('fails the run on a refusal after tools already worked', async () => {
    script(call('count_mail', {}), { status: 400 });
    await expect(ask('How many?')).rejects.toBeDefined();
    const run = harness.chat().runs?.at(-1);
    expect(run?.diagnostics).toMatchObject({ route: 'agent', outcome: 'failed', failure: { stage: 'agent', error: { status: 400 } } });
  });

  // Breaks: a bad key is retried as if tools were the problem.
  it('does not treat an authentication failure as a tool refusal', async () => {
    script({ status: 401 });
    await expect(ask('How many?')).rejects.toBeDefined();
    expect(harness.agentTurns).toHaveLength(1);
  });

  // Breaks: in the JSON protocol, prose or a broken tool call stalls the run.
  it('nudges a JSON-protocol model that replies in prose', async () => {
    harness.agent = turn => turn.tools.length ? { status: 422 }
      : turn.call === 3 ? { text: 'Let me think.' }
      : { text: '{"tool":"answer","arguments":{"message":"No idea."}}' };
    const exchange = await ask('Anything?');
    expect(harness.agentTurns[3]!.messages.at(-1)!.content).toContain('Reply with exactly one JSON object');
    expect(exchange.answer.text).toBe('No idea.');
  });
});

describe('turns that go wrong', () => {
  // Breaks: a follow-up loses what the chat was about, so "and from Acme?" searches nothing.
  // (The first question searches: a reply that read no mail sets no topic for a follow-up.)
  it('passes earlier turns of the chat as context, not evidence', async () => {
    await mail('primary', 'acme', { fromAddress: 'sales@acme.example' });
    script(call('search_mail', { from: 'acme' }), answer([], 'First.'));
    harness.newChat();
    const first = await harness.ask('What did Acme send?');
    script(answer([], 'Second.'));
    await harness.ask('And last week?', { previousExchangeId: first.id });
    expect(harness.agentTurns.at(-1)!.messages[1]!.content).toMatch(/^Earlier in this chat \(context only, not evidence\): .*What did Acme send\?/s);
  });

  // Breaks: a malformed call crashes the run instead of being shown to the model to correct.
  it('shows malformed calls back to the model', async () => {
    script(
      { tools: [{ name: 'count_mail', arguments: '' }, { name: 'count_mail', arguments: '[1]' }] },
      { tools: [{ name: 'answer', arguments: 'not json' }] },
      { tools: [{ name: 'answer', arguments: { message: 'One.' } }, { name: 'answer', arguments: { message: 'Two.' } }] },
    );
    const exchange = await ask('Count');
    const firstTurn = harness.agentTurns[1]!.messages.filter(message => message.role === 'tool').map(message => message.content);
    expect(firstTurn[0]).toContain('Result T1 (count_mail)');
    expect(firstTurn[1]).toBe('Error: The arguments must be a JSON object.');
    expect(lastToolResult(harness.agentTurns[2]!)).toContain('Answer not accepted: call "answer" with');
    expect(exchange.answer.text).toBe('One.');
    expect(exchange.diagnostics?.answer?.repair?.reason).toBe('malformed');
  });

  // Breaks: a second answer that is worse replaces a first one that had verified facts.
  it('keeps the first answer when the correction drops everything', async () => {
    await mail('primary', 'a', { cleanBody: 'Total INR 900.' });
    script(
      call('read_message', { id: 'S1' }),
      call('search_mail', {}),
      answer([fact('Total INR 900.', ['S1'], [['S1', 'Total INR 900.']]), fact('Due Friday.', ['S1'], [['S1', 'Due Friday']])]),
      answer([]),
    );
    const exchange = await ask('What is due?');
    expect(exchange.answer.text).toBe('Total INR 900. [S1]');
    expect(exchange.answer.warnings).toContain('Some AI statements were omitted because their source references or excerpts could not be verified.');
  });

  // Breaks: a crashing tool ends the whole question instead of letting the model try another way.
  it('reports a failing tool by class only and carries on', async () => {
    const open = harness.deps.openMailbox;
    harness.deps.openMailbox = async accountId => {
      const mailbox = await open(accountId);
      return { ...mailbox, storage: Object.assign(Object.create(Object.getPrototypeOf(mailbox.storage)), mailbox.storage, {
        searchEmails: async () => { throw new TypeError('disk said: secret path /Users/x'); },
      }) };
    };
    script(call('search_mail', {}), answer([], 'Search failed.'));
    const exchange = await ask('Find');
    expect(lastToolResult(harness.agentTurns[1]!)).toBe('Error: the tool failed. Try a different approach or answer with what you have.');
    expect(exchange.diagnostics?.agent?.toolErrors).toEqual({ 'search_mail:TypeError': 1 });
    expect(JSON.stringify(exchange.diagnostics)).not.toContain('secret');
  });

  // Breaks: an empty reply, twice, hangs or shows an empty bubble.
  it('handles empty replies', async () => {
    script({ text: '' }, { text: '' });
    const exchange = await ask('Hi');
    expect(harness.agentTurns[1]!.messages.at(-2)!.content).toBe('(empty reply)');
    expect(exchange.answer.text).toMatch(/^I could not find supporting mail/);
  });

  // Breaks: in the JSON protocol, a broken call or a rejected answer stalls the run.
  it('corrects JSON-protocol calls and answers', async () => {
    harness.agent = turn => {
      if (turn.tools.length) return { status: 404 };
      switch (turn.call) {
        case 3: return { text: '{"tool":""}' };
        case 4: return { text: '{"tool":"count_mail","arguments":[1]}' };
        case 5: return { text: '{"tool":"answer","arguments":{"message":"There are 99."}}' };
        default: return { text: '{"tool":"answer","arguments":{"message":"Done."}}' };
      }
    };
    const exchange = await ask('Count');
    expect(harness.agentTurns[3]!.messages.at(-1)!.content).toContain('Reply with exactly one JSON object');
    expect(harness.agentTurns[4]!.messages.at(-1)!.content).toContain('Unknown argument "__invalid"');
    expect(harness.agentTurns[5]!.messages.at(-1)!.content).toContain('message: contains a number that is not in any result');
    expect(exchange.answer.text).toBe('Done.');
  });
});

describe('a run the user stops', () => {
  // Breaks: Stop leaves the loop calling the provider in the background.
  it('makes no further model call after Stop', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requestId = '';
    harness.agent = async turn => {
      if (turn.call === 1) return call('count_mail', {});
      await held;
      return call('count_mail', {});
    };
    harness.newChat();
    const asking = harness.ask('Count', { requestId: 'stop-me' });
    requestId = 'stop-me';
    await vi.waitFor(() => expect(harness.agentTurns).toHaveLength(2));
    const stopping = harness.service.cancel(requestId);
    release();
    await expect(asking).rejects.toBeDefined();
    await stopping;
    expect(harness.agentTurns).toHaveLength(2);
    expect(harness.chat().runs?.at(-1)?.diagnostics?.outcome).toBe('stopped');
  });
});

describe('diagnostics', () => {
  // Breaks: app.log gains the question or mail text (it is plaintext on disk), or loses the agent's shape.
  it('logs the agent run without content', async () => {
    await mail('primary', 'secret', { subject: 'Confidential merger', cleanBody: 'merger terms' });
    script(call('search_mail', { text: 'Confidential merger' }), call('nonexistent', {}), answer([]));
    const exchange = await ask('What about the Confidential merger?');
    const line = inboxAssistantRunSummary('r1', 'completed', exchange.diagnostics!);
    expect(line).toContain('route=agent');
    expect(line).toContain('agent=native steps=3 tools=nonexistent:1,search_mail:1 tool_errors=unknown_tool:1 stop=answered');
    expect(line).not.toMatch(/merger|Confidential/i);
    expect(harness.logs.join('\n')).not.toMatch(/merger|Confidential/i);
  });
});
