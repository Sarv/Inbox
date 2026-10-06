import { describe, it, expect, vi } from 'vitest';

import type { CategoryDef } from '../../../src/agent/categorization-utils';
import { UnifiedPipeline, type UnifiedPipelineDeps } from '../../../src/agent/unified-pipeline';
import type { EmailRecord } from '../../../src/types/models';

// INTEGRATION test for the "a mail is received → the AI pipeline runs" flow.
//
// It drives the REAL UnifiedPipeline (enrich → categorize → save categories →
// save contact notes → predict action → execute/propose) with a FAKE AI provider
// (deps.callAI) and fake storage seams, so it proves the whole chain connects and
// the outputs land — not just that the prompt/parse helpers work in isolation.
//
// Covers: the happy path (categories + contact notes + a reply proposal all
// produced from one email), spam, a TRANSIENT AI failure (kept pending for
// retry), a PARSE failure (bounded give-up), and batch processing.

const CATEGORY_DEFS: CategoryDef[] = [
  { slug: 'needs_response', name: 'Needs Response', prompt: 'the user owes a reply' },
  { slug: 'important', name: 'Important', prompt: 'urgent / high-signal' },
  { slug: 'invoice', name: 'Invoice & Billing', prompt: 'bills and receipts' },
];

const mkEmail = (over: Partial<EmailRecord> = {}): EmailRecord => ({
  id: 'e1', messageId: '<e1@x>', threadId: 't1', folderId: 'f1', uid: 1,
  tags: '|INBOX|', subject: 'Can you review the proposal?',
  fromAddress: 'alice@partner.com', fromName: 'Alice', toAddress: 'me@sarv.com',
  toNames: null, ccAddress: null, ccNames: null, bccAddress: null, bccNames: null,
  replyTo: null, date: 1_700_000_000, receivedDate: null,
  cleanBody: 'Please review the attached proposal and reply.', rawBody: '<p>proposal</p>',
  ...over,
} as EmailRecord);

function makePipeline(over: Partial<UnifiedPipelineDeps> = {}, config: Record<string, unknown> = {}) {
  const saved = {
    categories: [] as Array<{ emailId: string; categories: { slug: string; confidence: number }[]; isSpam: boolean }>,
    notes: [] as Array<{ email: string; note: string; category: string; sourceEmailId?: string }>,
    decisions: [] as any[],
    actions: [] as Array<{ id: string; action: string; value?: string }>,
  };
  const callAI = vi.fn(async () => '[]');
  const deps: UnifiedPipelineDeps = {
    agentStorage: { saveDecision: vi.fn(async (d: any) => { saved.decisions.push(d); }) } as any,
    userEmail: 'me@sarv.com',
    callAI,
    getEmail: async () => null,
    getSenderContextBatch: () => ({}),
    getThreadDepths: () => ({}),
    getSenderRepetitionStats: () => ({ sameSubject: {}, totalEmails: 0 }),
    getEnabledCategoryDefinitions: () => CATEGORY_DEFS,
    saveEmailCategoriesBatch: (batch) => { saved.categories.push(...batch); return batch.length; },
    executeAction: async (id, action, value) => { saved.actions.push({ id, action, value }); },
    getContactType: () => 'unknown',
    getImportanceScore: () => 0,
    getCategoryCorrelations: () => ({}),
    saveNotes: (notes) => { saved.notes.push(...notes); return notes.length; },
    getNotesForPrompt: () => '',
    ...over,
  };
  const pipeline = new UnifiedPipeline(deps, { interBatchDelayMs: 0, ...config });
  return { pipeline, callAI, saved };
}

const aiResponse = (rows: unknown[]) => JSON.stringify(rows);

describe('UnifiedPipeline — received-email → AI flow (integration)', () => {
  // Regression: native Gmail discovery failure is a retry condition rather than permission to classify through AI.
  it('defers classification while native Gmail categories are unknown', async () => {
    const { pipeline, callAI, saved } = makePipeline();
    const result = await pipeline.processEmail(mkEmail({ gmailCategoriesPending: true }));
    expect(result?.classificationPending).toBe(true);
    expect(callAI).not.toHaveBeenCalled();
    expect(saved.categories).toEqual([]);
    expect(saved.actions).toEqual([]);
  });
  // Regression: native Gmail categories/Sarv Important and user choices must not incur classification calls or autonomous actions.
  it.each([
    { serverCategories: ['promotions'] },
    { serverCategories: ['important'] },
    { serverCategories: ['important'], manualCategories: [] },
  ])('keeps existing classification %j without an AI verdict', async (metadata) => {
    const { pipeline, callAI, saved } = makePipeline({ getCategoryCorrelations: () => ({ promotions: { action: 'archive', rate: 0.99 } }) }, { autoTriage: true });
    const result = await pipeline.processEmail(mkEmail(metadata));
    expect(callAI).not.toHaveBeenCalled();
    expect(saved.categories).toEqual([]);
    expect(saved.actions).toEqual([]);
    expect(saved.decisions).toEqual([]);
    expect(result?.categories).toEqual(metadata.manualCategories ?? metadata.serverCategories);
    expect(result?.classificationSource).toBe(metadata.manualCategories ? 'user' : 'provider');
  });

  // Regression: a mixed batch must classify only unclassified mail rather than skipping unrelated eligible rows.
  it('classifies ordinary mail in mixed batches while preserving server/user categories', async () => {
    const { pipeline, callAI, saved } = makePipeline();
    callAI.mockResolvedValue(aiResponse([{ emailId: 'plain', categories: ['invoice'], is_spam: false, confidence: 0.9 }]));
    const result = await pipeline.processBatch([
      mkEmail({ id: 'native', serverCategories: ['important'] }),
      mkEmail({ id: 'plain', serverCategories: [], tags: '|INBOX|starred|' }),
      mkEmail({ id: 'manual', manualCategories: [] }),
    ]);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(callAI.mock.calls[0]?.[1]).toContain('ID: plain');
    expect(callAI.mock.calls[0]?.[1]).not.toContain('ID: native');
    expect(saved.categories.map((r) => r.emailId)).toEqual(['plain']);
    expect(result.map((r) => [r.emailId, r.categories])).toEqual([['native', ['important']], ['plain', ['invoice']], ['manual', []]]);
  });

  // Regression: a provider label arriving while AI is in flight must win before save/action prediction.
  it('rechecks authority after a provider request', async () => {
    let classification: string[] | null = null;
    const { pipeline, callAI, saved } = makePipeline({ getEmail: async () => mkEmail({ serverCategories: classification }) }, { draftReplies: true });
    callAI.mockImplementation(async () => {
      classification = ['promotions'];
      return aiResponse([{ emailId: 'e1', categories: ['needs_response'], is_spam: false, confidence: 0.99 }]);
    });
    const result = await pipeline.processEmail(mkEmail());
    expect(result?.categories).toEqual(['promotions']);
    expect(result?.classificationSource).toBe('provider');
    expect(saved.categories).toEqual([]);
    expect(saved.actions).toEqual([]);
    expect(saved.decisions).toEqual([]);
  });

  it('categorizes, saves contact notes, and proposes a reply — all from one email', async () => {
    const { pipeline, callAI, saved } = makePipeline();
    callAI.mockResolvedValue(aiResponse([{
      emailId: 'e1',
      categories: ['needs_response', 'important'],
      is_spam: false,
      confidence: 0.9,
      reasoning: 'A direct request for a reply',
      notes: [{ note: 'Works at Partner Inc; prefers email', category: 'professional' }],
      sender_memory: { greeting: 'Hi Alice', tone: 'friendly', key_context: 'proposal review' },
    }]));

    const result = await pipeline.processEmail(mkEmail());

    // 1) The AI was actually called with a real prompt + the email text.
    expect(callAI).toHaveBeenCalledTimes(1);
    const [systemPrompt, userMessage] = callAI.mock.calls[0];
    expect(systemPrompt).toContain('needs_response'); // enabled category definitions reached the prompt
    expect(userMessage).toContain('review the proposal'); // the email body reached the prompt

    // 2) Categories were persisted for this email.
    expect(saved.categories).toHaveLength(1);
    expect(saved.categories[0].emailId).toBe('e1');
    expect(saved.categories[0].categories.map((c) => c.slug).sort())
      .toEqual(['important', 'needs_response']);

    // 3) Contact "details gathering": the extracted note is attributed to the sender.
    expect(saved.notes).toEqual([
      { email: 'alice@partner.com', note: 'Works at Partner Inc; prefers email', category: 'professional', sourceEmailId: 'e1' },
    ]);

    // 4) A reply was PROPOSED (needs_response ⟺ draft), with a decision row for the drafter.
    expect(result!.categories).toContain('needs_response');
    expect(result!.predictedAction).toBe('reply');
    expect(result!.proposed).toBe(true);
    expect(saved.decisions).toHaveLength(1);
    expect(saved.decisions[0]).toMatchObject({ emailId: 'e1', proposedAction: 'reply', status: 'pending' });

    // 5) It's a success, not a failure — the caller can mark it done.
    expect(result!.categorizationFailed).toBeFalsy();
  });

  it('flags spam and predicts the spam action (no reply proposed)', async () => {
    const { pipeline, saved, callAI } = makePipeline();
    callAI.mockResolvedValue(aiResponse([{
      emailId: 'e1', categories: [], is_spam: true, confidence: 0.95, reasoning: 'Lottery scam',
    }]));

    const result = await pipeline.processEmail(mkEmail({ fromAddress: 'win@lotto.biz' }));

    expect(result!.isSpam).toBe(true);
    expect(result!.predictedAction).toBe('spam');
    expect(saved.decisions).toHaveLength(0); // spam isn't a reply proposal
  });

  // Regression: with auto-triage on, the model's own "spam" on a message the
  // user cleared ("Not spam", or a trusted sender — stored as `ham`) must not
  // be acted on. Without the guard a trusted bank alert the filter let through
  // would be moved to Spam by the AI instead.
  it('does not auto-file a message the user cleared, even when the AI calls it spam', async () => {
    const spamCall = aiResponse([{ emailId: 'e1', categories: [], is_spam: true, confidence: 0.99, reasoning: 'Looks like a scam' }]);

    const cleared = makePipeline({}, { enabled: true, autoTriage: true });
    cleared.callAI.mockResolvedValue(spamCall);
    const kept = await cleared.pipeline.processEmail(mkEmail({ spamUserVerdict: 'ham' }));
    expect(kept!.executed).toBe(false);
    expect(cleared.saved.actions).toEqual([]);

    // The control: the same call on a message nobody cleared IS acted on.
    const plain = makePipeline({}, { enabled: true, autoTriage: true });
    plain.callAI.mockResolvedValue(spamCall);
    const filed = await plain.pipeline.processEmail(mkEmail());
    expect(filed!.executed).toBe(true);
    expect(plain.saved.actions).toEqual([{ id: 'e1', action: 'spam', value: undefined }]);
  });

  it('keeps a TRANSIENT AI failure pending (does not save categories, marks categorizationFailed)', async () => {
    // The connection blipped / provider 503'd. The email must stay pending for
    // retry — never marked done un-categorized, never a wrong category saved.
    const { pipeline, saved, callAI } = makePipeline();
    callAI.mockRejectedValue(new Error('provider 503'));

    const result = await pipeline.processEmail(mkEmail());

    expect(result!.categorizationFailed).toBe(true);
    expect(result!.categories).toEqual([]);
    expect(saved.categories).toHaveLength(0);
    expect(saved.notes).toHaveLength(0);
  });

  it('marks a PARSE failure distinctly (LLM answered but this email was unparseable)', async () => {
    // A deterministic parse miss is safe to give up on after a retry cap; a
    // transient throw is not — the flags must be distinguishable.
    const { pipeline, callAI } = makePipeline();
    callAI.mockResolvedValue('the model rambled and returned no JSON array');

    const result = await pipeline.processEmail(mkEmail());

    expect(result!.categorizationFailed).toBe(true);
    expect(result!.categorizationParseFailed).toBe(true); // parse miss, not a thrown error
  });

  it('processes a batch — every email is categorized and its notes saved', async () => {
    const { pipeline, saved, callAI } = makePipeline();
    callAI.mockResolvedValue(aiResponse([
      { emailId: 'e1', categories: ['invoice'], is_spam: false, confidence: 0.8, reasoning: 'a bill',
        notes: [{ note: 'Vendor: monthly billing', category: 'financial' }] },
      { emailId: 'e2', categories: ['important'], is_spam: false, confidence: 0.7, reasoning: 'FYI from CEO' },
    ]));

    const results = await pipeline.processBatch([
      mkEmail({ id: 'e1', fromAddress: 'billing@vendor.com', subject: 'Invoice #42' }),
      mkEmail({ id: 'e2', fromAddress: 'ceo@sarv.com', subject: 'Q3 numbers' }),
    ]);

    expect(results.map((r) => r.emailId).sort()).toEqual(['e1', 'e2']);
    expect(saved.categories.map((c) => c.emailId).sort()).toEqual(['e1', 'e2']);
    expect(saved.notes).toEqual([
      { email: 'billing@vendor.com', note: 'Vendor: monthly billing', category: 'financial', sourceEmailId: 'e1' },
    ]);
    expect(callAI).toHaveBeenCalledTimes(1); // one batched LLM call, not one per email
  });

  it('strips needs_response (and proposes no reply) for a no-reply/automated sender', async () => {
    // The Needs Response chip and the drafter must never fill up with mail from
    // senders that don't read replies, even if the model tags needs_response.
    const { pipeline, saved, callAI } = makePipeline();
    callAI.mockResolvedValue(aiResponse([{
      emailId: 'e1', categories: ['needs_response'], is_spam: false, confidence: 0.9, reasoning: 'asks to confirm',
    }]));

    const result = await pipeline.processEmail(mkEmail({ fromAddress: 'noreply@service.com' }));

    expect(result!.categories).not.toContain('needs_response');
    expect(result!.predictedAction).not.toBe('reply');
    expect(saved.decisions).toHaveLength(0);
  });

  it('strips needs_response when the user is not addressed (addressing gate)', async () => {
    // A team FYI / loop-in the user shouldn't reply to must not become a draft.
    const { pipeline, saved, callAI } = makePipeline({ isUserAddressed: () => false });
    callAI.mockResolvedValue(aiResponse([{
      emailId: 'e1', categories: ['needs_response', 'important'], is_spam: false, confidence: 0.9, reasoning: 'cc-only',
    }]));

    const result = await pipeline.processEmail(mkEmail());

    expect(result!.categories).not.toContain('needs_response');
    expect(result!.categories).toContain('important'); // other categories survive
    expect(saved.decisions).toHaveLength(0);
  });

  it('does not call the AI (or fail) when no categories are enabled', async () => {
    // Turning categories off is a legitimate empty state — not a failure to retry.
    const { pipeline, callAI, saved } = makePipeline({ getEnabledCategoryDefinitions: () => [] });

    const result = await pipeline.processEmail(mkEmail());

    expect(callAI).not.toHaveBeenCalled();
    expect(result!.categories).toEqual([]);
    expect(result!.categorizationFailed).toBeFalsy(); // empty defs ≠ failure
    expect(saved.categories).toHaveLength(0);
  });

  it('does not double-process an email already in flight (dedup)', async () => {
    const { pipeline, callAI } = makePipeline();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    callAI.mockImplementation(() => new Promise<string>((r) => {
      release = () => r(aiResponse([]));
      markStarted();
    }));

    const first = pipeline.processEmail(mkEmail());
    // Folder/category authority checks may await storage before entering the model.
    // Dedup must hold once processing is in flight, without relying on microtask order.
    await started;
    const second = await pipeline.processEmail(mkEmail()); // same id, still in flight
    expect(second).toBeNull();                            // deduped
    release();
    await first;
    expect(callAI).toHaveBeenCalledTimes(1);              // only the first ran the AI
  });
});


describe('known provider/filter Spam bypasses core intelligence', () => {
  // Real storage adds the current verdict's local spam tag before prediction.
  // That self-write must allow only its original Spam move, not lose auto-triage.
  it.each([false, true])('files its own successfully saved Spam verdict, batch=%s', async (batch) => {
    let row = mkEmail();
    const { pipeline, callAI, saved } = makePipeline({
      getEmail: async () => row,
      saveEmailCategoriesBatch: (rows) => { row = mkEmail({ tags: '|INBOX|spam|' }); return rows.length; },
    }, { autoTriage: true });
    callAI.mockResolvedValue(aiResponse([{ emailId: 'e1', categories: [], is_spam: true, confidence: 0.99 }]));
    const result = batch ? (await pipeline.processBatch([mkEmail()]))[0] : await pipeline.processEmail(mkEmail());
    expect(result).toMatchObject({ isSpam: true, predictedAction: 'spam', executed: true });
    expect(result?.classificationSource).toBeUndefined();
    expect(saved.actions).toEqual([{ id: 'e1', action: 'spam', value: undefined }]);
  });

  // Even a current saved model verdict cannot bypass a new provider membership
  // or explicit Spam choice. Linked localized Junk is included in that authority.
  it.each(['provider', 'linked', 'user'] as const)('protects %s Spam arriving after the current verdict save', async (source) => {
    let row = mkEmail();
    const { pipeline, callAI, saved } = makePipeline({
      getEmail: async () => row,
      getFolders: () => [{ path: 'Abfall', specialUse: '\\Junk' }],
      saveEmailCategoriesBatch: (rows) => {
        row = mkEmail({ tags: source === 'provider' ? '|INBOX|spam|\\Junk|' : source === 'linked' ? '|INBOX|spam|Abfall|' : '|INBOX|spam|', spamUserVerdict: source === 'user' ? 'spam' : null });
        return rows.length;
      },
    }, { autoTriage: true });
    callAI.mockResolvedValue(aiResponse([{ emailId: 'e1', categories: [], is_spam: true, confidence: 0.99 }]));
    expect(await pipeline.processEmail(mkEmail())).toMatchObject({ isSpam: true, predictedAction: null, executed: false, classificationSource: source === 'user' ? 'user' : 'provider' });
    expect(saved.actions).toEqual([]); expect(saved.decisions).toEqual([]);
  });

  // A ham edit after the model request still overrides its own Spam prediction.
  it('honors the latest explicit ham before filing a current model Spam verdict', async () => {
    let row = mkEmail();
    const { pipeline, callAI, saved } = makePipeline({
      getEmail: async () => row,
      saveEmailCategoriesBatch: (rows) => { row = mkEmail({ tags: '|INBOX|spam|', spamUserVerdict: 'ham' }); return rows.length; },
    }, { autoTriage: true });
    callAI.mockResolvedValue(aiResponse([{ emailId: 'e1', categories: [], is_spam: true, confidence: 0.99 }]));
    expect(await pipeline.processEmail(mkEmail())).toMatchObject({ isSpam: true, executed: false });
    expect(saved.actions).toEqual([]);
  });

  // An external local Spam update that already blocked saving is not a self-write.
  it('keeps externally assigned local Spam protected when a late model also predicts Spam', async () => {
    let row = mkEmail();
    const { pipeline, callAI, saved } = makePipeline({ getEmail: async () => row }, { autoTriage: true });
    callAI.mockImplementation(async () => { row = mkEmail({ tags: '|INBOX|spam|' }); return aiResponse([{ emailId: 'e1', categories: [], is_spam: true, confidence: 0.99 }]); });
    expect(await pipeline.processEmail(mkEmail())).toMatchObject({ isSpam: true, classificationSource: 'provider', predictedAction: null });
    expect(saved.categories).toEqual([]); expect(saved.actions).toEqual([]);
  });

  // A rejected/partial save cannot prove ownership of any visible local Spam tag.
  it.each([0, 1])('does not bypass local Spam after an unconfirmed batch save count %s', async (count) => {
    let tags = '|INBOX|';
    const { pipeline, callAI, saved } = makePipeline({
      getEmail: async (id) => mkEmail({ id, tags }),
      saveEmailCategoriesBatch: () => { tags = '|INBOX|spam|'; return count; },
    }, { autoTriage: true });
    callAI.mockResolvedValue(aiResponse(['e1', 'e2'].map((emailId) => ({ emailId, categories: [], is_spam: true, confidence: 0.99 }))));
    const result = await pipeline.processBatch([mkEmail(), mkEmail({ id: 'e2' })]);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.isSpam && r.classificationSource === 'provider' && !r.executed)).toBe(true);
    expect(saved.actions).toEqual([]);
  });

  // Existing Spam must remain Spam without model calls, contact notes, categories or autonomous actions.
  it.each(['|spam|', '|Spam|', '|\\Junk|', '|[Gmail]/Spam|'])('bypasses single-email AI for %s', async (tags) => {
    const { pipeline, callAI, saved } = makePipeline({}, { autoTriage: true });
    const email = mkEmail({ tags });
    expect(await pipeline.processEmail(email)).toMatchObject({ categories: ['spam'], isSpam: true, executed: false, proposed: false, predictedAction: null });
    expect(await pipeline.processEmail(email)).toMatchObject({ isSpam: true });
    expect(callAI).not.toHaveBeenCalled(); expect(saved.categories).toEqual([]); expect(saved.notes).toEqual([]); expect(saved.actions).toEqual([]);
  });

  // Provider Spam takes precedence over Promotions, manual category clears and stale ham until moved out.
  it('recognizes localized/linked Junk folder metadata while keeping explicit ham eligible after unspam', async () => {
    const row = mkEmail({ tags: '|All Mail|Abfall|', spamUserVerdict: 'ham', manualCategories: [] });
    const protectedMail = makePipeline({ getFolder: async () => ({ type: 'archive' }), getFolders: () => [{ path: 'Abfall', specialUse: '\\Junk' }] });
    expect(await protectedMail.pipeline.processEmail(row)).toMatchObject({ isSpam: true, categories: ['spam'], classificationSource: 'provider' });
    expect(protectedMail.callAI).not.toHaveBeenCalled();
    const ham = makePipeline(); ham.callAI.mockResolvedValue(aiResponse([{ emailId: 'e1', categories: ['invoice'], confidence: 0.9 }]));
    expect(await ham.pipeline.processEmail(mkEmail({ tags: '|INBOX|spam|', spamUserVerdict: 'ham' }))).toMatchObject({ categories: ['invoice'], isSpam: false });
    expect(ham.callAI).toHaveBeenCalledOnce();
  });

  // A mixed batch must categorize ordinary mail while retaining Spam and Promotions with no model assignment.
  it('excludes Spam from batch prompts and categorizes the remaining eligible mail', async () => {
    const { pipeline, callAI, saved } = makePipeline();
    callAI.mockResolvedValue(aiResponse([{ emailId: 'ordinary', categories: ['invoice'], confidence: 0.9 }]));
    const result = await pipeline.processBatch([
      mkEmail({ id: 'spam', tags: '|Spam|' }), mkEmail({ id: 'promo', serverCategories: ['promotions'] }), mkEmail({ id: 'ordinary' }),
    ]);
    expect(callAI.mock.calls[0][1]).toContain('ID: ordinary'); expect(callAI.mock.calls[0][1]).not.toContain('ID: spam'); expect(callAI.mock.calls[0][1]).not.toContain('ID: promo');
    expect(saved.categories.map((row) => row.emailId)).toEqual(['ordinary']);
    expect(result.map((row) => [row.emailId, row.isSpam])).toEqual([['spam', true], ['promo', false], ['ordinary', false]]);
  });

  // Spam arriving during the model call must discard its late category/action/contact-note output.
  it('drops a single-email late result when the message becomes Spam in flight', async () => {
    let row = mkEmail();
    const { pipeline, callAI, saved } = makePipeline({ getEmail: async () => row }, { autoTriage: true });
    callAI.mockImplementation(async () => {
      row = mkEmail({ tags: '|Spam|' });
      return aiResponse([{ emailId: 'e1', categories: ['needs_response'], confidence: 0.99, notes: [{ note: 'Do not save a scammer note', category: 'professional' }] }]);
    });
    expect(await pipeline.processEmail(mkEmail())).toMatchObject({ categories: ['spam'], isSpam: true, proposed: false, predictedAction: null });
    expect(saved.categories).toEqual([]); expect(saved.notes).toEqual([]); expect(saved.decisions).toEqual([]); expect(saved.actions).toEqual([]);
  });

  // A late Spam change affects only its own batch row, leaving unrelated normal processing intact.
  it('drops only the newly Spam row from batch saves and actions', async () => {
    let spam = false;
    const { pipeline, callAI, saved } = makePipeline({ getEmail: async (id) => mkEmail({ id, tags: id === 'late-spam' && spam ? '|\\Junk|' : '|INBOX|' }) });
    callAI.mockImplementation(async () => {
      spam = true;
      return aiResponse([{ emailId: 'late-spam', categories: ['needs_response'], confidence: 0.99 }, { emailId: 'normal', categories: ['invoice'], confidence: 0.9 }]);
    });
    const result = await pipeline.processBatch([mkEmail({ id: 'late-spam' }), mkEmail({ id: 'normal' })]);
    expect(saved.categories.map((row) => row.emailId)).toEqual(['normal']); expect(saved.decisions).toEqual([]);
    expect(result.find((row) => row.emailId === 'late-spam')).toMatchObject({ isSpam: true, categories: ['spam'], predictedAction: null });
  });

  // A final action checkpoint prevents acting on mail moved to provider Spam after categories were saved.
  it.each([false, true])('rechecks Spam immediately before action execution, batch=%s', async (batch) => {
    let reads = 0;
    const { pipeline, callAI, saved } = makePipeline({ getEmail: async () => mkEmail({ tags: ++reads >= 3 ? '|Spam|' : '|INBOX|' }) });
    callAI.mockResolvedValue(aiResponse([{ emailId: 'e1', categories: ['needs_response'], confidence: 0.99 }]));
    const result = batch ? (await pipeline.processBatch([mkEmail()]))[0] : await pipeline.processEmail(mkEmail());
    expect(result).toMatchObject({ categories: ['spam'], isSpam: true, predictedAction: null, proposed: false });
    expect(saved.decisions).toEqual([]); expect(saved.actions).toEqual([]);
  });
});
