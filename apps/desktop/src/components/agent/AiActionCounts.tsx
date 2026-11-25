import { AI_ACTION_KINDS, describeAiAction, type AiActionKind } from '@sarvinbox/core/ai-actions';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Tooltip } from '../Tooltip';

export interface AiActionCountsData {
  byKind: Record<AiActionKind, number>;
  /** Emails the AI changed at least once. */
  emails: number;
  /** Emails the AI has categorized (counted, never shown as an icon). */
  categorized: number;
}

/** The kinds with a count, largest first; the order of AI_ACTION_KINDS breaks ties. */
export function aiActionCountRows(data: AiActionCountsData): Array<{ kind: AiActionKind; count: number }> {
  return AI_ACTION_KINDS
    .map((kind, order) => ({ kind, count: data.byKind[kind] ?? 0, order }))
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map(({ kind, count }) => ({ kind, count }));
}

/** The AI section's tally of what the AI did to mail in this account, from each email's own record. */
export function AiActionCountsView({ data }: { data: AiActionCountsData }) {
  const rows = aiActionCountRows(data);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <section aria-label="What the AI did" className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold">What the AI did</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          {total.toLocaleString()} {total === 1 ? 'action' : 'actions'} on {data.emails.toLocaleString()} {data.emails === 1 ? 'email' : 'emails'}
        </span>
      </div>
      {rows.length === 0
        ? <p className="text-xs text-muted-foreground">The AI has not changed any email yet. Emails it changes get a <Sparkles className="inline h-3 w-3 text-violet-500" aria-hidden="true" /> in the list.</p>
        : (
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
            {rows.map(row => (
              <li key={row.kind} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{describeAiAction(row.kind)}</span>
                <span className="font-medium tabular-nums">{row.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      <Tooltip content="Sorting into categories is counted here but gets no icon in the list: the AI sorts nearly every email." delayMs={40} maxWidth={280}>
        <p className="mt-3 text-xs text-muted-foreground">Categorized {data.categorized.toLocaleString()} {data.categorized === 1 ? 'email' : 'emails'}</p>
      </Tooltip>
    </section>
  );
}

/** Loads the counts for the active account; `refreshKey` changing loads them again. Nothing while loading or on failure. */
export function AiActionCounts({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<AiActionCountsData | null>(null);
  useEffect(() => {
    let live = true;
    const load = window.electronAPI?.agent?.getAiActionCounts;
    if (!load) return;
    load().then(result => { if (live && result?.success && result.data) setData(result.data); }, () => { /* The section stays as it was. */ });
    return () => { live = false; };
  }, [refreshKey]);
  return data ? <AiActionCountsView data={data} /> : null;
}
