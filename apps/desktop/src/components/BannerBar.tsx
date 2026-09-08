import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The shared shell every status banner in the app draws itself with: a full-
 * width strip under the header carrying an icon, one line of copy, its actions
 * and an optional dismiss.
 *
 * Extracted because the markup and the exact tone classes were being copied per
 * banner, which is how two of them end up subtly different widths or paddings
 * after an unrelated edit. Purely presentational — every banner keeps its own
 * visibility rules; this only draws them.
 */
export type BannerTone = 'warning' | 'danger';

const TONE_CLASSES: Record<BannerTone, string> = {
  warning:
    'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300',
  danger: 'bg-destructive/10 border-destructive/30 text-destructive',
};

/** Hover fill for a control sitting ON the strip, matched to its tone. */
const TONE_HOVER: Record<BannerTone, string> = {
  warning: 'hover:bg-amber-500/20',
  danger: 'hover:bg-destructive/15',
};

export function BannerBar({
  tone,
  icon,
  children,
  actions,
  onDismiss,
  dismissTitle = 'Dismiss',
}: {
  tone: BannerTone;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  /** Says what dismissing costs — a banner is hidden, not fixed. */
  dismissTitle?: string;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-2 border-b text-sm ${TONE_CLASSES[tone]}`}
      role="status"
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {actions}
      {onDismiss && (
        <button
          onClick={onDismiss}
          className={`p-1 rounded transition-colors flex-shrink-0 ${TONE_HOVER[tone]}`}
          title={dismissTitle}
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
