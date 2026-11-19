import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOX_AGENT_LIMITS, INBOX_AGENT_TOOLS, InboxAgentRegistry, InboxAgentToolError, type InboxAgentToolContext } from '../../../../electron/services/inbox-assistant-agent-tools';
import type { AssistantResearchMailbox } from '../../../../electron/services/inbox-assistant-retrieval';
import type { InboxAssistantEvidence } from '../../../../src/types/inbox-assistant';
import { createAssistantHarness, type AssistantHarness } from '../../../helpers/assistant-harness';

// Each Inbox Agent tool on its own, over REAL account databases. These are the
// edges the loop tests do not reach: refused arguments (a refused argument must
// never widen a search), mail that moved or vanished between two calls, a
// mailbox that cannot be opened, documents that cannot be read, and the per-run
// allowances. A regression shows up as a search over the wrong mail, an id that
// points nowhere, or an allowance that never runs out.

const T0 = 1_780_000_000;
let harness: AssistantHarness;

beforeEach(async () => { harness = await createAssistantHarness(); });
afterEach(async () => { await harness.close(); });

function tool(name: string) {
  return INBOX_AGENT_TOOLS.find(item => item.definition.name === name)!;
}

function context(over: Partial<InboxAgentToolContext> = {}): InboxAgentToolContext {
  return {
    accounts: harness.accounts, question: '', deps: harness.deps, signal: new AbortController().signal, timeZone: 'Asia/Kolkata',
    registry: new InboxAgentRegistry(), coverage: new Map(), progress: vi.fn(),
    classify: vi.fn(async () => '{"results":[]}'), deepSearch: vi.fn(async () => ({ evidence: [], coverage: [] })),
    remaining: { attachments: 8, classified: 400, deepSearches: 3 }, mailboxes: new Map(), ...over,
  };
}

async function mail(id: string, over: Partial<EmailRecord> = {}, accountId = 'primary'): Promise<void> {
  await harness.mail(accountId, over.threadId ?? `t-${id}`, { id, subject: `Subject ${id}`, cleanBody: `${id} body`, rawBody: `<p>${id} body</p>`, ...over });
}

/** Search, so the registry knows the email, and return its id. */
async function seen(ctx: InboxAgentToolContext, args: Record<string, unknown> = {}): Promise<string> {
  const output = await tool('search_mail').run(args, ctx);
  return /^(S\d+) \|/m.exec(output)![1]!;
}

/** Open mailboxes through the harness, with some storage methods replaced. */
function patched(patch: (accountId: string, storage: AssistantResearchMailbox['storage']) => Partial<AssistantResearchMailbox['storage']>, extra: Partial<AssistantResearchMailbox> = {}) {
  return { ...harness.deps, openMailbox: async (accountId: string) => {
    const mailbox = await harness.deps.openMailbox(accountId);
    const storage = Object.assign(Object.create(Object.getPrototypeOf(mailbox.storage)), mailbox.storage, patch(accountId, mailbox.storage));
    return { ...mailbox, ...extra, storage } as AssistantResearchMailbox;
  } };
}

function evidence(over: Partial<InboxAssistantEvidence> = {}): InboxAssistantEvidence {
  return { id: 'S1', kind: 'message', accountId: 'primary', accountEmail: 'rc@sarv.example', emailId: 'x', subject: 's', from: 'a@b', to: [],
    date: T0, folder: 'INBOX', sent: false, excerpt: '', text: 'text', ...over };
}

describe('the registry of what the model saw', () => {
  // Breaks: a run that sees thousands of emails creates ids the answer format cannot cite.
  it('stops issuing ids at the maximum and keeps every id stable', () => {
    const registry = new InboxAgentRegistry();
    for (let index = 0; index < INBOX_AGENT_LIMITS.sources; index++) registry.source(`k${index}`, () => evidence());
    expect(registry.source('one-more', () => evidence())).toBeUndefined();
    expect(registry.source('k0', () => evidence())).toBe('S1');
    registry.update('S99999', { text: 'ignored' });
    expect(registry.get('S99999')).toBeUndefined();
    // An id never shown has no text, so nothing can be quoted from it.
    expect(registry.evidence()[0]!.text).toBe('');
    expect(registry.context().has('S1')).toBe(false);
  });
});

describe('arguments', () => {
  // Breaks: a wrong-typed filter is ignored and the search widens to all mail.
  it.each([
    [{ text: 42 }, '"text" must be a string.'],
    [{ from: 'x'.repeat(201) }, '"from" is longer than 200 characters.'],
    [{ unread: 'yes' }, '"unread" must be true or false.'],
  ])('refuses %j', async (args, message) => {
    await expect(tool('search_mail').run(args, context())).rejects.toThrow(message);
  });

  // Breaks: a blank filter becomes a filter for blank text and matches nothing.
  it('reads a blank or null filter as absent', async () => {
    await mail('a');
    expect(await tool('count_mail').run({ text: '   ', from: null }, context())).toContain('Total: 1');
  });

  // Breaks: a missing id is read as "the first email".
  it('requires an id from earlier results', async () => {
    await expect(tool('read_message').run({}, context())).rejects.toThrow('"id" is required');
    await expect(tool('read_thread').run({ id: 'S1' }, context())).rejects.toBeInstanceOf(InboxAgentToolError);
  });
});

describe('search rows', () => {
  // Breaks: the model cannot tell read from unread or see attachments, so it judges mail wrongly.
  it('shows each email\'s state, sender, folder and preview', async () => {
    await mail('full', { tags: '|INBOX|read|starred|important|', fromName: 'Asha Rao', fromAddress: 'asha@acme.example', attachmentCount: 2, cleanBody: 'Hello   there' });
    await mail('bare', { subject: '', fromName: null, attachmentCount: 1, cleanBody: '', folderId: 'f-sent', tags: '|INBOX|' });
    // The bare email's folder is not in the folder list, as after a folder was deleted.
    const ctx = context({ deps: patched((_id, storage) => ({ getFolders: async () => (await storage.getFolders()).filter(folder => folder.id !== 'f-sent') })) });
    const output = await tool('search_mail').run({ sort: 'oldest' }, ctx);
    expect(output).toContain('From: Asha Rao <asha@acme.example>');
    expect(output).toContain('read, starred, important, 2 attachments');
    expect(output).toContain('Preview: Hello there');
    expect(output).toContain('Subject: (No subject)');
    expect(output).toContain('Folder: unknown');
    expect(output).toContain('unread, 1 attachment');
  });

  // Breaks: recipient, subject, star, attachment and date filters stop narrowing the search.
  it('applies every filter', async () => {
    await mail('match', { toAddress: 'ops@acme.example', subject: 'Invoice 7', tags: '|INBOX|starred|', attachmentCount: 1, hasAttachments: true, date: T0 });
    await mail('other', { date: T0 });
    const ctx = context();
    const count = (args: Record<string, unknown>) => tool('count_mail').run(args, ctx);
    expect(await count({ to: 'ops@acme' })).toContain('Total: 1');
    expect(await count({ subject: 'Invoice' })).toContain('Total: 1');
    expect(await count({ starred: true })).toContain('Total: 1');
    expect(await count({ has_attachment: true })).toContain('Total: 1');
    expect(await count({ before: '2026-05-29' })).toContain('Total: 0');
    expect(await count({ before: '2026-05-30', after: '2026-05-29' })).toContain('Total: 2');
    expect(await count({ folder: 'inbox' })).toContain('Total: 2');
    expect(await count({ folder: 'Sent' })).toContain('Total: 0');
    expect(await count({ folder: 'drafts' })).toContain('Total: 0');
  });

  // Breaks: paging past the end reads as "no mail exists".
  it('says when a page is past the end, and when nothing matched', async () => {
    await mail('a');
    expect(await tool('search_mail').run({ offset: 5 }, context())).toContain('Total matching: 1. No rows at this offset.');
    expect(await tool('search_mail').run({ text: 'zzzz' }, context())).toBe('Total matching: 0.');
  });

  // Breaks: every answer built on a paged list says "the search reached its local result
  // limit" (seen live), so the user distrusts a complete answer; or a list that really
  // runs past the window is presented as complete.
  it('treats a total larger than the page as paging, and only the window cap as a limit', async () => {
    await mail('a');
    await mail('b');
    const paged = context();
    await tool('search_mail').run({ limit: 1 }, paged);
    expect(paged.coverage.get('primary')?.truncated).toBe(false);
    const capped = context({ deps: patched(() => ({ searchEmailsCount: async () => 1_000 })) });
    await tool('search_mail').run({ offset: INBOX_AGENT_LIMITS.searchWindow - 1, limit: 2 }, capped);
    expect(capped.coverage.get('primary')?.truncated).toBe(true);
  });

  // Breaks: relevance ranking from one account is lost when two accounts are merged.
  it('interleaves the best matches of each account by rank', async () => {
    await mail('p1', { subject: 'budget budget budget', date: T0 - 10 });
    await mail('s1', { subject: 'budget budget budget', date: T0 }, 'secondary');
    const output = await tool('search_mail').run({ text: 'budget' }, context());
    expect(output).toContain('Total matching: 2');
    expect(output.indexOf('account sales@sarv.example')).toBeLessThan(output.indexOf('account rc@sarv.example'));
  });

  // Breaks: a storage without a count reports a wrong total.
  it('counts by listing when the storage has no counter', async () => {
    await mail('a');
    const ctx = context({ deps: patched(() => ({ searchEmailsCount: undefined })) });
    expect(await tool('count_mail').run({}, ctx)).toContain('Total: 1');
  });

  // Breaks: once the run holds the maximum ids, new rows crash instead of being left out.
  it('leaves out rows once the run holds the maximum ids', async () => {
    await mail('a');
    const ctx = context();
    for (let index = 0; index < INBOX_AGENT_LIMITS.sources; index++) ctx.registry.source(`k${index}`, () => evidence());
    expect(await tool('search_mail').run({}, ctx)).toBe('Total matching: 1. No rows at this offset.');
  });
});

describe('accounts, folders and categories', () => {
  // Breaks: the model cannot tell the user's accounts apart.
  it('lists accounts with their names', async () => {
    const ctx = context({ accounts: [{ id: 'primary', email: 'rc@sarv.example', name: 'Ramesh' }] });
    expect(await tool('list_accounts').run({}, ctx)).toBe('rc@sarv.example (Ramesh)');
    await expect(tool('list_accounts').run({ extra: 1 }, ctx)).rejects.toThrow('Unknown argument "extra"');
  });

  // Breaks: one locked account hides every other account's folders.
  it('lists folders, and says which account could not be opened', async () => {
    const ctx = context({ deps: { ...harness.deps, openMailbox: async id => { if (id === 'secondary') throw new Error('locked'); return harness.deps.openMailbox(id); } } });
    const output = await tool('list_folders').run({}, ctx);
    expect(output).toContain('Trash (trash): 0 messages');
    expect(output).toContain('sales@sarv.example: could not be opened.');
    expect(ctx.coverage.get('secondary')?.status).toBe('unavailable');
  });

  // Breaks: a mailbox whose category table cannot be read fails the whole question.
  it('lists no categories when they cannot be read', async () => {
    const ctx = context({ deps: patched(id => ({ getCategoryDefinitions: id === 'primary' ? () => { throw new Error('broken'); } : () => [{ slug: 'promo' }] })) });
    expect(await tool('list_categories').run({}, ctx)).toBe('rc@sarv.example: no categories\nsales@sarv.example: promo');
    // With no readable list, a category is searched for as given rather than refused.
    expect(await tool('count_mail').run({ category: 'anything', account: 'rc@sarv.example' }, ctx)).toContain('Total: 0');
  });
});

describe('reading an email', () => {
  // Breaks: an email deleted or moved since it was listed is read as empty instead of reported.
  it('reports an email that is gone, an account no longer selected, or one that cannot be opened', async () => {
    await mail('a');
    const ctx = context();
    const id = await seen(ctx);
    harness.mailbox('primary').run("DELETE FROM emails WHERE id = 'a'");
    await expect(tool('read_message').run({ id }, ctx)).rejects.toThrow(`${id} is no longer in the mailbox.`);
    await expect(tool('read_message').run({ id }, { ...ctx, accounts: [harness.accounts[1]!] })).rejects.toThrow('not selected');
    const broken = context({ registry: ctx.registry, deps: { ...harness.deps, openMailbox: async () => { throw new Error('locked'); } } });
    await expect(tool('read_message').run({ id }, broken)).rejects.toThrow('rc@sarv.example could not be opened.');
  });

  // Breaks: a long email is cut silently and the model believes it saw all of it.
  it('says when a long body was shortened, and lists attachments', async () => {
    await mail('long', { cleanBody: `start ${'word '.repeat(4_000)} end`, attachmentNames: JSON.stringify(['a.pdf']), attachmentCount: 1 });
    const ctx = context();
    const output = await tool('read_message').run({ id: await seen(ctx) }, ctx);
    expect(output).toContain('(Long body: only the beginning, the end and marked excerpts are shown.)');
    expect(output).toContain('Attachments: a.pdf');
    expect(ctx.coverage.get('primary')).toMatchObject({ reviewedMessages: 1, missingBodies: 0 });
  });

  // Breaks: a download into an unknown folder is attempted, or a downloaded-but-empty body is called complete.
  it.each([
    ['the folder is unknown', true, null, 'Content status: original unavailable'],
    ['the server had no body', false, { hasBody: false }, 'Content status: original unavailable'],
  ])('handles a body that cannot be downloaded because %s', async (_case, folderGone, downloaded, expected) => {
    await mail('bare', { rawBody: '', cleanBody: 'preview', hasBody: false });
    const fetchBody = vi.fn(async (email: EmailRecord) => downloaded ? { ...email, ...downloaded } : null);
    const ctx = context({ deps: patched((_id, storage) => folderGone ? { getFolders: async () => (await storage.getFolders()).filter(folder => folder.id !== 'f-inbox') } : {}, { fetchBody }) });
    const output = await tool('read_message').run({ id: await seen(ctx) }, ctx);
    expect(output).toContain(expected);
    expect(fetchBody).toHaveBeenCalledTimes(folderGone ? 0 : 1);
  });

  // Breaks: the stored copy refreshed by the download is ignored in favour of a stale one.
  it('prefers the refreshed stored copy after a download', async () => {
    await mail('bare', { rawBody: '', cleanBody: '', hasBody: false });
    let downloaded = false;
    const fetchBody = vi.fn(async () => { downloaded = true; return null; });
    const ctx = context({ deps: patched((_id, storage) => ({ getEmail: async (id: string) => {
      const email = await storage.getEmail(id);
      return email && downloaded ? { ...email, cleanBody: 'Stored after download.', rawBody: '<p>Stored after download.</p>' } : email;
    } }), { fetchBody }) });
    expect(await tool('read_message').run({ id: await seen(ctx) }, ctx)).toContain('Stored after download.');
  });

  // Breaks: an attachment id is "read" as a message and shows the wrong text.
  it('refuses to read an attachment id as a message', async () => {
    const ctx = context();
    ctx.registry.source('doc', () => evidence({ kind: 'attachment' }));
    await expect(tool('read_message').run({ id: 'S1' }, ctx)).rejects.toThrow('is an attachment');
  });
});

describe('conversations', () => {
  // Breaks: a storage without thread lookup crashes the tool.
  it('says an email is alone when its conversation cannot be listed', async () => {
    await mail('a');
    const ctx = context({ deps: patched(() => ({ getEmailsByThread: undefined })) });
    const id = await seen(ctx);
    expect(await tool('read_thread').run({ id }, ctx)).toBe(`${id} is the only email available in its conversation.`);
  });

  // Breaks: a huge conversation floods the context.
  it('shows only the latest emails of a long conversation', async () => {
    for (let index = 0; index < INBOX_AGENT_LIMITS.threadRows + 2; index++) await mail(`m${index}`, { threadId: 'big', date: T0 + index });
    const ctx = context();
    const output = await tool('read_thread').run({ id: await seen(ctx, { limit: 1 }) }, ctx);
    expect(output).toContain(`42 emails, showing the latest ${INBOX_AGENT_LIMITS.threadRows}.`);
    expect(output).not.toContain('Subject: Subject m0 ');
  });

  // Breaks: a one-email conversation is described as plural.
  it('describes a one-email conversation', async () => {
    await mail('solo');
    const ctx = context();
    expect(await tool('read_thread').run({ id: await seen(ctx) }, ctx)).toContain('1 email.');
  });
});

describe('reading attachments', () => {
  const ready = (over: Record<string, unknown> = {}) => vi.fn(async (ref: { accountId: string; emailId: string; filename: string }, options: { onProgress?: (activity: never) => void }) => {
    options.onProgress?.({ stage: 'attachment', status: 'running', message: 'Scanning' } as never);
    return { ref, status: 'ready' as const, segments: [{ text: 'Page text', locator: { label: 'Page 1' } }], truncated: false, ...over };
  });

  async function withAttachments(reader: unknown, names = ['offer.pdf', 'logo.png']) {
    await mail('doc', { attachmentNames: JSON.stringify(names), attachmentCount: names.length });
    const ctx = context({ deps: { ...harness.deps, readAttachment: reader as never } });
    return { ctx, id: await seen(ctx) };
  }

  // Breaks: a missing filename or an image is sent to the document reader.
  it('refuses a missing filename and a file type it cannot read', async () => {
    const reader = ready();
    const { ctx, id } = await withAttachments(reader);
    await expect(tool('read_attachment').run({ id }, ctx)).rejects.toThrow('"filename" is required.');
    await expect(tool('read_attachment').run({ id, filename: 'logo.png' }, ctx)).rejects.toThrow('not a readable document type');
    expect(reader).not.toHaveBeenCalled();
  });

  // Breaks: the per-question allowance never runs out, so one question reads every document in the mailbox.
  it('stops at the attachment allowance', async () => {
    const reader = ready();
    const { ctx, id } = await withAttachments(reader);
    ctx.remaining.attachments = 0;
    await expect(tool('read_attachment').run({ id, filename: 'offer.pdf' }, ctx)).rejects.toThrow('allowance for this question is used up');
    expect(ctx.coverage.get('primary')).toMatchObject({ attachmentsSkipped: 1, truncated: true });
  });

  // Breaks: an unreadable or blocked document is answered from as if it were empty.
  it.each([
    ['blocked with a reason', { status: 'blocked', segments: [], message: 'Blocked by the scanner' }, 'offer.pdf could not be read: Blocked by the scanner.'],
    ['unsupported without a reason', { status: 'unsupported_type', segments: [] }, 'offer.pdf could not be read: unsupported type.'],
    ['ready but empty', { segments: [] }, 'offer.pdf could not be read: ready.'],
  ])('reports a document that was %s', async (_case, over, expected) => {
    const { ctx, id } = await withAttachments(ready(over));
    expect(await tool('read_attachment').run({ id, filename: 'offer.pdf' }, ctx)).toBe(expected);
    expect(ctx.coverage.get('primary')?.attachmentsSkipped).toBe(1);
  });

  // Breaks: a document past the reading limit is presented as complete, or the scan's progress is lost.
  it('marks a truncated document and forwards the reader\'s progress', async () => {
    const { ctx, id } = await withAttachments(ready({ truncated: true }));
    const output = await tool('read_attachment').run({ id, filename: 'offer.pdf' }, ctx);
    expect(output).toContain('[Page 1]\nPage text');
    expect(ctx.coverage.get('primary')).toMatchObject({ attachmentsRead: 1, truncated: true });
    expect(ctx.progress).toHaveBeenCalledWith(expect.objectContaining({ message: 'Scanning' }));
  });

  // Breaks: a document read after the id limit has no id, and its text cannot be cited.
  it('refuses a document once the run holds the maximum ids', async () => {
    const { ctx, id } = await withAttachments(ready());
    for (let index = 0; ctx.registry.source(`k${index}`, () => evidence()); index++) { /* fill */ }
    await expect(tool('read_attachment').run({ id, filename: 'offer.pdf' }, ctx)).rejects.toThrow('as many sources as it can');
  });
});

describe('deep search', () => {
  const item = (over: Partial<InboxAssistantEvidence>) => evidence({ id: 'S1', text: 'Quote total INR 100', ...over });

  // Breaks: an empty question or an exhausted allowance still starts an expensive search.
  it('refuses an empty question and an exhausted allowance', async () => {
    const ctx = context();
    await expect(tool('deep_search').run({}, ctx)).rejects.toThrow('"question" is required.');
    ctx.remaining.deepSearches = 0;
    await expect(tool('deep_search').run({ question: 'q' }, ctx)).rejects.toThrow('deep search allowance');
    expect(ctx.deepSearch).not.toHaveBeenCalled();
  });

  // Breaks: what the tuned search covered (or could not open) is lost from the answer's coverage.
  it('merges coverage, ids for documents, and what did not fit', async () => {
    const ctx = context({ deepSearch: vi.fn(async () => ({
      evidence: [
        item({ emailId: 'm1' }),
        item({ id: 'S2', kind: 'attachment', emailId: 'm1', filename: 'q.pdf', location: 'Page 2' }),
        ...[2, 3, 4].map(index => item({ id: `S${index + 1}`, emailId: `m${index}`, text: 'x'.repeat(30_000) })),
      ],
      coverage: [
        { accountId: 'primary', email: 'rc@sarv.example', status: 'searched' as const, matchedMessages: 4, reviewedMessages: 2, missingBodies: 1, attachmentsRead: 1, attachmentsSkipped: 1, truncated: true, warnings: ['w'] },
        { accountId: 'secondary', email: 'sales@sarv.example', status: 'unavailable' as const, matchedMessages: 0, reviewedMessages: 0, missingBodies: 0, attachmentsRead: 0, attachmentsSkipped: 0, truncated: false, warnings: [] },
        { accountId: 'gone', email: 'gone@x', status: 'searched' as const, matchedMessages: 9, reviewedMessages: 9, missingBodies: 0, attachmentsRead: 0, attachmentsSkipped: 0, truncated: false, warnings: [] },
      ],
    })) });
    const output = await tool('deep_search').run({ question: 'What was quoted?' }, ctx);
    expect(output).toMatch(/^Found 4 excerpts \(of 5; the rest did not fit\):/);
    expect(output).toContain('Source: S2\nKind: attachment');
    expect(ctx.registry.bodiesRead).toEqual(new Set(['S1', 'S3', 'S4']));
    expect(ctx.coverage.get('primary')).toMatchObject({ matchedMessages: 4, reviewedMessages: 2, missingBodies: 1, attachmentsRead: 1, truncated: true, warnings: ['w'] });
    expect(ctx.coverage.get('secondary')?.status).toBe('unavailable');
    expect(ctx.coverage.has('gone')).toBe(false);
  });

  // Breaks: "nothing found" from the tuned search is shown as an empty list the model misreads.
  it('says when nothing was found, and stops at the id limit', async () => {
    expect(await tool('deep_search').run({ question: 'q' }, context())).toBe('No matching mail or documents were found.');
    const ctx = context({ deepSearch: vi.fn(async () => ({ evidence: [item({})], coverage: [] })) });
    for (let index = 0; ctx.registry.source(`k${index}`, () => evidence()); index++) { /* fill */ }
    expect(await tool('deep_search').run({ question: 'q' }, ctx)).toBe('No matching mail or documents were found.');
  });

  // Breaks: one excerpt is described as plural.
  it('describes a single excerpt', async () => {
    const ctx = context({ deepSearch: vi.fn(async () => ({ evidence: [item({})], coverage: [] })) });
    expect(await tool('deep_search').run({ question: 'q' }, ctx)).toMatch(/^Found 1 excerpt:/);
  });
});

describe('sorting emails', () => {
  async function ids(count: number): Promise<{ ctx: InboxAgentToolContext; list: string[] }> {
    for (let index = 0; index < count; index++) await mail(`c${index}`, index === 0 ? { cleanBody: '', rawBody: '' } : {});
    const ctx = context();
    const output = await tool('search_mail').run({ limit: 50 }, ctx);
    return { ctx, list: [...output.matchAll(/^(S\d+) \|/gm)].map(match => match[1]!) };
  }

  // Breaks: the per-call and per-run caps never bite, so one question classifies a whole mailbox.
  it('refuses a missing question, too many ids, and more than the run allows', async () => {
    const { ctx, list } = await ids(2);
    const run = (args: Record<string, unknown>) => tool('classify_messages').run({ ids: list, question: 'Business?', labels: ['yes', 'no'], ...args }, ctx);
    await expect(run({ question: '' })).rejects.toThrow('"question" is required.');
    await expect(run({ ids: Array.from({ length: INBOX_AGENT_LIMITS.classifyPerCall + 1 }, (_, index) => `S${index + 1}`) })).rejects.toThrow(`At most ${INBOX_AGENT_LIMITS.classifyPerCall} ids per call.`);
    await expect(run({ ids: [7] })).rejects.toThrow('Not email ids');
    ctx.remaining.classified = 1;
    await expect(run({})).rejects.toThrow('Only 1 more emails can be sorted');
    expect(ctx.classify).not.toHaveBeenCalled();
  });

  // Breaks: a reply that is not the expected shape labels mail the model never judged.
  it.each([
    ['no results list', '{"answer":1}'],
    ['broken entries', JSON.stringify({ results: [null, 'x', { id: 'S99', label: 'yes' }, { id: 'S1', label: 'maybe' }, { id: 'S2', label: 'yes' }] })],
  ])('leaves emails unsure when the reply has %s', async (_case, reply) => {
    const { ctx, list } = await ids(2);
    ctx.classify = vi.fn(async () => reply);
    const output = await tool('classify_messages').run({ ids: list, question: 'Business?', labels: ['yes', 'no'] }, ctx);
    expect(output).toContain(`${list[0]}: unsure`);
    expect(output).toMatch(/Label counts: yes \d, no 0, unsure \d/);
  });

  // Breaks: an email with no body is sorted on nothing at all.
  it('sorts an email without a body from its preview, and one email reads as singular', async () => {
    const { ctx, list } = await ids(1);
    ctx.classify = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('From: sender@x.com');
      return JSON.stringify({ results: [{ id: list[0], label: 'no' }] });
    });
    const output = await tool('classify_messages').run({ ids: list, question: 'Business?', labels: ['yes', 'no'] }, ctx);
    expect(output).toContain(`${list[0]}: no`);
    expect(ctx.progress).toHaveBeenCalledWith(expect.objectContaining({ message: 'Sorting 1 email' }));
  });

  // Breaks: Stop during sorting is swallowed as a failed batch and the run keeps going.
  it('stops when the run is stopped', async () => {
    const { list } = await ids(1);
    const controller = new AbortController();
    const ctx = context({ signal: controller.signal });
    await tool('search_mail').run({}, ctx);
    ctx.classify = vi.fn(async () => { controller.abort(new Error('Request cancelled.')); throw new Error('aborted'); });
    await expect(tool('classify_messages').run({ ids: list, question: 'q', labels: ['yes', 'no'] }, ctx)).rejects.toThrow('Request cancelled.');
  });
});

// Phase 3 read tools. A regression here is labelled or snoozed mail the agent
// cannot find (so it cannot unsnooze or relabel it), or a contact lookup that
// errors on a store that has no address book.
describe('labels, snoozed mail and contacts', () => {
  const storage = () => harness.mailbox('primary').storage;

  // Breaks: the agent cannot see which labels exist, or how many emails carry one.
  it('lists each account\'s labels with how many emails carry them', async () => {
    await storage().createLabel({ name: 'Clients' });
    await mail('a', { tags: '|INBOX|Clients|' });
    const output = await tool('list_labels').run({}, context());
    expect(output).toBe('rc@sarv.example: Clients (1)\nsales@sarv.example: no labels');
    const failing = context({ deps: patched(() => ({ getLabels: async () => { throw new Error('locked'); } }) as never) });
    expect(await tool('list_labels').run({ account: 'rc@sarv.example' }, failing)).toBe('rc@sarv.example: labels could not be read.');
  });

  // Breaks: "show my Clients mail" cannot be answered, or a misspelt label silently searches everything.
  it('searches by label in the account\'s own spelling, and notes accounts without it', async () => {
    await storage().createLabel({ name: 'Clients' });
    await mail('a', { tags: '|INBOX|Clients|' });
    await mail('b');
    const output = await tool('search_mail').run({ label: 'clients' }, context());
    expect(output).toContain('Subject a');
    expect(output).not.toContain('Subject b');
    expect(output).toContain('sales@sarv.example has no label "clients".');
  });

  // Breaks: snoozed mail is invisible to the agent, so "unsnooze my mail from Ana" cannot work.
  it('lists snoozed mail soonest first with when it comes back, as ids change_mail accepts', async () => {
    await mail('later');
    await mail('sooner');
    await storage().snoozeEmail('later', T0 + 7_200);
    await storage().snoozeEmail('sooner', T0 + 3_600);
    const ctx = context();
    const output = await tool('list_snoozed').run({ account: 'rc@sarv.example' }, ctx);
    expect(output.split('\n')[0]).toBe('rc@sarv.example: 2 snoozed');
    expect(output.indexOf('Subject sooner')).toBeLessThan(output.indexOf('Subject later'));
    expect(output).toMatch(/Snoozed until: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(ctx.registry.get('S1')).toMatchObject({ emailId: 'sooner' });
    expect(await tool('list_snoozed').run({ account: 'sales@sarv.example' }, context())).toBe('sales@sarv.example: nothing snoozed');
  });

  // Breaks: a contact question fails, or the shared address book lists each person once per account.
  it('finds contacts by name, address or organisation, once, from the shared address book', async () => {
    await storage().upsertContact({ email: 'ana@acme.test', name: 'Ana Silva', organization: 'Acme', title: 'Buyer', phone: '+1 555 0100', lastSeen: T0, receivedCount: 4, sentCount: 2 });
    const output = await tool('find_contact').run({ query: 'acme' }, context());
    expect(output).toMatch(/^1 contact matches:\n {2}Ana Silva <ana@acme\.test> \| Acme \| Buyer \| phone \+1 555 0100 \| 4 received, 2 sent \| last \d{4}-\d{2}-\d{2}$/);
    expect(await tool('find_contact').run({ query: 'nobody' }, context())).toBe('No contacts match "nobody".');
    await expect(tool('find_contact').run({}, context())).rejects.toThrow('"query" is required');
    const failing = context({ deps: patched(() => ({ getContacts: async () => { throw new Error('locked'); } }) as never) });
    expect(await tool('find_contact').run({ query: 'acme' }, failing)).toBe('The address book could not be read.');
    const none = context({ deps: patched(() => ({ getContacts: undefined }) as never) });
    expect(await tool('find_contact').run({ query: 'acme' }, none)).toBe('The address book is not available.');
  });
});
