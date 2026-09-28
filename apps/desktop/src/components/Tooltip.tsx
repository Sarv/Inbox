import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type AriaAttributes,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';

interface TooltipProps {
  children: ReactNode;
  content: ReactNode;
  shortcut?: string | string[];
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  hidden?: boolean;
  /** Delay before the tooltip appears on hover (ms). Default 150ms. */
  delayMs?: number;
  /** Max width before wrapping (px). If set, turns off whitespace-nowrap. */
  maxWidth?: number;
}

/**
 * Custom tooltip component that shows immediately on hover.
 * Positions just below the trigger element so it never covers the button.
 * Supports optional keyboard shortcut hints rendered as styled kbd badges.
 * Pass a string[] for multiple shortcuts separated by "or".
 * Set hidden=true to suppress tooltip (e.g. when a dropdown is open).
 */
export function Tooltip({ children, content, shortcut, className, hidden, delayMs = 150, maxWidth }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shortcuts = shortcut
    ? Array.isArray(shortcut) ? shortcut.filter(Boolean) : shortcut ? [shortcut] : []
    : [];

  // When hidden becomes true (e.g. dropdown opened), reset visibility
  useEffect(() => {
    if (hidden) {
      setIsVisible(false);
      if (delayTimer.current) { clearTimeout(delayTimer.current); delayTimer.current = null; }
    }
  }, [hidden]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (delayTimer.current) clearTimeout(delayTimer.current); };
  }, []);

  // Position tooltip below the trigger element after it renders
  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const padding = 8;

      // Place just below the trigger element
      let top = triggerRect.bottom + 6;
      let left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;

      // Keep within viewport horizontally
      if (left < padding) left = padding;
      if (left + tooltipRect.width > window.innerWidth - padding) {
        left = window.innerWidth - tooltipRect.width - padding;
      }
      // If goes below viewport, flip above trigger
      if (top + tooltipRect.height > window.innerHeight - padding) {
        top = triggerRect.top - tooltipRect.height - 6;
      }

      setCoords({ top, left });
    } else {
      setCoords(null);
    }
  }, [isVisible]);

  return (
    <div
      ref={triggerRef}
      className={className || "inline-flex"}
      onMouseEnter={useCallback(() => {
        delayTimer.current = setTimeout(() => setIsVisible(true), delayMs);
      }, [delayMs])}
      onMouseLeave={useCallback(() => {
        if (delayTimer.current) { clearTimeout(delayTimer.current); delayTimer.current = null; }
        setIsVisible(false); setCoords(null);
      }, [])}
    >
      {children}
      {isVisible && !hidden && (content || shortcuts.length > 0) && (
        <div
          ref={tooltipRef}
          className={`fixed z-[9999] flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md shadow-lg pointer-events-none ${maxWidth ? '' : 'whitespace-nowrap'}`}
          style={{
            top: coords ? coords.top : -9999,
            left: coords ? coords.left : -9999,
            maxWidth: maxWidth ? `${maxWidth}px` : undefined,
          }}
        >
          {content && <span>{content}</span>}
          {shortcuts.length > 0 && (
            <span className="inline-flex items-center gap-1">
              {shortcuts.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-gray-400 text-[10px]">or</span>}
                  <kbd className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono font-semibold bg-gray-700 dark:bg-gray-600 text-gray-200 rounded border border-gray-600 dark:border-gray-500">
                    {s}
                  </kbd>
                </span>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Padding per size: 'md' for a toolbar, 'sm' for a compact control on a header
 * line (the List/Chat switch), 'xs' for one that sits on content (a chat
 * bubble's corner).
 */
const ICON_BUTTON_PADDING = { md: 'p-2', sm: 'p-1.5', xs: 'p-1' } as const;

/**
 * How the button is drawn, beyond its padding:
 *  - 'ghost' — no background until hovered; the usual icon button.
 *  - 'bare'  — nothing: the caller's `className` draws it. For a button whose
 *    colours carry state (a selected segment, a warning tint), where a ghost
 *    hover background would fight the caller's own — two background utilities
 *    on one element leave the winner to stylesheet order.
 */
const ICON_BUTTON_LOOK = {
  ghost: 'hover:bg-accent rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
  bare: '',
} as const;

interface IconButtonProps {
  /** Receives the click, so a button inside a clickable surface can stop it. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  icon: ReactNode;
  /** What the button does. It is the tooltip AND the accessible name — one
   *  string, so what a sighted reader hovers and what a screen reader
   *  announces can never disagree. */
  tooltip: string;
  shortcut?: string | string[];
  className?: string;
  disabled?: boolean;
  /** Hover delay before the tooltip shows. Defaults to the project's 40ms: an
   *  icon-only control is unreadable until its name feels instant. */
  delayMs?: number;
  size?: keyof typeof ICON_BUTTON_PADDING;
  variant?: keyof typeof ICON_BUTTON_LOOK;
  /** A toggle's state (`aria-pressed`) — for a button whose NAME stays the
   *  same whichever way it is set, such as one segment of a switch. Left out,
   *  the button is a plain action and carries no pressed state at all. */
  pressed?: boolean;
  /** The button element — for a caller that measures it or returns focus to
   *  it (a menu trigger). */
  ref?: Ref<HTMLButtonElement>;
  /** Suppress the tooltip while something the button opened covers it (its
   *  menu). The name stays on `aria-label` either way. */
  tooltipHidden?: boolean;
  /** For a button that opens something (a menu): what it opens, whether that
   *  is open, and its id. */
  'aria-haspopup'?: AriaAttributes['aria-haspopup'];
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}

/**
 * An icon-only button that always carries its name: the shared Tooltip on
 * hover and the same string as its `aria-label`. The UI convention requires
 * both on every icon-only control, so build them from here rather than pairing
 * a Tooltip and a button by hand.
 */
export function IconButton({
  onClick,
  icon,
  tooltip,
  shortcut,
  className = '',
  disabled = false,
  delayMs = 40,
  size = 'md',
  variant = 'ghost',
  pressed,
  ref,
  tooltipHidden,
  'aria-haspopup': ariaHasPopup,
  'aria-expanded': ariaExpanded,
  'aria-controls': ariaControls,
}: IconButtonProps) {
  return (
    <Tooltip content={tooltip} shortcut={shortcut} delayMs={delayMs} hidden={tooltipHidden}>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={tooltip}
        aria-pressed={pressed}
        aria-haspopup={ariaHasPopup}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        className={[ICON_BUTTON_PADDING[size], ICON_BUTTON_LOOK[variant], className].filter(Boolean).join(' ')}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
