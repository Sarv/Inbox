import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CATEGORIZATION_TEMPLATE,
  JUDGEMENT_CATEGORIES,
  MAX_API_RETRIES,
  PHISHING_PROMPT,
  SarvApiError,
  applySecurityGate,
  buildCategorizationPrompt,
  buildEmailText,
  buildSecurityContext,
  callAIProvider,
  callAIWithRetry,
  formatSecurityLines,
  validateCategorizationResponse,
  type AIProviderConfig,
  type CategorizationResult,
  type CategoryDef,
  type EmailSecurityContext,
  type EnrichedEmail,
} from '../../../src/agent/categorization-utils';

// This module is the whole contract with the LLM: what we SEND (prompt +
// per-email facts) and what we accept BACK. The response side is the fragile
// half — small/thinking models emit fences, <think> blocks, prose, truncated
// arrays, display names instead of slugs, and missing fields. None of that may
// throw (a throw loses the entire batch) and none of it may invent categories.
// The transport is exercised through the injectable `fetchImpl`, so no socket is
// ever opened.

const CATEGORIES: CategoryDef[] = [
  { slug: 'needs_response', name: 'Needs Response', prompt: 'someone is waiting on a reply' },
  { slug: 'invoice', name: 'Invoice & Billing', prompt: 'bills and receipts' },
  { slug: 'important', name: 'Important', prompt: 'urgent today' },
];
const SLUGS = new Set(CATEGORIES.map(c => c.slug));

const email = (over: Partial<EnrichedEmail> = {}): EnrichedEmail => ({
  id: 'e1',
  subject: 'Invoice #42',
  fromAddress: 'billing@vendor.com',
  toAddress: 'me@sarv.com',
  body: 'Please find the invoice attached.',
  date: Math.floor(Date.parse('2026-08-18T10:00:00Z') / 1000),
  isRead: false,
  ...over,
});

describe('buildCategorizationPrompt', () => {
  it('substitutes the user identity and renders every category with its prompt', () => {
    const prompt = buildCategorizationPrompt(CATEGORIES, 'advik.d@sarv.com');

    expect(prompt).toContain('advik.d@sarv.com');
    expect(prompt).toContain('name: advik.d');            // userName = local part
    expect(prompt).toContain('domain: sarv.com');         // userDomain
    expect(prompt).toContain('1. needs_response:\nsomeone is waiting on a reply');
    expect(prompt).toContain('2. invoice:\nbills and receipts');
    expect(prompt).toContain('3. important:\nurgent today');
    expect(prompt).toContain('is_spam:');                 // spamPrompt injected
    expect(prompt).not.toContain('{{');                   // no placeholder left behind
  });

  it('renders a user-supplied template override instead of the bundled default', () => {
    const prompt = buildCategorizationPrompt(CATEGORIES, 'me@sarv.com', 'MY TEMPLATE for {{userEmail}} :: {{categorySection}}');
    expect(prompt).toContain('MY TEMPLATE for me@sarv.com');
    expect(prompt).toContain('needs_response');
    expect(prompt).not.toContain('CORE PRINCIPLE');       // default template not used
  });

  it('falls back to the default template when the override is blank', () => {
    expect(buildCategorizationPrompt(CATEGORIES, 'me@sarv.com', '   ')).toBe(
      buildCategorizationPrompt(CATEGORIES, 'me@sarv.com'),
    );
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toContain('{{userEmail}}');
  });

  // A typo'd placeholder must stay visible rather than silently becoming '' —
  // an empty spot in the prompt is far harder to notice than a literal token.
  it('leaves unknown placeholders literal so a broken template is visible', () => {
    expect(buildCategorizationPrompt([], 'me@sarv.com', 'hi {{notAThing}} {{userName}}'))
      .toBe('hi {{notAThing}} me');
  });

  it('tolerates an address with no domain and an empty category list', () => {
    const prompt = buildCategorizationPrompt([], 'weird-address', '{{userName}}|{{userDomain}}|{{categorySection}}|');
    expect(prompt).toBe('weird-address||' + '|');
  });
});

describe('buildEmailText — the facts handed to the model', () => {
  it('includes the identifying header block, role and body for each email', () => {
    const text = buildEmailText([email(), email({ id: 'e2', subject: 'Second' })], 'me@sarv.com', ['invoice']);

    expect(text).toContain('Classify these 2 emails for user me@sarv.com');
    expect(text).toContain('--- Email 1 (ID: e1) ---');
    expect(text).toContain('--- Email 2 (ID: e2) ---');
    expect(text).toContain('From: billing@vendor.com');
    expect(text).toContain('To: me@sarv.com');
    expect(text).toContain('Role: TO (direct recipient)');
    expect(text).toContain('Subject: Invoice #42');
    expect(text).toContain('Date: 2026-08-18T10:00:00.000Z');
    expect(text).toContain('Please find the invoice attached.');
    expect(text).toContain('Return JSON array (categories from: "invoice")');
    expect(text).not.toContain('CC:');                    // omitted when absent
  });

  // CC detection is the single most important recipient signal in the prompt.
  it('marks a CC recipient explicitly and lists the CC addresses', () => {
    const text = buildEmailText([email({ userInCc: true, ccAddress: 'me@sarv.com' })], 'me@sarv.com', ['important']);
    expect(text).toContain('CC: me@sarv.com');
    expect(text).toContain('Role: CC (just looped in, NOT primary recipient)');
  });

  it('says "first-time sender" when there is no sender history', () => {
    expect(buildEmailText([email()], 'me@sarv.com', [])).toContain('Behavior: First-time sender, no history');
  });

  it('reports lifetime stats when the recent window is too sparse to trust', () => {
    const text = buildEmailText([email({
      senderContext: {
        tier: 'known', receivedCount: 10, sentToCount: 0, repliedCount: 0,
        readCount: 5, deletedCount: 2, isVip: false, isFavorite: false, isBlocked: false,
        recent: { windowDays: 90, receivedCount: 2, readCount: 0, deletedCount: 0, repliedCount: 0 },
      },
    })], 'me@sarv.com', []);

    expect(text).toContain('Behavior (lifetime): Read 50% | Keep 80% | User NEVER replied to this sender | Received: 10');
  });

  it('prefers the 90d window once it has enough signal, and shows the last-reply age', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const text = buildEmailText([email({
      senderContext: {
        tier: 'vip', receivedCount: 100, sentToCount: 3, repliedCount: 9,
        readCount: 1, deletedCount: 90, lastReplied: nowSec - 3 * 86400,
        isVip: true, isFavorite: false, isBlocked: true,
        recent: { windowDays: 90, receivedCount: 4, readCount: 4, deletedCount: 0, repliedCount: 2 },
      },
      sameSubjectCount: 9,
      volumePercent: 12,
    })], 'me@sarv.com', []);

    expect(text).toContain('Behavior (90d): Read 100% | Keep 100% | User replied 2 times (last 3d ago)');
    expect(text).toContain('Received: 4');
    expect(text).toContain('Same-Subject: 9 (repetitive)');
    expect(text).toContain('Volume: 12% of inbox');
    expect(text).toContain('VIP BLOCKED');
  });

  it('does not divide by zero when the sender has no received count', () => {
    const text = buildEmailText([email({
      senderContext: {
        tier: 'new', receivedCount: 0, sentToCount: 0, repliedCount: 0,
        readCount: 0, deletedCount: 0, isVip: false, isFavorite: false, isBlocked: false,
      },
    })], 'me@sarv.com', []);
    expect(text).toContain('Read 0% | Keep 0%');
    expect(text).not.toContain('NaN');
  });

  it('omits the low-signal enrichment lines instead of padding the prompt', () => {
    const text = buildEmailText([email({
      sameSubjectCount: 2,           // <= 5 → omitted
      volumePercent: 1,              // <= 2 → omitted
      contactType: 'unknown',        // → omitted
      threadDepth: 1,                // <= 1 → omitted
      senderMemory: { greeting: null, closing: null, tone: null, keyContext: null },
      authStatus: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', overall: 'none' },
    })], 'me@sarv.com', []);

    expect(text).not.toContain('Same-Subject');
    expect(text).not.toContain('Volume:');
    expect(text).not.toContain('Type:');
    expect(text).not.toContain('Thread:');
    expect(text).not.toContain('Memory:');
    expect(text).not.toContain('Auth:');
  });

  it('includes memory, contact type, thread depth, auth results and existing notes when present', () => {
    const text = buildEmailText([email({
      senderMemory: { greeting: 'Hi Advik', closing: null, tone: 'formal', keyContext: 'renewal' },
      contactType: 'existing_customer',
      threadDepth: 4,
      authStatus: { spf: 'pass', dkim: 'fail', dmarc: 'unknown', overall: 'partial' },
      existingNotes: '- pays late',
    })], 'me@sarv.com', []);

    expect(text).toContain('Memory: User greets: "Hi Advik" | Tone: formal | Context: renewal');
    expect(text).toContain('Type: existing_customer');
    expect(text).toContain('Thread: 4 messages');
    expect(text).toContain('Auth: SPF=pass DKIM=fail (overall: partial)');
    expect(text).not.toContain('DMARC=');                 // unknown is dropped
    expect(text).toContain('Existing-Notes:\n- pays late');
  });

  it('drops the overall auth qualifier when it is "none"', () => {
    const text = buildEmailText([email({ authStatus: { spf: 'pass', overall: 'none' } })], 'me@sarv.com', []);
    expect(text).toContain('Auth: SPF=pass');
    expect(text).not.toContain('overall');
  });
});

describe('validateCategorizationResponse — well-formed output', () => {
  it('accepts a clean JSON array and normalizes every field', () => {
    const results = validateCategorizationResponse(JSON.stringify([{
      emailId: 'e1',
      categories: ['invoice'],
      is_spam: false,
      confidence: 0.9,
      reasoning: 'a bill',
      should_auto_draft: false,
      auto_draft_reason: 'automated sender',
      sender_memory: { greeting: 'Hi', tone: 'formal', key_context: 'renewal' },
      notes: [{ note: 'pays monthly', category: 'financial' }],
    }]), SLUGS, CATEGORIES);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      emailId: 'e1',
      categories: ['invoice'],
      isSpam: false,
      confidence: 0.9,
      reasoning: 'a bill',
      shouldAutoDraft: false,
      autoDraftReason: 'automated sender',
      senderMemory: { greeting: 'Hi', tone: 'formal', keyContext: 'renewal' },
      notes: [{ note: 'pays monthly', category: 'financial' }],
    });
  });

  it('salvages the batch when the model SPELLS a confidence value ("0. nine" not 0.9)', () => {
    // Real regression: `"confidence": 0. nine` is a JSON syntax error inside EVERY
    // object, so per-object salvage failed too and the whole batch was discarded
    // ("No usable JSON in response"). The malformed numeric value is repaired to
    // null before parse → the object parses and confidence falls back to its
    // default; the categories (the part that matters) survive.
    const raw =
      '[ { "emailId": "e1", "categories": ["invoice"], "is_spam": false, "confidence": 0. nine, "reasoning": "a bill" } ]';
    const results = validateCategorizationResponse(raw, SLUGS, CATEGORIES);
    expect(results).toHaveLength(1);
    expect(results[0].emailId).toBe('e1');
    expect(results[0].categories).toEqual(['invoice']);
    expect(results[0].confidence).toBe(0.5); // defaulted, not the whole batch lost
  });

  // The consistency rule: a draft may only be prepared for a needs_response
  // email, else the Drafts folder outgrows the Needs Response list.
  it('honours should_auto_draft only when needs_response is also assigned', () => {
    const withResponse = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', categories: ['needs_response'], should_auto_draft: true }]), SLUGS);
    expect(withResponse[0].shouldAutoDraft).toBe(true);

    const withoutResponse = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', categories: ['invoice'], should_auto_draft: true }]), SLUGS);
    expect(withoutResponse[0].shouldAutoDraft).toBe(false);   // model violated the rule
  });

  it('clears categories when the email is spam', () => {
    const [result] = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', categories: ['invoice', 'important'], is_spam: true }]), SLUGS);
    expect(result.isSpam).toBe(true);
    expect(result.categories).toEqual([]);
  });

  it('maps display names, casing and spacing variants back to the canonical slug', () => {
    const [result] = validateCategorizationResponse(JSON.stringify([{
      emailId: 'e1',
      categories: ['Needs Response', 'INVOICE', 'invoice billing', ' important '],
    }]), SLUGS, CATEGORIES);
    expect(result.categories).toEqual(['needs_response', 'invoice', 'important']); // deduped
  });

  it('drops unmappable / non-string category tokens without throwing', () => {
    const [result] = validateCategorizationResponse(JSON.stringify([{
      emailId: 'e1',
      categories: ['invoice', 'made_up_category', 42, null, '', {}],
    }]), SLUGS, CATEGORIES);
    expect(result.categories).toEqual(['invoice']);
  });

  it('ignores category definitions whose slug is not in the known set', () => {
    const [result] = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', categories: ['Ghost Category'] }]),
      SLUGS,
      [...CATEGORIES, { slug: 'ghost', name: 'Ghost Category', prompt: 'x' }],
    );
    expect(result.categories).toEqual([]);
  });

  it('translates the legacy is_* boolean shape and filters it against the known slugs', () => {
    const [result] = validateCategorizationResponse(JSON.stringify([{
      emailId: 'e1',
      is_important: true,
      is_reminder: true,          // 'reminders' is not a known slug here → dropped
      is_needs_response: true,
      is_meeting_related: true,   // 'meeting' unknown → dropped
      is_invoice_billing: true,
    }]), SLUGS);
    expect(result.categories).toEqual(['important', 'needs_response', 'invoice']);
  });

  it('defaults confidence, reasoning, draft flag and optional blocks when fields are missing', () => {
    const [result] = validateCategorizationResponse(JSON.stringify([{ emailId: 7 }]), SLUGS);
    expect(result).toEqual({
      emailId: '7',                 // coerced to a string id
      categories: [],
      isSpam: false,
      confidence: 0.5,              // safe midpoint, not NaN
      reasoning: '',
      shouldAutoDraft: false,
      autoDraftReason: undefined,
      senderMemory: undefined,
      notes: undefined,
    });
  });

  it('ignores a non-numeric confidence and a non-string auto_draft_reason', () => {
    const [result] = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', confidence: 'high', auto_draft_reason: { why: 'x' } }]), SLUGS);
    expect(result.confidence).toBe(0.5);
    expect(result.autoDraftReason).toBeUndefined();
  });

  it('accepts either key_context or keyContext in sender_memory and drops empty values', () => {
    const [camel] = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', sender_memory: { keyContext: 'camel' } }]), SLUGS);
    expect(camel.senderMemory).toEqual({ greeting: undefined, tone: undefined, keyContext: 'camel' });

    const [blank] = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', sender_memory: { greeting: '', tone: null } }]), SLUGS);
    expect(blank.senderMemory).toEqual({ greeting: undefined, tone: undefined, keyContext: undefined });

    const [notObject] = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', sender_memory: 'nope' }]), SLUGS);
    expect(notObject.senderMemory).toBeUndefined();
  });

  it('filters junk notes, caps note length and defaults the note category', () => {
    const [result] = validateCategorizationResponse(JSON.stringify([{
      emailId: 'e1',
      notes: [
        { note: 'valid fact' },                       // no category → 'general'
        { note: '' },                                  // empty → dropped
        { category: 'role' },                          // no note → dropped
        null,
        'just a string',
        { note: 'x'.repeat(700), category: 'product' },
      ],
    }]), SLUGS);

    expect(result.notes).toEqual([
      { note: 'valid fact', category: 'general' },
      { note: 'x'.repeat(500), category: 'product' },  // capped at 500
    ]);
  });

  it('reports notes as undefined when every note was junk', () => {
    const [result] = validateCategorizationResponse(
      JSON.stringify([{ emailId: 'e1', notes: [{ note: '' }, null] }]), SLUGS);
    expect(result.notes).toBeUndefined();
  });

  it('skips entries with no emailId and non-object entries', () => {
    const results = validateCategorizationResponse(
      JSON.stringify([{ categories: ['invoice'] }, null, 'string', 42, { emailId: 'e2' }]), SLUGS);
    expect(results.map(r => r.emailId)).toEqual(['e2']);
  });
});

describe('validateCategorizationResponse — malformed LLM output must never throw', () => {
  it('strips markdown code fences', () => {
    const results = validateCategorizationResponse(
      '```json\n[{"emailId":"e1","categories":["invoice"]}]\n```', SLUGS);
    expect(results.map(r => r.emailId)).toEqual(['e1']);
  });

  // Thinking models (DeepSeek R1 etc.) emit reasoning inline; without the strip
  // JSON.parse throws and the whole batch is silently lost.
  it('strips <think> reasoning blocks that precede the JSON', () => {
    const results = validateCategorizationResponse(
      '<think>The user is asking about {braces} and [brackets]</think>[{"emailId":"e1","categories":[]}]', SLUGS);
    expect(results.map(r => r.emailId)).toEqual(['e1']);
  });

  it('recovers the array from surrounding prose', () => {
    const results = validateCategorizationResponse(
      'Sure! Here is my analysis:\n[{"emailId":"e1","categories":["invoice"]}]\nLet me know if you need more.', SLUGS);
    expect(results.map(r => r.emailId)).toEqual(['e1']);
    expect(results[0].categories).toEqual(['invoice']);
  });

  it('salvages the complete objects from a truncated array', () => {
    const results = validateCategorizationResponse(
      '[{"emailId":"e1","categories":["invoice"]},{"emailId":"e2","categories":["important"]},{"emailId":"e3","categ',
      SLUGS,
    );
    expect(results.map(r => r.emailId)).toEqual(['e1', 'e2']);   // e3 was cut off
  });

  it('repairs raw control characters inside a reasoning string', () => {
    const results = validateCategorizationResponse(
      '[{"emailId":"e1","categories":[],"reasoning":"line one\nline two\ttabbed"}]', SLUGS);
    expect(results).toHaveLength(1);
    expect(results[0].reasoning).toContain('line one');
  });

  // Last-resort path: nothing object-shaped to salvage, so the balanced [...] is
  // bracket-matched out of the prose and parsed as a unit.
  it('bracket-matches an array buried in reasoning prose even when it holds no objects', () => {
    expect(validateCategorizationResponse(
      'analysis: the categories I would use are ["invoice"] — done', SLUGS)).toEqual([]);
  });

  it('returns [] for a JSON object instead of an array', () => {
    expect(validateCategorizationResponse('{"emailId":"e1"}', SLUGS)).toEqual([]);
  });

  it('returns [] for prose with no JSON at all', () => {
    expect(validateCategorizationResponse('I am sorry, I cannot help with that.', SLUGS)).toEqual([]);
  });

  it('returns [] for an empty response', () => {
    expect(validateCategorizationResponse('', SLUGS)).toEqual([]);
  });

  it('returns [] for an unparseable array-shaped fragment', () => {
    expect(validateCategorizationResponse('[not json at all, really}', SLUGS)).toEqual([]);
  });

  it('handles an empty array', () => {
    expect(validateCategorizationResponse('[]', SLUGS)).toEqual([]);
  });
});

// ===== Transport =====

/** A JSON Response like the gateway would return. */
const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const chatCompletion = (content: string) => jsonResponse({ choices: [{ message: { content } }] });

const config = (over: Partial<AIProviderConfig> = {}): AIProviderConfig => ({
  type: 'sarv',
  apiKey: 'key-123',
  model: 'gemma-3',
  baseUrl: 'http://localhost:8880/edge/v1/llm',
  ...over,
});

describe('callAIProvider — OpenAI-compatible transport', () => {
  it('posts the chat completion with the bearer, model and thinking disabled', async () => {
    const fetchImpl = vi.fn(async () => chatCompletion('  hello from the model  '));
    const out = await callAIProvider(config({ fetchImpl }), 'SYSTEM', 'USER');

    expect(out).toBe('hello from the model');                 // trimmed
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8880/edge/v1/llm/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key-123');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gemma-3');
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER' },
    ]);
    // Thinking must be OFF: a reasoning pass burns the budget and truncates the
    // JSON these callers need.
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_completion_tokens).toBe(16000);
  });

  it('returns an empty string when the model returns no content', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    expect(await callAIProvider(config({ fetchImpl }), 's', 'u')).toBe('');
  });

  it('uses the OpenAI default base URL when none is configured', async () => {
    const fetchImpl = vi.fn(async (_url: string) => chatCompletion('ok'));
    await callAIProvider(config({ type: 'openai', baseUrl: undefined, fetchImpl }), 's', 'u');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  // The old hardcoded Sarv URL is dead: a missing baseUrl must fail loudly
  // instead of hitting a nonexistent host.
  it('throws a descriptive error when a Sarv baseUrl is missing', async () => {
    const fetchImpl = vi.fn();
    await expect(callAIProvider(config({ baseUrl: undefined, fetchImpl }), 's', 'u'))
      .rejects.toThrow(/no baseUrl configured for provider 'sarv'/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a fresh bearer per request when resolveBearer is supplied', async () => {
    const resolveBearer = vi.fn(async () => 'oauth-token');
    const fetchImpl = vi.fn(async () => chatCompletion('ok'));
    await callAIProvider(config({ resolveBearer, fetchImpl }), 's', 'u');

    expect(resolveBearer).toHaveBeenCalledWith(false);        // cached token is fine
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oauth-token');
  });

  // `Authorization: Bearer ` is an illegal header value and surfaces at the
  // gateway as a confusing 502, so it must be caught locally.
  it('refuses to send an empty bearer token', async () => {
    const fetchImpl = vi.fn();
    await expect(callAIProvider(config({ resolveBearer: async () => '   ', fetchImpl }), 's', 'u'))
      .rejects.toThrow(/empty bearer token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('force-refreshes the token once and retries on a 401 from the edge', async () => {
    const resolveBearer = vi.fn(async (force?: boolean) => (force ? 'fresh' : 'stale'));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_token' }, { status: 401 }))
      .mockResolvedValueOnce(chatCompletion('after refresh'));

    const out = await callAIProvider(config({ resolveBearer, fetchImpl }), 's', 'u');
    expect(out).toBe('after refresh');
    expect(resolveBearer.mock.calls).toEqual([[false], [true]]);   // second call forces a refresh
    const [, second] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((second.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
  });

  it('force-refreshes on a 403 too, and surfaces the error if the retry also fails', async () => {
    const resolveBearer = vi.fn(async () => 'tok');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'cai_account_required', message: 'link your account' }, { status: 403 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'cai_account_required', message: 'link your account' }, { status: 403 }));

    await expect(callAIProvider(config({ resolveBearer, fetchImpl }), 's', 'u'))
      .rejects.toMatchObject({ name: 'SarvApiError', code: 'cai_account_required', status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 401 when there is no OAuth resolver to refresh with', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_token' }, { status: 401 }));
    await expect(callAIProvider(config({ fetchImpl }), 's', 'u')).rejects.toBeInstanceOf(SarvApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('callAIProvider — error classification (SarvApiError)', () => {
  const failWith = async (body: unknown, init: ResponseInit) => {
    const response = typeof body === 'string'
      ? new Response(body, init)
      : jsonResponse(body, init);
    const fetchImpl = vi.fn(async () => response);
    try {
      await callAIProvider(config({ fetchImpl }), 's', 'u');
      throw new Error('expected a rejection');
    } catch (err) {
      return err as SarvApiError;
    }
  };

  it('uses the documented error code from the body when present', async () => {
    const err = await failWith({ error: 'insufficient_scope', message: 'reauthorize with more scopes' }, { status: 403 });
    expect(err).toBeInstanceOf(SarvApiError);
    expect(err.code).toBe('insufficient_scope');
    expect(err.message).toBe('reauthorize with more scopes');
    expect(err.status).toBe(403);
    expect(err.detail).toMatchObject({ error: 'insufficient_scope' });
  });

  it('unwraps the FastAPI { detail: { error, message } } envelope', async () => {
    const err = await failWith({ detail: { error: 'insufficient_role', message: 'ask your CAI admin' } }, { status: 403 });
    expect(err.code).toBe('insufficient_role');
    expect(err.message).toBe('ask your CAI admin');
  });

  it('maps bare status codes when the body carries no error code', async () => {
    expect((await failWith({}, { status: 401 })).code).toBe('invalid_token');
    expect((await failWith({}, { status: 402 })).code).toBe('insufficient_balance');
    expect((await failWith({}, { status: 429 })).code).toBe('rate_limit_exceeded');
    expect((await failWith({}, { status: 500 })).code).toBe('upstream_error');
  });

  it('honours Retry-After and ignores an unparseable one', async () => {
    const withHeader = await failWith({ error: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '30' } });
    expect(withHeader.retryAfterSec).toBe(30);
    const garbage = await failWith({ error: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': 'soon' } });
    expect(garbage.retryAfterSec).toBeUndefined();
    const missing = await failWith({ error: 'rate_limit_exceeded' }, { status: 429 });
    expect(missing.retryAfterSec).toBeUndefined();
  });

  it('falls back to a truncated raw body when the response is not JSON', async () => {
    const err = await failWith('<html>502 Bad Gateway</html>', { status: 502 });
    expect(err.code).toBe('upstream_error');
    expect(err.message).toContain('Sarv API 502');
    expect(err.message).toContain('502 Bad Gateway');
  });

  it('ignores an unrecognized error code and classifies by status instead', async () => {
    const err = await failWith({ error: 'something_new' }, { status: 429 });
    expect(err.code).toBe('rate_limit_exceeded');
  });
});

describe('callAIProvider — request timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // A half-open socket to the gateway would otherwise freeze categorization for
  // EVERY account (the pipeline serializes LLM calls behind one mutex).
  it('aborts a request that never answers', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
    }));

    const pending = callAIProvider(config({ fetchImpl }), 's', 'u');
    const assertion = expect(pending).rejects.toThrow(/AI request timed out/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('propagates the caller aborting mid-flight (pipeline shutdown)', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by caller')));
    }));

    const pending = callAIProvider(config({ fetchImpl }), 's', 'u', controller.signal);
    const assertion = expect(pending).rejects.toThrow(/aborted by caller/);
    controller.abort(new Error('shutting down'));
    await assertion;
  });

  it('aborts immediately when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error('aborted before send'));
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted before send')));
    }));

    await expect(callAIProvider(config({ fetchImpl }), 's', 'u', controller.signal))
      .rejects.toThrow(/aborted before send/);
  });
});

describe('callAIProvider — Gemini transport', () => {
  it('calls generateContent with the key, merged prompt and thinking disabled', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: ' gemini says hi ' }] } }] }));
    const out = await callAIProvider(config({ type: 'gemini', apiKey: 'gkey', model: 'gemini-2.5-flash', baseUrl: undefined, fetchImpl }), 'SYS', 'USR');

    expect(out).toBe('gemini says hi');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gkey');
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[0].text).toBe('SYS\n\nUSR');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(body.generationConfig.maxOutputTokens).toBe(16000);
  });

  it('honours a custom Gemini base URL and returns an empty string with no candidates', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse({}));
    const out = await callAIProvider(config({ type: 'gemini', baseUrl: 'https://proxy.example/v1', fetchImpl }), 's', 'u');
    expect(out).toBe('');
    expect(fetchImpl.mock.calls[0][0]).toContain('https://proxy.example/v1/models/');
  });

  it('classifies a Gemini failure through the same SarvApiError path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'quota' } }, { status: 429 }));
    await expect(callAIProvider(config({ type: 'gemini', fetchImpl }), 's', 'u'))
      .rejects.toMatchObject({ name: 'SarvApiError', code: 'rate_limit_exceeded' });
  });
});

describe('callAIWithRetry — only transient failures are retried', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Drain p-retry's exponential back-off (2s, 4s, 8s …) deterministically. */
  const drainBackoff = async () => {
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(10_000);
  };

  it('retries a 500 and returns the eventual success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 500 }))
      .mockResolvedValueOnce(chatCompletion('recovered'));

    const pending = callAIWithRetry(config({ fetchImpl }), 's', 'u');
    await drainBackoff();
    expect(await pending).toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries the gateway errors 502/503/504 as well', async () => {
    for (const status of [502, 503, 504]) {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jsonResponse({}, { status }))
        .mockResolvedValueOnce(chatCompletion('ok'));
      const pending = callAIWithRetry(config({ fetchImpl }), 's', 'u');
      await drainBackoff();
      expect(await pending, String(status)).toBe('ok');
      expect(fetchImpl, String(status)).toHaveBeenCalledTimes(2);
    }
  });

  it('retries a rate limit without waiting for Retry-After on top of the back-off', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '600' } }))
      .mockResolvedValueOnce(chatCompletion('ok'));

    const pending = callAIWithRetry(config({ fetchImpl }), 's', 'u');
    await drainBackoff();                       // 600s Retry-After is NOT awaited
    expect(await pending).toBe('ok');
  });

  // User-fixable failures must surface immediately — retrying burns the wallet
  // and hides the real cause behind a spinner.
  it('does NOT retry an invalid token, and rethrows the ORIGINAL error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_token' }, { status: 401 }));
    const pending = callAIWithRetry(config({ fetchImpl }), 's', 'u');
    const assertion = expect(pending).rejects.toMatchObject({ name: 'SarvApiError', code: 'invalid_token' });
    await drainBackoff();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry insufficient_balance / insufficient_scope', async () => {
    for (const [status, code] of [[402, 'insufficient_balance'], [403, 'insufficient_scope']] as const) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: code }, { status }));
      const pending = callAIWithRetry(config({ fetchImpl }), 's', 'u');
      const assertion = expect(pending).rejects.toMatchObject({ code });
      await drainBackoff();
      await assertion;
      expect(fetchImpl, code).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT retry a plain non-HTTP error (e.g. a misconfigured baseUrl)', async () => {
    const fetchImpl = vi.fn();
    const pending = callAIWithRetry(config({ baseUrl: undefined, fetchImpl }), 's', 'u');
    const assertion = expect(pending).rejects.toThrow(/no baseUrl configured/);
    await drainBackoff();
    await assertion;
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives up after MAX_API_RETRIES retries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 503 }));
    const pending = callAIWithRetry(config({ fetchImpl }), 's', 'u');
    const assertion = expect(pending).rejects.toBeInstanceOf(SarvApiError);
    await drainBackoff();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_API_RETRIES + 1);   // first try + retries
  });
});

describe('SarvApiError', () => {
  it('carries the status, code, retry hint and detail for the UI to branch on', () => {
    const err = new SarvApiError('empty wallet', { status: 402, code: 'insufficient_balance', retryAfterSec: 5, detail: { x: 1 } });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SarvApiError');
    expect(err.message).toBe('empty wallet');
    expect(err.status).toBe(402);
    expect(err.code).toBe('insufficient_balance');
    expect(err.retryAfterSec).toBe(5);
    expect(err.detail).toEqual({ x: 1 });
  });
});

// ========== Security context and the gate behind the model ==========

/**
 * The regression, verbatim: on 2026-09-23 "Adobe Acrobat Sign"
 * <Adobesign@powersublinks.com> — SPF, DKIM and DMARC all passing for the
 * attacker's own domain, every link going to kuaiyudh.top under text that said
 * sarv.com — was categorised important + reminders + needs_response at 0.95:
 * "a legal document that requires an immediate action (signature)". The model
 * never saw where the links went, and nothing stood behind it to say no. These
 * tests pin both halves: the evidence reaches the prompt, and the filter's
 * verdict outranks the model's.
 */
const LURE_HTML =
  '<p>Please review and sign</p>' +
  '<a href="https://kuaiyudh.top/v/#rc@sarv.com">Sarv.com Engagement Letter - for signature</a>' +
  '<a href="https://kuaiyudh.top/v/#rc@sarv.com">Review and sign</a>';

const lureRow = (over: Partial<Parameters<typeof buildSecurityContext>[0]> = {}) => ({
  fromAddress: 'Adobesign@powersublinks.com',
  spamScore: 9,
  spamReasons: JSON.stringify([
    { id: 'brand-impersonation', points: 3, detail: 'The sender name "Adobe Acrobat Sign" borrows the Adobe name' },
    { id: 'in-reply-to-self', points: 2, detail: 'Claims to be a reply to itself' },
    { id: 'link-display-mismatch', points: 4, detail: 'A link dressed as your own domain sarv.com actually points to kuaiyudh.top' },
  ]),
  rawBody: LURE_HTML,
  contentType: 'html',
  ...over,
});

const securityOf = (over: Partial<EmailSecurityContext> = {}): EmailSecurityContext => ({
  verdict: 'suspicious',
  score: 3,
  reasons: ['The sender name borrows the Adobe name'],
  deceptive: true,
  deceptiveLinks: [],
  linkDomains: [],
  ...over,
});

describe('buildSecurityContext', () => {
  it('reads the verdict, the reasons, the deceptive links and where the links go', () => {
    const ctx = buildSecurityContext(lureRow())!;
    expect(ctx.verdict).toBe('spam');
    expect(ctx.score).toBe(9);
    expect(ctx.reasons).toHaveLength(3);
    expect(ctx.deceptive).toBe(true);
    expect(ctx.deceptiveLinks).toEqual([{ shown: 'sarv.com', actual: 'kuaiyudh.top' }]);
    expect(ctx.linkDomains).toEqual(['kuaiyudh.top']);
  });

  // Regression: "never scored" must not reach the model as "clean". An empty
  // context is no lines at all.
  it('is undefined when the filter knows nothing, so the prompt says nothing', () => {
    expect(
      buildSecurityContext({ fromAddress: 'a@b.example', spamScore: null, spamReasons: null, rawBody: '', contentType: 'text' }),
    ).toBeUndefined();
    expect(buildSecurityContext({})).toBeUndefined();
  });

  it('distinguishes a deception from a nuisance, and reads links out of a plain-text body', () => {
    const nuisance = buildSecurityContext({
      fromAddress: 'cron@ops.example',
      spamScore: 3,
      spamReasons: JSON.stringify([
        { id: 'missing-message-id', points: 2, detail: 'No Message-ID' },
        { id: 'no-recipient', points: 1, detail: 'No recipient' },
      ]),
      rawBody: 'See https://status.ops.example/x and https://vendor.example/y',
      contentType: 'text',
    })!;
    expect(nuisance.verdict).toBe('suspicious');
    expect(nuisance.deceptive).toBe(false);
    expect(nuisance.deceptiveLinks).toEqual([]);
    // The sender's own domain is left out: the sender stage already judged it.
    expect(nuisance.linkDomains).toEqual(['vendor.example']);
  });

  it('treats a lying link as deception even when the stored reasons carry none', () => {
    const ctx = buildSecurityContext(lureRow({ spamScore: 0, spamReasons: '[]' }))!;
    expect(ctx.verdict).toBe('clean');
    expect(ctx.deceptive).toBe(true);
    expect(ctx.reasons).toEqual([]);
  });

  it('tolerates corrupt stored reasons and a body with no links', () => {
    const ctx = buildSecurityContext({
      fromAddress: 'a@b.example',
      spamScore: 2,
      spamReasons: 'not json',
      rawBody: '<p>hello</p>',
      contentType: 'html',
    });
    expect(ctx).toEqual({ verdict: 'clean', score: 2, reasons: [], deceptive: false, deceptiveLinks: [], linkDomains: [] });
  });
});

describe('formatSecurityLines', () => {
  it('names the verdict with its reasons, each deceptive link, and the link destinations', () => {
    const text = formatSecurityLines(buildSecurityContext(lureRow()));
    expect(text).toContain('\nSecurity: SPAM (filter score 9) — The sender name');
    expect(text).toContain('\nDeceptive-Link: text says sarv.com, actually goes to kuaiyudh.top');
    expect(text).toContain('\nLinks-Go-To: kuaiyudh.top');
  });

  it('says clean in lower case, upper-cases the warnings, and omits what is absent', () => {
    const empty = { reasons: [], deceptive: false, deceptiveLinks: [], linkDomains: [] };
    expect(formatSecurityLines({ ...empty, verdict: 'clean', score: 0 })).toBe('\nSecurity: clean (filter score 0)');
    expect(formatSecurityLines(securityOf({ reasons: ['x'] }))).toBe('\nSecurity: SUSPICIOUS (filter score 3) — x');
    expect(formatSecurityLines({ ...empty, verdict: null, score: null, linkDomains: ['a.example'] })).toBe('\nLinks-Go-To: a.example');
    expect(formatSecurityLines(undefined)).toBe('');
    expect(formatSecurityLines({ ...empty, verdict: null, score: null })).toBe('');
  });

  // Regression: the whole point. The per-email text the model reads must carry
  // the evidence, or the prompt's phishing rules have nothing to act on.
  it('reaches the model through buildEmailText', () => {
    const email: EnrichedEmail = {
      id: 'e1',
      subject: 'Signature requested',
      fromAddress: 'adobesign@powersublinks.com',
      toAddress: 'rc@sarv.com',
      body: 'Please review and sign',
      date: 1_790_000_000,
      isRead: false,
      security: buildSecurityContext(lureRow()),
    };
    const text = buildEmailText([email], 'rc@sarv.com', ['important']);
    expect(text).toContain('Security: SPAM');
    expect(text).toContain('Deceptive-Link: text says sarv.com, actually goes to kuaiyudh.top');
  });
});

describe('PHISHING_PROMPT', () => {
  // Regression: the two facts the model got wrong, stated in so many words, and
  // rendered into the system prompt every path uses.
  it('teaches that authentication is not identity and that the Security lines come first', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toContain('{{phishingPrompt}}');
    expect(buildCategorizationPrompt(CATEGORIES, 'rc@sarv.com')).toContain(PHISHING_PROMPT);
    expect(PHISHING_PROMPT).toMatch(/Passing SPF, DKIM and DMARC does NOT mean/);
    expect(PHISHING_PROMPT).toMatch(/NEVER important, needs_response or reminders/);
    expect(PHISHING_PROMPT).toContain('Deceptive-Link');
    expect(PHISHING_PROMPT).toContain('Links-Go-To');
  });
});

describe('applySecurityGate', () => {
  const result = (over: Partial<CategorizationResult> = {}): CategorizationResult => ({
    emailId: 'e1',
    categories: ['important', 'reminders', 'needs_response', 'invoice'],
    isSpam: false,
    confidence: 0.95,
    reasoning: 'Legal document needing a signature',
    shouldAutoDraft: true,
    autoDraftReason: 'direct request',
    ...over,
  });
  const withSecurity = (security: EmailSecurityContext | undefined) => [{ id: 'e1', security }];

  // The regression itself: the filter said spam, the model said important.
  it('forces spam and clears everything when the filter scored the message spam', () => {
    const [r] = applySecurityGate([result()], withSecurity(buildSecurityContext(lureRow())));
    expect(r!.isSpam).toBe(true);
    expect(r!.categories).toEqual([]);
    expect(r!.shouldAutoDraft).toBe(false);
    expect(r!.reasoning).toMatch(/^Security filter scored it spam: The sender name/);
    expect(r!.reasoning).toContain('Legal document needing a signature');
  });

  it('strips the judgement categories and the draft on a suspicious deception, keeping the descriptive ones', () => {
    const [r] = applySecurityGate([result()], withSecurity(securityOf()));
    expect(r!.categories).toEqual(['invoice']);
    expect(r!.isSpam).toBe(false);
    expect(r!.shouldAutoDraft).toBe(false);
    expect(r!.autoDraftReason).toContain('deception');
    expect(r!.reasoning).toContain(
      '[Security gate: dropped important, reminders, needs_response — The sender name borrows the Adobe name]',
    );
    for (const slug of JUDGEMENT_CATEGORIES) expect(r!.categories).not.toContain(slug);
  });

  it('explains itself from the deceptive links when the stored reasons are empty', () => {
    const [r] = applySecurityGate(
      [result({ categories: ['important'] })],
      withSecurity(securityOf({ reasons: [], deceptiveLinks: [{ shown: 'sarv.com', actual: 'kuaiyudh.top' }] })),
    );
    expect(r!.reasoning).toContain('text says sarv.com, goes to kuaiyudh.top');
  });

  it('still cancels a draft that arrived without a judgement category', () => {
    const [r] = applySecurityGate([result({ categories: ['invoice'] })], withSecurity(securityOf()));
    expect(r!.shouldAutoDraft).toBe(false);
    expect(r!.reasoning).toContain('no draft');
  });

  // Regression: the gate must not become a second spam filter. A suspicious
  // score made of nuisances, a clean verdict, an unscored message, no context
  // at all, or a result with nothing to strip pass through untouched.
  it('leaves everything else exactly as the model returned it', () => {
    const untouched: ReadonlyArray<ReadonlyArray<{ id: string; security?: EmailSecurityContext }>> = [
      withSecurity(securityOf({ deceptive: false })),
      withSecurity(securityOf({ verdict: 'clean', score: 2 })),
      withSecurity(securityOf({ verdict: null, score: null })),
      withSecurity(undefined),
      [{ id: 'someone-else' }],
    ];
    for (const emails of untouched) {
      expect(applySecurityGate([result()], emails)[0]).toEqual(result());
    }
    const nothingToStrip = result({ categories: ['invoice'], shouldAutoDraft: false });
    expect(applySecurityGate([nothingToStrip], withSecurity(securityOf()))[0]).toEqual(
      result({ categories: ['invoice'], shouldAutoDraft: false }),
    );
  });

  it('gates each result against its own email in a batch', () => {
    const results = [result({ emailId: 'a' }), result({ emailId: 'b' })];
    applySecurityGate(results, [{ id: 'a', security: securityOf() }, { id: 'b' }]);
    expect(results[0]!.categories).toEqual(['invoice']);
    expect(results[1]!.categories).toEqual(['important', 'reminders', 'needs_response', 'invoice']);
  });
});
