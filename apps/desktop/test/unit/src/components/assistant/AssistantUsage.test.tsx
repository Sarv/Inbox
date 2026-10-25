// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { AssistantUsage } from '../../../../../src/components/assistant/AssistantUsage';
import type { InboxAssistantAIUsage, InboxAssistantAIWorkload, InboxAssistantUsage } from '../../../../../src/types/inbox-assistant';
import { cleanup, render } from '../../../../helpers/render';

function call(id = 'call-one', changes: Partial<InboxAssistantAIUsage> = {}): InboxAssistantAIUsage {
  return {
    id, provider: 'Test provider', model: 'test-model', status: 'completed', startedAt: 1000, completedAt: 2000,
    attempts: 1, inputTokens: 1000, outputTokens: 250, tokenSource: 'provider', usageComplete: true,
    estimatedCostUsd: 0.00125, costComplete: true, ...changes,
  };
}

function usage(changes: Partial<InboxAssistantUsage> = {}): InboxAssistantUsage {
  return { calls: [call()], inputTokens: 1000, outputTokens: 250, tokenCountsComplete: true, estimatedCostUsd: 0.00125, costComplete: true, currency: 'USD', ...changes };
}

afterEach(cleanup);

describe('Assistant usage accounting', () => {
  it('shows how many conversations and emails one unread-review call covered without treating characters as tokens', () => {
    const workload: InboxAssistantAIWorkload = { operation: 'unread_review', conversationCount: 16, messageCount: 23,
      originalContentChars: 40_000, submittedContentChars: 25_000, reusedQuotedTurns: 7 };
    const view = render(<AssistantUsage usage={usage({ calls: [call('review', { workload })] })} />);
    expect(view.byLabel('Unread review workload')?.textContent).toContain('Unread review · 16 conversations · 23 emails');
    expect(view.container.textContent).toContain('Content: 40,000 → 25,000 characters · 15,000 fewer');
    expect(view.container.textContent).toContain('7 quoted passages shared');
    expect(view.container.textContent).toContain('Content characters describe the email text, not token estimates.');
    expect(view.byLabel('Input tokens: 1,000')).not.toBeNull();
    expect(view.byLabel('Output tokens: 250')).not.toBeNull();
    expect(view.byLabel('Input tokens: 25,000')).toBeNull();
  });

  it('uses singular counts and does not claim savings when the complete content was submitted', () => {
    const workload: InboxAssistantAIWorkload = { operation: 'unread_review', conversationCount: 1, messageCount: 1,
      originalContentChars: 1_234, submittedContentChars: 1_234, reusedQuotedTurns: 0 };
    const view = render(<AssistantUsage compact usage={usage({ calls: [call('review', { workload })] })} />);
    expect(view.container.textContent).toContain('Unread review · 1 conversation · 1 email');
    expect(view.container.textContent).toContain('Content: 1,234 characters');
    expect(view.container.textContent).not.toContain('fewer');
    expect(view.container.textContent).not.toContain('quoted passage');
  });

  it.each([
    undefined, { operation: 'other' }, { operation: 'unread_review', conversationCount: -1, messageCount: 1 },
    { operation: 'unread_review', conversationCount: 17, messageCount: 17, originalContentChars: 100, submittedContentChars: 100, reusedQuotedTurns: 0 },
    { operation: 'unread_review', conversationCount: 2, messageCount: 1, originalContentChars: 100, submittedContentChars: 100, reusedQuotedTurns: 0 },
    { operation: 'unread_review', conversationCount: 1, messageCount: 1, originalContentChars: 100, submittedContentChars: 101, reusedQuotedTurns: 0 },
    { operation: 'unread_review', conversationCount: 1, messageCount: 1, originalContentChars: 100, submittedContentChars: 50, reusedQuotedTurns: NaN },
  ])('does not fabricate workload for old or malformed records: %j', workload => {
    const view = render(<AssistantUsage usage={usage({ calls: [call('legacy', { workload: workload as InboxAssistantAIWorkload })] })} />);
    expect(view.byLabel('Unread review workload')).toBeNull();
    expect(view.container.textContent).not.toContain('Content characters');
    expect(view.byLabel('Input tokens: 1,000')).not.toBeNull();
    expect(view.byLabel('Output tokens: 250')).not.toBeNull();
  });

  it('shows answer input and output tokens with estimated USD cost and provider/model details', () => {
    const view = render(<AssistantUsage usage={usage()} />);
    expect(view.byLabel('Answer usage')).not.toBeNull();
    expect(view.byLabel('Input tokens: 1,000')?.textContent).toContain('Input 1,000');
    expect(view.byLabel('Output tokens: 250')?.textContent).toContain('Output 250');
    expect(view.byLabel('Estimated cost in USD: $0.00125')?.textContent).toContain('Est. $0.00125');
    expect(view.find('summary')).not.toBeNull();
    expect(view.container.textContent).toContain('Test provider');
    expect(view.container.textContent).toContain('test-model');
    expect(view.container.textContent).toContain('Completed');
    expect(view.find('table caption')?.textContent).toBe('Answer usage by provider and model');
  });

  it('includes failed and cancelled recorded calls in conversation totals and details', () => {
    const calls = [call(), call('failed', { status: 'failed', inputTokens: 500, outputTokens: 0, estimatedCostUsd: 0.0005 }),
      call('cancelled', { status: 'cancelled', inputTokens: 700, outputTokens: 100, estimatedCostUsd: 0.0008 })];
    const view = render(<AssistantUsage variant="conversation" usage={usage({ calls, inputTokens: 2200, outputTokens: 350, estimatedCostUsd: 0.00255 })} />);
    expect(view.byLabel('Conversation usage')).not.toBeNull();
    expect(view.byLabel('Input tokens: 2,200')).not.toBeNull();
    expect(view.byLabel('Output tokens: 350')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: $0.00255')).not.toBeNull();
    expect(view.find('tbody')?.querySelectorAll('tr')).toHaveLength(3);
    expect(view.container.textContent).toContain('3 recorded AI calls');
    expect(view.container.textContent).toContain('Failed');
    expect(view.container.textContent).toContain('Cancelled');
    expect(view.container.textContent).toContain('All recorded calls are included.');
  });

  it('distinguishes missing usage from actual zero tokens and a known zero cost', () => {
    const view = render(<AssistantUsage />);
    expect(view.byLabel('Input tokens: Unavailable')).not.toBeNull();
    expect(view.byLabel('Output tokens: Unavailable')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: Unavailable')).not.toBeNull();
    expect(view.container.textContent).toContain('Usage was not recorded for this answer.');
    expect(view.container.textContent).not.toContain('$0.00');
    view.rerender(<AssistantUsage usage={usage({ calls: [call('zero', { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })} />);
    expect(view.byLabel('Input tokens: 0')).not.toBeNull();
    expect(view.byLabel('Output tokens: 0')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: $0.00')).not.toBeNull();
    expect(view.container.textContent).not.toContain('Usage was not recorded');
  });

  it('shows known tokens with unavailable pricing rather than claiming a free request', () => {
    const view = render(<AssistantUsage usage={usage({ calls: [call('unknown-rate', { estimatedCostUsd: undefined, costComplete: false })], estimatedCostUsd: undefined, costComplete: false })} />);
    expect(view.byLabel('Input tokens: 1,000')).not.toBeNull();
    expect(view.byLabel('Output tokens: 250')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: Unavailable')).not.toBeNull();
    expect(view.container.textContent).toContain('Missing prices are not counted as zero.');
    expect(view.container.textContent).not.toContain('$0.00');
  });

  it('labels partial totals without omitting unreported failed usage or unpriced calls', () => {
    const calls = [call('known', { inputTokens: 600, outputTokens: 0, estimatedCostUsd: 0.0001 }),
      call('missing', { status: 'failed', tokenSource: 'unavailable', inputTokens: undefined, outputTokens: undefined, usageComplete: false, estimatedCostUsd: undefined, costComplete: false })];
    const view = render(<AssistantUsage usage={usage({ calls, inputTokens: 600, outputTokens: 0, tokenCountsComplete: false, estimatedCostUsd: 0.0001, costComplete: false })} />);
    expect(view.byLabel('Input tokens: at least 600')).not.toBeNull();
    expect(view.byLabel('Output tokens: at least 0')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: $0.0001 + unknown')).not.toBeNull();
    expect(view.container.textContent).toContain('Token usage is incomplete for 1 recorded call.');
    expect(view.container.textContent).toContain('Cost is unavailable or incomplete for 1 recorded call.');
    expect(view.container.textContent).toContain('The displayed estimate includes only priced usage.');
    expect(view.find('tbody')?.querySelectorAll('tr')).toHaveLength(2);
  });

  it('does not add cached tokens twice and exposes incomplete retry accounting and rate metadata', () => {
    const calls = [call('retried', { attempts: 3, inputTokens: 2000, outputTokens: 100, cachedInputTokens: 1500,
      usageComplete: false, estimatedCostUsd: 0.0007, costComplete: false, pricingSource: 'Test rate sheet', pricingAsOf: '2026-10-19' })];
    const view = render(<AssistantUsage usage={usage({ calls, inputTokens: 2000, outputTokens: 100, cachedInputTokens: 1500,
      tokenCountsComplete: false, estimatedCostUsd: 0.0007, costComplete: false })} />);
    expect(view.byLabel('Input tokens: at least 2,000')).not.toBeNull();
    expect(view.byLabel('Input tokens: at least 3,500')).toBeNull();
    expect(view.container.textContent).toContain('1,500 cached input tokens, included in input.');
    expect(view.container.textContent).toContain('3 attempts');
    expect(view.container.textContent).toContain('Test rate sheet');
    expect(view.container.textContent).toContain('2026-10-19');
    expect(view.find('tbody')?.textContent).toContain('≥ 2,000');
    expect(view.find('tbody')?.textContent).toContain('$0.0007 + unknown');
  });

  it('keeps legacy missing accounting distinct from an empty recorded ledger', () => {
    const view = render(<AssistantUsage variant="conversation" />);
    expect(view.container.textContent).toContain('Usage was not recorded for this conversation.');
    view.rerender(<AssistantUsage variant="conversation" usage={{ calls: [], tokenCountsComplete: false, costComplete: false, currency: 'USD' }} />);
    expect(view.container.textContent).toContain('No usage recorded.');
    expect(view.byLabel('Input tokens: Unavailable')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: Unavailable')).not.toBeNull();
    expect(view.container.textContent).not.toContain('$0.00');
  });

  it('does not present invalid negative or nonfinite values as valid usage or free cost', () => {
    const view = render(<AssistantUsage usage={usage({ calls: [call('invalid', { inputTokens: NaN, outputTokens: -1, cachedInputTokens: -10, estimatedCostUsd: Infinity, usageComplete: false, costComplete: false })],
      inputTokens: NaN, outputTokens: -1, cachedInputTokens: -10, estimatedCostUsd: Infinity, tokenCountsComplete: false, costComplete: false })} />);
    expect(view.byLabel('Input tokens: Unavailable')).not.toBeNull();
    expect(view.byLabel('Output tokens: Unavailable')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: Unavailable')).not.toBeNull();
    for (const invalid of ['NaN', 'Infinity', '-10', '$0.00']) expect(view.container.textContent).not.toContain(invalid);
  });

  it('shows small nonzero estimates without rounding them down to free and renders all provider metadata as text', () => {
    const view = render(<AssistantUsage compact usage={usage({ calls: [call('small', { provider: '<img src=x onerror=send()>', model: '<script>send()</script>', estimatedCostUsd: 0.0000001, pricingSource: '<a href=javascript:send()>rate</a>' })], estimatedCostUsd: 0.0000001 })} />);
    expect(view.byLabel('Estimated cost in USD: <$0.000001')).not.toBeNull();
    expect(view.byLabel('Estimated cost in USD: $0.00')).toBeNull();
    expect(view.container.textContent).toContain('<script>send()</script>');
    expect(view.container.textContent).toContain('<img src=x onerror=send()>');
    expect(view.find('img')).toBeNull();
    expect(view.find('script')).toBeNull();
    expect(view.find('a')).toBeNull();
    expect(view.byLabel('Answer usage')?.className).toContain('min-w-0');
  });
});
