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

function makePipeline(over: Partial<UnifiedPipelineDeps> = {}) {
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
  const pipeline = new UnifiedPipeline(deps, { interBatchDelayMs: 0 });
  return { pipeline, callAI, saved };
}

const aiResponse = (rows: unknown[]) => JSON.stringify(rows);

describe('UnifiedPipeline — received-email → AI flow (integration)', () => {
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
    callAI.mockImplementation(() => new Promise<string>((r) => { release = () => r(aiResponse([])); }));

    const first = pipeline.processEmail(mkEmail());      // starts, awaits callAI
    const second = await pipeline.processEmail(mkEmail()); // same id, still in flight
    expect(second).toBeNull();                            // deduped
    release();
    await first;
    expect(callAI).toHaveBeenCalledTimes(1);              // only the first ran the AI
  });
});
