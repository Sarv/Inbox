import { ChevronDown, Gauge } from 'lucide-react';

import type { InboxAssistantUsage } from '../../types/inbox-assistant';
import { readInboxAssistantAIWorkload } from '../../utils/inbox-assistant-workload';

export interface AssistantUsageProps {
  usage?: InboxAssistantUsage;
  variant?: 'answer' | 'conversation';
  compact?: boolean;
}

function validAmount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function tokenCount(value: number | null | undefined): string {
  return validAmount(value) && Number.isSafeInteger(value) ? value.toLocaleString('en-US') : 'Unavailable';
}

function money(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.000001) return '<$0.000001';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value);
}

function callStatus(status?: string): string | undefined {
  if (!status) return undefined;
  if (status === 'success' || status === 'completed') return 'Completed';
  if (status === 'cancelled' || status === 'canceled') return 'Cancelled';
  if (status === 'failed' || status === 'error') return 'Failed';
  return status;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function WorkloadDetails({ value }: { value: unknown }) {
  const workload = readInboxAssistantAIWorkload(value);
  if (!workload) return null;
  const savedChars = workload.originalContentChars - workload.submittedContentChars;
  return <span aria-label="Unread review workload" className="mt-1 block space-y-0.5 text-[11px] leading-4">
    <span className="block text-foreground">Unread review · {plural(workload.conversationCount, 'conversation')} · {plural(workload.messageCount, 'email')}</span>
    <span className="block">Content: {savedChars > 0 ? `${tokenCount(workload.originalContentChars)} → ` : ''}{tokenCount(workload.submittedContentChars)} characters{savedChars > 0 ? ` · ${tokenCount(savedChars)} fewer` : ''}</span>
    {workload.reusedQuotedTurns > 0 && <span className="block">{plural(workload.reusedQuotedTurns, 'quoted passage')} shared</span>}
  </span>;
}

/** One display for answer usage and the complete conversation call ledger. */
export function AssistantUsage({ usage, variant = 'answer', compact = false }: AssistantUsageProps) {
  const calls = usage?.calls ?? [];
  const tokenCountsComplete = usage?.tokenCountsComplete === true;
  const estimatedCost = usage?.estimatedCostUsd;
  const costKnown = validAmount(estimatedCost);
  const title = variant === 'conversation' ? 'Conversation usage' : 'Answer usage';
  const inputText = `${!tokenCountsComplete && tokenCount(usage?.inputTokens) !== 'Unavailable' ? '≥ ' : ''}${tokenCount(usage?.inputTokens)}`;
  const outputText = `${!tokenCountsComplete && tokenCount(usage?.outputTokens) !== 'Unavailable' ? '≥ ' : ''}${tokenCount(usage?.outputTokens)}`;
  const costText = costKnown ? `${money(estimatedCost)}${usage?.costComplete ? '' : ' + unknown'}` : 'Unavailable';
  const incompleteTokens = calls.filter(call => !call.usageComplete).length;
  const incompleteCosts = calls.filter(call => !call.costComplete).length;
  return (
    <details aria-label={title} className={`group min-w-0 rounded-lg border border-border bg-background text-xs text-muted-foreground ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5 font-medium text-foreground"><Gauge aria-hidden="true" className="h-3.5 w-3.5" />{title}</span>
        <span aria-label={`Input tokens: ${inputText.replace('≥ ', 'at least ')}`} className="tabular-nums">Input <span className="text-foreground">{inputText}</span></span>
        <span aria-label={`Output tokens: ${outputText.replace('≥ ', 'at least ')}`} className="tabular-nums">Output <span className="text-foreground">{outputText}</span></span>
        <span aria-label={`Estimated cost in USD: ${costText}`} className="tabular-nums">Est. <span className="text-foreground">{costText}</span></span>
        <ChevronDown aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 min-w-0 space-y-3 border-t border-border pt-3">
        {calls.length === 0 ? <p>{usage ? 'No usage recorded.' : `Usage was not recorded for this ${variant === 'conversation' ? 'conversation' : 'answer'}.`}</p> : <>
          <p>{plural(calls.length, 'recorded AI call')} · All recorded calls are included.</p>
          {validAmount(usage?.cachedInputTokens) && <p>{tokenCount(usage?.cachedInputTokens)} cached input tokens, included in input.</p>}
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <caption className="sr-only">{title} by provider and model</caption>
              <thead><tr className="border-b border-border"><th scope="col" className="pb-2 pr-3 font-medium">Provider / model</th><th scope="col" className="pb-2 pr-3 text-right font-medium">Input</th><th scope="col" className="pb-2 pr-3 text-right font-medium">Output</th><th scope="col" className="pb-2 text-right font-medium">Est. USD</th></tr></thead>
              <tbody>{calls.map((call, index) => <tr key={`${call.id}:${index}`} className="border-b border-border/60 last:border-0">
                <th scope="row" className="min-w-0 py-2 pr-3 font-normal [overflow-wrap:anywhere]"><span className="block font-medium text-foreground">{call.provider || 'Provider unavailable'}</span><span className="block">{call.model || 'Model unavailable'}</span><span className="mt-0.5 block text-[11px]">{callStatus(call.status)}{call.attempts > 1 ? ` · ${plural(call.attempts, 'attempt')}` : ''}</span><WorkloadDetails value={call.workload} />{validAmount(call.cachedInputTokens) && <span className="mt-0.5 block text-[11px]">{tokenCount(call.cachedInputTokens)} cached input tokens</span>}{call.pricingSource && <span className="mt-0.5 block text-[11px]">Pricing: {call.pricingSource}{call.pricingAsOf ? ` · ${call.pricingAsOf}` : ''}</span>}</th>
                <td className="py-2 pr-3 text-right tabular-nums">{!call.usageComplete && tokenCount(call.inputTokens) !== 'Unavailable' ? '≥ ' : ''}{tokenCount(call.inputTokens)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{!call.usageComplete && tokenCount(call.outputTokens) !== 'Unavailable' ? '≥ ' : ''}{tokenCount(call.outputTokens)}</td>
                <td className="py-2 text-right tabular-nums">{validAmount(call.estimatedCostUsd) ? `${money(call.estimatedCostUsd)}${call.costComplete ? '' : ' + unknown'}` : 'Unavailable'}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {calls.some(call => readInboxAssistantAIWorkload(call.workload)) && <p>Content characters describe the email text, not token estimates. Input and output tokens are reported by the provider.</p>}
          {!tokenCountsComplete && <p>Token usage is incomplete{incompleteTokens > 0 ? ` for ${plural(incompleteTokens, 'recorded call')}` : ''}. Totals include only reported usage.</p>}
          {!usage?.costComplete && <p>Cost is unavailable or incomplete{incompleteCosts > 0 ? ` for ${plural(incompleteCosts, 'recorded call')}` : ''}. {costKnown ? 'The displayed estimate includes only priced usage.' : 'Missing prices are not counted as zero.'}</p>}
          {costKnown && <p>Estimated provider cost in USD.</p>}
        </>}
      </div>
    </details>
  );
}
