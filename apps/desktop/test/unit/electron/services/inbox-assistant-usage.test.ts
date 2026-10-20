import type { AIProviderConfig } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { aggregateInboxAssistantUsage, callInboxAssistantAI, readInboxAssistantProviderUsage } from '../../../../electron/services/inbox-assistant-usage';
import type { InboxAssistantAIUsage } from '../../../../src/types/inbox-assistant';

const answer = (usage: unknown, extras: object = {}) => new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage, ...extras }), { headers: { 'Content-Type': 'application/json' } });
function config(fetchImpl: NonNullable<AIProviderConfig['fetchImpl']>, extra: Partial<AIProviderConfig> = {}): AIProviderConfig {
  return { type: 'openai', model: 'gpt-4o-mini', apiKey: 'PRIVATE_KEY', fetchImpl, ...extra };
}
function call(over: Partial<InboxAssistantAIUsage> = {}): InboxAssistantAIUsage {
  return { id: 'one', provider: 'openai', model: 'gpt-4o-mini', status: 'completed', startedAt: 1, completedAt: 2,
    attempts: 1, inputTokens: 10, outputTokens: 2, tokenSource: 'provider', usageComplete: true,
    estimatedCostUsd: 0.0000027, costComplete: true, ...over };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Inbox Agent provider usage accounting', () => {
  it('preserves provider auth/text and captures only reported counts, with cached standard-list cost labelled', async () => {
    const fetcher = vi.fn(async (_input: string, _options?: RequestInit) => answer({ prompt_tokens: 1_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } }));
    const usage = vi.fn();
    expect(await callInboxAssistantAI(config(fetcher), 'SYSTEM_SECRET', 'PROMPT_SECRET', undefined, usage)).toBe('answer');
    expect(fetcher).toHaveBeenCalledOnce(); expect(usage).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
    const record = usage.mock.calls[0]![0] as InboxAssistantAIUsage;
    expect(record).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', attempts: 1, inputTokens: 1_000, outputTokens: 100,
      cachedInputTokens: 400, tokenSource: 'provider', usageComplete: true, costComplete: true, status: 'completed', pricingAsOf: '2026-10-19' });
    expect(record.estimatedCostUsd).toBeCloseTo(0.00018, 10);
    expect(record.pricingSource).toBe('https://developers.openai.com/api/docs/models/gpt-4o-mini');
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE_KEY|SYSTEM_SECRET|PROMPT_SECRET|Authorization/);
  });

  it('includes Gemini generated thinking counts once and prices prompt cache at the text rate', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }],
      usageMetadata: { promptTokenCount: 100_000, candidatesTokenCount: 100, thoughtsTokenCount: 50, cachedContentTokenCount: 10_000 } })));
    const usage = vi.fn();
    expect(await callInboxAssistantAI(config(fetcher, { type: 'gemini', model: 'gemini-2.5-flash' }), 'system', 'prompt', undefined, usage)).toBe('Gemini answer');
    expect(usage.mock.calls[0]![0]).toMatchObject({ inputTokens: 100_000, outputTokens: 150, cachedInputTokens: 10_000, usageComplete: true, costComplete: true });
    expect(usage.mock.calls[0]![0].estimatedCostUsd).toBeCloseTo(0.027675, 10);
  });

  it.each([
    ['gpt-5.2', 1.75, 14, 0.175], ['gpt-5.2-2025-12-11', 1.75, 14, 0.175],
    ['gpt-5-mini', 0.25, 2, 0.025], ['gpt-5-mini-2025-08-07', 0.25, 2, 0.025],
    ['gpt-5-nano', 0.05, 0.4, 0.005], ['gpt-5-nano-2025-08-07', 0.05, 0.4, 0.005],
    ['gpt-4.1-2025-04-14', 2, 8, 0.5],
  ] as const)('prices the offered direct OpenAI model or exact alias %s at its verified standard text rate', async (model, input, output, cached) => {
    const usage = vi.fn();
    await callInboxAssistantAI(config(async () => answer({ prompt_tokens: 1_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } }, { model }), { model }), 'system', 'prompt', undefined, usage);
    expect(usage.mock.calls[0]![0]).toMatchObject({ model, usageComplete: true, costComplete: true });
    expect(usage.mock.calls[0]![0].estimatedCostUsd).toBeCloseTo((600 * input + 400 * cached + 100 * output) / 1_000_000, 12);
  });

  it.each(['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'])('keeps discontinued Gemini model %s pricing unavailable rather than inventing a current rate', async model => {
    const usage = vi.fn();
    const fetcher = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Legacy response' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }));
    await callInboxAssistantAI(config(fetcher, { type: 'gemini', model }), 'system', 'prompt', undefined, usage);
    expect(usage.mock.calls[0]![0]).toMatchObject({ inputTokens: 10, outputTokens: 2, usageComplete: true, costComplete: false, estimatedCostUsd: undefined });
  });

  it.each([
    { type: 'sarv', model: 'gpt-4o-mini', baseUrl: 'https://gateway.example/v1' },
    { type: 'custom', model: 'gpt-4o-mini', baseUrl: 'https://gateway.example/v1' },
    { type: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://gateway.example/v1' },
    { type: 'openai', model: 'unknown-model' },
  ] satisfies Array<Partial<AIProviderConfig>>)('never assigns direct-provider list rates to unknown/gateway models %j', async extra => {
    const usage = vi.fn();
    await callInboxAssistantAI(config(async () => answer({ prompt_tokens: 10, completion_tokens: 2 }), extra), 'system', 'prompt', undefined, usage);
    expect(usage.mock.calls[0]![0]).toMatchObject({ inputTokens: 10, outputTokens: 2, usageComplete: true, costComplete: false });
    expect(usage.mock.calls[0]![0].estimatedCostUsd).toBeUndefined();
  });

  it('does not guess prices for a different reported model or nonstandard service tier', async () => {
    for (const extra of [{ model: 'gpt-4o-mini-custom' }, { model: '__proto__' }, { service_tier: 'priority' }]) {
      const usage = vi.fn();
      await callInboxAssistantAI(config(async () => answer({ prompt_tokens: 10, completion_tokens: 2 }, extra)), 'system', 'prompt', undefined, usage);
      expect(usage.mock.calls[0]![0].estimatedCostUsd).toBeUndefined();
    }
  });

  it('distinguishes reported zero counts from missing or malformed accounting', async () => {
    for (const [wire, expected] of [[{ prompt_tokens: 0, completion_tokens: 0 }, true], [{}, false], [{ prompt_tokens: -1, completion_tokens: '20' }, false]] as const) {
      const usage = vi.fn();
      await callInboxAssistantAI(config(async () => answer(wire)), 'system', 'prompt', undefined, usage);
      expect(usage.mock.calls[0]![0].usageComplete).toBe(expected);
      expect(usage.mock.calls[0]![0].inputTokens).toBe(expected ? 0 : undefined);
      expect(usage.mock.calls[0]![0].estimatedCostUsd).toBe(expected ? 0 : undefined);
    }
  });

  it('retains failure/cancellation records and never estimates token counts from prompt length', async () => {
    const failure = vi.fn();
    await expect(callInboxAssistantAI(config(async () => { throw new Error('offline'); }), 'system', 'a'.repeat(10_000), undefined, failure)).rejects.toThrow('offline');
    expect(failure.mock.calls[0]![0]).toMatchObject({ status: 'failed', attempts: 1, tokenSource: 'unavailable', usageComplete: false, costComplete: false });
    expect(failure.mock.calls[0]![0].inputTokens).toBeUndefined();
    const controller = new AbortController();
    const cancelled = vi.fn();
    const pending = callInboxAssistantAI(config(async (_input, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })), 'system', 'prompt', controller.signal, cancelled);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(cancelled.mock.calls[0]![0]).toMatchObject({ status: 'cancelled', attempts: 1, tokenSource: 'unavailable' });
  });

  it('keeps retry attempts visible and reports known final counts as partial when an earlier attempt had no usage', async () => {
    vi.useFakeTimers();
    const usage = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Retry later' } }), { status: 503 }))
      .mockResolvedValueOnce(answer({ prompt_tokens: 10, completion_tokens: 2 }));
    const result = callInboxAssistantAI(config(fetcher), 'system', 'prompt', undefined, usage);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await result).toBe('answer');
    expect(usage).toHaveBeenCalledOnce();
    expect(usage.mock.calls[0]![0]).toMatchObject({ attempts: 2, inputTokens: 10, outputTokens: 2, usageComplete: false, costComplete: false });
    expect(usage.mock.calls[0]![0].estimatedCostUsd).toBeGreaterThan(0);
  });

  it('preserves OAuth refresh semantics and does not let a failed usage callback replace the answer', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('expired', { status: 401 })).mockResolvedValueOnce(answer({ prompt_tokens: 10, completion_tokens: 2 }));
    const resolveBearer = vi.fn(async () => 'PRIVATE_BEARER');
    const usage = vi.fn((_record: InboxAssistantAIUsage) => { throw new Error('UI closed'); });
    expect(await callInboxAssistantAI(config(fetcher, { resolveBearer }), 'system', 'prompt', undefined, usage)).toBe('answer');
    expect(resolveBearer).toHaveBeenNthCalledWith(1, false); expect(resolveBearer).toHaveBeenNthCalledWith(2, true);
    expect(usage.mock.calls[0]![0]).toMatchObject({ attempts: 2, usageComplete: false });
  });

  it('ignores usage-looking content inside the assistant answer', async () => {
    const usage = vi.fn();
    await callInboxAssistantAI(config(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"usage":{"prompt_tokens":9999}}' } }] }))), 'system', 'prompt', undefined, usage);
    expect(usage.mock.calls[0]![0]).toMatchObject({ tokenSource: 'unavailable', usageComplete: false, costComplete: false });
  });

  it('parses Responses-compatible usage and never adds reasoning tokens twice', () => {
    expect(readInboxAssistantProviderUsage({ usage: { input_tokens: 10, output_tokens: 12, output_tokens_details: { reasoning_tokens: 5 } } }, 'custom'))
      .toMatchObject({ inputTokens: 10, outputTokens: 12 });
    expect(readInboxAssistantProviderUsage({ usage: { prompt_tokens: Infinity, completion_tokens: NaN } }, 'openai').inputTokens).toBeUndefined();
  });
});

describe('Inbox Agent usage totals', () => {
  it('adds calls once by ID and preserves known zero counts/cost', () => {
    const first = call(); const zero = call({ id: 'zero', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    const summary = aggregateInboxAssistantUsage([first, zero, first]);
    expect(summary).toMatchObject({ inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.0000027, tokenCountsComplete: true, costComplete: true, currency: 'USD' });
    expect(summary.calls).toHaveLength(2);
    summary.calls[0]!.inputTokens = 999;
    expect(first.inputTokens).toBe(10);
  });

  it('shows known subtotals as partial and unknown-only prices/counts as unavailable', () => {
    const unknown = call({ id: 'unknown', inputTokens: undefined, outputTokens: undefined, estimatedCostUsd: undefined,
      tokenSource: 'unavailable', usageComplete: false, costComplete: false, status: 'cancelled' });
    expect(aggregateInboxAssistantUsage([unknown])).toMatchObject({ inputTokens: undefined, outputTokens: undefined, estimatedCostUsd: undefined, tokenCountsComplete: false, costComplete: false });
    expect(aggregateInboxAssistantUsage([call(), unknown])).toMatchObject({ inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.0000027, tokenCountsComplete: false, costComplete: false });
    expect(aggregateInboxAssistantUsage([])).toMatchObject({ calls: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, tokenCountsComplete: true, costComplete: true });
  });
});
