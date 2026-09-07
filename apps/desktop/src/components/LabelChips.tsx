import { X } from 'lucide-react';

import { readableTextColor } from '../config/label-colors';
import { useEmailStore } from '../store/email-store';

interface LabelChipsProps {
  tags?: string | null;
  className?: string;
  /** When provided, each chip gets an X that calls this with the label name. */
  onRemove?: (name: string) => void;
  /**
   * Visual weight of the chips:
   * - `soft` (default): light tinted background + colored text. Calm — used in
   *   the reading pane where labels sit under the subject.
   * - `solid`: filled pill in the label's color with auto-contrast text. Bold
   *   and eye-catching — used in the email list so labels pop before the subject.
   */
  variant?: 'soft' | 'solid';
}

/**
 * Renders colored chips for every user label present in an email's tags.
 * (Only names that exist in the labels registry render — folder/flag/category
 * tags are ignored.) Pass `onRemove` to make each chip removable (X button).
 */
export function LabelChips({ tags, className, onRemove, variant = 'soft' }: LabelChipsProps) {
  const labels = useEmailStore((s) => s.labels);
  if (!tags) return null;
  const applied = labels.filter((l) => tags.includes('|' + l.name + '|'));
  if (applied.length === 0) return null;
  const isSolid = variant === 'solid';
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className ?? ''}`}>
      {applied.map((l) => (
        <span
          key={l.id}
          className={
            isSolid
              ? 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold leading-none whitespace-nowrap'
              : 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none'
          }
          style={
            isSolid
              ? { backgroundColor: l.color, color: readableTextColor(l.color) }
              : { backgroundColor: `${l.color}22`, color: l.color }
          }
        >
          {l.name}
          {onRemove && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(l.name); }}
              aria-label={`Remove label ${l.name}`}
              className={`-mr-0.5 rounded-full p-0.5 ${isSolid ? 'hover:bg-black/20' : 'hover:bg-black/10 dark:hover:bg-white/10'}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </span>
      ))}
    </span>
  );
}
