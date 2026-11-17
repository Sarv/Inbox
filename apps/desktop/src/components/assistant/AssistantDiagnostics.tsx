import { Stethoscope } from 'lucide-react';
import { useId, useState } from 'react';

import { useAppVersion } from '../../hooks/useAppVersion';
import type { InboxAssistantExchange } from '../../types/inbox-assistant';
import { hasInboxAssistantDiagnostics, inboxAssistantDiagnosticsReport, inboxAssistantDiagnosticsSummary } from '../../utils/inbox-assistant-diagnostics-report';
import { CopyButton } from '../CopyButton';

/**
 * How one answer was produced, and a report the user can copy and send when it
 * was wrong. Nothing leaves the device unless the user copies it. The report
 * holds no question, answer, mail or address; search words are added only when
 * the box is ticked. See inbox-assistant-diagnostics-report.ts.
 */
export function AssistantDiagnostics({ exchange }: { exchange: InboxAssistantExchange }) {
  const [includeSearchWords, setIncludeSearchWords] = useState(false);
  const appVersion = useAppVersion();
  const optionId = useId();
  if (!hasInboxAssistantDiagnostics(exchange)) return null;
  const summary = inboxAssistantDiagnosticsSummary(exchange);
  const hasSearchWords = !!exchange.diagnostics?.plan;
  return (
    <section aria-label="Answer diagnostics" className="space-y-3 border-t border-border pt-4 text-xs">
      <h4 className="flex items-center gap-2 font-medium"><Stethoscope aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />How this answer was produced</h4>
      {summary.length > 0 && <ul className="list-disc space-y-1.5 pl-4 text-muted-foreground">{summary.map((line, index) => <li key={index}>{line}</li>)}</ul>}
      <p className="text-muted-foreground">If this answer was wrong, copy the diagnostics and send them with your report. They contain counts and error types, not your question, the answer or any email.</p>
      {hasSearchWords && <label htmlFor={optionId} className="flex items-start gap-2 text-muted-foreground">
        <input id={optionId} type="checkbox" checked={includeSearchWords} onChange={event => setIncludeSearchWords(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" />
        <span>Include the search words. These come from your question.</span>
      </label>}
      <CopyButton
        label="Copy diagnostics"
        value={() => inboxAssistantDiagnosticsReport(exchange, { includeSearchWords, ...(appVersion ? { appVersion } : {}) })}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
      />
    </section>
  );
}
