import { AlertCircle, Check, Copy } from 'lucide-react';

import { useCopyToClipboard } from '../hooks/useCopyToClipboard';

import { Tooltip } from './Tooltip';

interface CopyButtonProps {
  /**
   * The text to copy. Pass a function when the value is built lazily or is
   * still loading at render time — it is read at click time, not before.
   */
  value: string | (() => string);
  /** Resting label. Also the tooltip/aria-label in `iconOnly` mode. */
  label?: string;
  copiedLabel?: string;
  errorLabel?: string;
  /** Render the icon alone (with a tooltip), for toolbars and headers. */
  iconOnly?: boolean;
  /** Replaces the default button classes entirely. */
  className?: string;
  disabled?: boolean;
  /**
   * Fired only after the text actually reached the clipboard. A failed copy
   * must not trigger whatever the caller does next (an extension marking the
   * mail read, say) — the user has nothing in hand to show for it.
   */
  onCopied?: () => void;
}

/**
 * THE copy-to-clipboard button. Every surface that offers "copy this" uses it,
 * so the acknowledgement — icon and label flipping to "Copied!", or to
 * "Copy failed" when the clipboard refuses — looks and behaves the same
 * everywhere instead of being re-invented (or forgotten) per call site.
 */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied!',
  errorLabel = 'Copy failed',
  iconOnly = false,
  className,
  disabled = false,
  onCopied,
}: CopyButtonProps) {
  const { status, copy } = useCopyToClipboard();

  const text = status === 'copied' ? copiedLabel : status === 'error' ? errorLabel : label;
  const Icon = status === 'copied' ? Check : status === 'error' ? AlertCircle : Copy;
  const stateClass =
    status === 'copied'
      ? 'text-green-600 dark:text-green-400'
      : status === 'error'
        ? 'text-destructive'
        : '';

  const handleClick = () => {
    void copy(typeof value === 'function' ? value() : value).then((copied) => {
      if (!copied) return;
      // The callback belongs to the caller, and a caller that throws must not
      // turn into an unhandled rejection inside the button: the text is already
      // on the clipboard and the acknowledgement still has to appear.
      try {
        onCopied?.();
      } catch {
        /* the caller's problem, not the copy's */
      }
    });
  };

  const button = (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={text}
      className={
        className ??
        (iconOnly
          ? `p-1.5 rounded-md hover:bg-accent transition-colors disabled:opacity-50 ${stateClass}`
          : `inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-muted hover:bg-accent rounded-md transition-colors disabled:opacity-50 ${stateClass}`)
      }
    >
      <Icon className="h-4 w-4" />
      {!iconOnly && <span>{text}</span>}
      {/* The label change is visual; screen readers get it from this live region. */}
      <span className="sr-only" aria-live="polite">
        {status === 'idle' ? '' : text}
      </span>
    </button>
  );

  // Icon-only controls must name themselves on hover (shared Tooltip, not the
  // slow native `title`) — and after a click the tooltip carries the result.
  return iconOnly ? (
    <Tooltip content={text} delayMs={40}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
