import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

/** The account dropdown's shared visual control in Mail and Inbox Agent. */
export function AccountSelectorTrigger({ label, secondaryLabel, avatar, indicator, expanded, controls, disabled, title, onClick }: {
  label: string;
  secondaryLabel?: string;
  avatar: ReactNode;
  indicator?: ReactNode;
  expanded?: boolean;
  controls?: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} aria-expanded={expanded} aria-controls={controls}
      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md border border-border hover:bg-accent/50 text-left transition-colors disabled:opacity-50">
      {avatar}
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {secondaryLabel && <span className="block truncate text-[11px] text-muted-foreground">{secondaryLabel}</span>}
      </span>
      {indicator}
      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}
