import { describeAiAction, iconAiActions, type AiAction } from '@sarvinbox/core/ai-actions';
import { format } from 'date-fns';
import { Sparkles } from 'lucide-react';

import { Tooltip } from '../Tooltip';

/** Lines a tooltip lists before folding the rest into "and N earlier". */
const SHOWN = 5;

/** What the AI did across a conversation's emails, oldest first, icon-worthy kinds only. */
export function threadAiActions(emails: ReadonlyArray<{ aiActions?: AiAction[] }>): AiAction[] {
  return emails.flatMap(email => iconAiActions(email.aiActions)).sort((a, b) => a.at - b.at);
}

function line(action: AiAction): string {
  return `${describeAiAction(action.kind)} · ${action.auto ? 'automatically' : 'you approved'} · ${format(new Date(action.at * 1000), 'd MMM, h:mm a')}`;
}

/**
 * The small AI mark on a list row: something on this conversation was done by
 * the AI. Pointing at it lists what, when, and whether it was automatic or
 * approved by the user, newest first. Nothing at all when the AI did nothing
 * worth an icon (categorizing alone is not: see aiActionShowsIcon).
 */
export function AiActionsIcon({ emails, className = '' }: { emails: ReadonlyArray<{ aiActions?: AiAction[] }>; className?: string }) {
  const actions = threadAiActions(emails);
  if (!actions.length) return null;
  const newestFirst = [...actions].reverse();
  const shown = newestFirst.slice(0, SHOWN);
  const earlier = newestFirst.length - shown.length;
  const label = `Done by AI: ${shown.map(action => describeAiAction(action.kind)).join(', ')}${earlier ? `, and ${earlier} earlier` : ''}`;
  return (
    <Tooltip
      delayMs={40}
      maxWidth={300}
      content={
        <span className="flex flex-col gap-0.5 text-left">
          <span className="font-semibold">Done by AI</span>
          {shown.map((action, index) => <span key={`${action.at}:${action.kind}:${index}`}>{line(action)}</span>)}
          {earlier > 0 && <span className="text-gray-300">and {earlier} earlier</span>}
        </span>
      }
    >
      <span role="img" aria-label={label} className={`inline-flex shrink-0 items-center text-violet-500 dark:text-violet-400 ${className}`}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
