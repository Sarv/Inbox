import { randomUUID } from 'node:crypto';

import { callAIWithRetry, type AIProviderConfig } from '@sarvinbox/core';

import type { InboxAssistantAIUsage, InboxAssistantUsage } from '../../src/types/inbox-assistant';

const PRICING_AS_OF = '2026-10-19';
interface Rate { input: number; output: number; cached: number; source: string }
const OPENAI = 'https://developers.openai.com/api/docs/models/';
const GEMINI = 'https://ai.google.dev/gemini-api/docs/pricing';
// Standard synchronous text list rates per million tokens, verified on the
// date above. Unlisted models/gateway prices are intentionally unavailable.
const OPENAI_RATES: Record<string, Rate> = {
  'gpt-5.2': { input: 1.75, output: 14, cached: 0.175, source: `${OPENAI}gpt-5.2` },
  'gpt-5.2-2025-12-11': { input: 1.75, output: 14, cached: 0.175, source: `${OPENAI}gpt-5.2` },
  'gpt-5-mini': { input: 0.25, output: 2, cached: 0.025, source: `${OPENAI}gpt-5-mini` },
  'gpt-5-mini-2025-08-07': { input: 0.25, output: 2, cached: 0.025, source: `${OPENAI}gpt-5-mini` },
  'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005, source: `${OPENAI}gpt-5-nano` },
  'gpt-5-nano-2025-08-07': { input: 0.05, output: 0.4, cached: 0.005, source: `${OPENAI}gpt-5-nano` },
  'gpt-4.1': { input: 2, output: 8, cached: 0.5, source: `${OPENAI}gpt-4.1` },
  'gpt-4.1-2025-04-14': { input: 2, output: 8, cached: 0.5, source: `${OPENAI}gpt-4.1` },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1, source: `${OPENAI}gpt-4.1-mini` },
  'gpt-4.1-mini-2025-04-14': { input: 0.4, output: 1.6, cached: 0.1, source: `${OPENAI}gpt-4.1-mini` },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cached: 0.025, source: `${OPENAI}gpt-4.1-nano` },
  'gpt-4.1-nano-2025-04-14': { input: 0.1, output: 0.4, cached: 0.025, source: `${OPENAI}gpt-4.1-nano` },
  'gpt-4o': { input: 2.5, output: 10, cached: 1.25, source: `${OPENAI}gpt-4o` },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075, source: `${OPENAI}gpt-4o-mini` },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6, cached: 0.075, source: `${OPENAI}gpt-4o-mini` },
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000 ? value : undefined;
}
function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
}
function total(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

/** Sum known values without turning absent provider counts/prices into zero. */
export function aggregateInboxAssistantUsage(calls: readonly InboxAssistantAIUsage[]): InboxAssistantUsage {
  const unique = [...new Map(calls.map(call => [call.id, call])).values()];
  const empty = unique.length === 0;
  return {
    calls: unique.map(call => ({ ...call })), currency: 'USD',
    inputTokens: empty ? 0 : total(unique.map(call => count(call.inputTokens))),
    outputTokens: empty ? 0 : total(unique.map(call => count(call.outputTokens))),
    cachedInputTokens: total(unique.map(call => count(call.cachedInputTokens))),
    tokenCountsComplete: unique.every(call => call.usageComplete && count(call.inputTokens) !== undefined && count(call.outputTokens) !== undefined),
    estimatedCostUsd: empty ? 0 : total(unique.map(call => amount(call.estimatedCostUsd))),
    costComplete: unique.every(call => call.costComplete && amount(call.estimatedCostUsd) !== undefined),
  };
}

interface ReportedUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; model?: string; serviceTier?: string }
export function readInboxAssistantProviderUsage(payload: unknown, provider: string): ReportedUsage {
  const data = object(payload);
  if (provider === 'gemini') {
    const usage = object(data.usageMetadata);
    const candidates = count(usage.candidatesTokenCount);
    const thoughts = usage.thoughtsTokenCount === undefined ? 0 : count(usage.thoughtsTokenCount);
    return { inputTokens: count(usage.promptTokenCount), outputTokens: candidates !== undefined && thoughts !== undefined ? candidates + thoughts : undefined,
      cachedInputTokens: count(usage.cachedContentTokenCount), model: typeof data.modelVersion === 'string' ? data.modelVersion.slice(0, 200) : undefined };
  }
  const usage = object(data.usage);
  return { inputTokens: count(usage.prompt_tokens ?? usage.input_tokens), outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
    cachedInputTokens: count(object(usage.prompt_tokens_details ?? usage.input_tokens_details).cached_tokens),
    model: typeof data.model === 'string' ? data.model.slice(0, 200) : undefined,
    serviceTier: typeof data.service_tier === 'string' ? data.service_tier : undefined };
}

function rateFor(config: AIProviderConfig, usage: ReportedUsage): Rate | undefined {
  if (usage.serviceTier && !['default', 'standard', 'auto'].includes(usage.serviceTier)) return undefined;
  const model = usage.model || config.model;
  let url: URL;
  try { url = new URL(config.baseUrl || (config.type === 'openai' ? 'https://api.openai.com/v1' : 'https://generativelanguage.googleapis.com/v1beta')); }
  catch { return undefined; }
  if (url.protocol !== 'https:') return undefined;
  if (config.type === 'openai' && url.hostname === 'api.openai.com' && /^\/v1\/?$/.test(url.pathname)) {
    return Object.prototype.hasOwnProperty.call(OPENAI_RATES, model) ? OPENAI_RATES[model] : undefined;
  }
  if (config.type !== 'gemini' || url.hostname !== 'generativelanguage.googleapis.com' || !/^\/v1(?:beta)?\/?$/.test(url.pathname)) return undefined;
  if (model === 'gemini-2.5-flash') return { input: 0.3, output: 2.5, cached: 0.03, source: GEMINI };
  if (model === 'gemini-2.5-flash-lite') return { input: 0.1, output: 0.4, cached: 0.01, source: GEMINI };
  if (model === 'gemini-2.5-pro' && usage.inputTokens !== undefined) return usage.inputTokens > 200_000
    ? { input: 2.5, output: 15, cached: 0.25, source: GEMINI } : { input: 1.25, output: 10, cached: 0.125, source: GEMINI };
  return undefined;
}

/** Preserve provider auth/retries/TLS and inspect only each response's accounting. */
export async function callInboxAssistantAI(
  config: AIProviderConfig, systemPrompt: string, prompt: string, signal?: AbortSignal,
  onUsage?: (usage: InboxAssistantAIUsage) => void,
): Promise<string> {
  const startedAt = Date.now();
  const id = randomUUID();
  const reports: ReportedUsage[] = [];
  let attempts = 0;
  let completed = false;
  const doFetch = config.fetchImpl ?? fetch;
  const tracked: AIProviderConfig = { ...config, fetchImpl: async (input, init) => {
    attempts++;
    const slot = reports.length;
    reports.push({});
    const response = await doFetch(input, init);
    // Observe the same JSON read core already performs. Avoid cloning/reading
    // the body twice, changing request semantics or delaying an OAuth refresh.
    return new Proxy(response, { get(target, property) {
      if (property === 'json') return async () => {
        const data: unknown = await target.json();
        reports[slot] = readInboxAssistantProviderUsage(data, config.type);
        return data;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  try {
    const text = await callAIWithRetry(tracked, systemPrompt, prompt, signal);
    completed = true;
    return text;
  } finally {
    const inputTokens = total(reports.map(report => report.inputTokens));
    const outputTokens = total(reports.map(report => report.outputTokens));
    const cachedInputTokens = total(reports.map(report => report.cachedInputTokens));
    const prices = reports.map(report => {
      const rate = rateFor(config, report);
      if (!rate || report.inputTokens === undefined || report.outputTokens === undefined
        || (report.cachedInputTokens ?? 0) > report.inputTokens) return undefined;
      const cached = report.cachedInputTokens ?? 0;
      return { amount: ((report.inputTokens - cached) * rate.input + cached * rate.cached + report.outputTokens * rate.output) / 1_000_000, source: rate.source };
    });
    const estimatedCostUsd = total(prices.map(price => price?.amount));
    const usage: InboxAssistantAIUsage = { id, provider: config.type, model: [...reports].reverse().find(report => report.model)?.model || config.model,
      status: completed ? 'completed' : signal?.aborted ? 'cancelled' : 'failed', startedAt, completedAt: Date.now(), attempts,
      inputTokens, outputTokens, cachedInputTokens, tokenSource: inputTokens !== undefined || outputTokens !== undefined ? 'provider' : 'unavailable',
      usageComplete: attempts > 0 && reports.every(report => report.inputTokens !== undefined && report.outputTokens !== undefined),
      estimatedCostUsd, costComplete: attempts > 0 && prices.every(price => price !== undefined),
      ...(estimatedCostUsd !== undefined ? { pricingSource: [...new Set(prices.flatMap(price => price ? [price.source] : []))].join(', '), pricingAsOf: PRICING_AS_OF } : {}) };
    // Persistence/UI accounting must never replace the provider's actual result.
    try { onUsage?.(usage); } catch { /* The request may have been removed. */ }
  }
}
