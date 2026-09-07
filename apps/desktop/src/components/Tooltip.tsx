import { useState, useRef, useEffect, useCallback, ReactNode } from 'react';

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
 * IconButton with built-in tooltip - shows immediately
 */
interface IconButtonProps {
  onClick?: () => void;
  icon: ReactNode;
  tooltip: string;
  shortcut?: string | string[];
  className?: string;
  disabled?: boolean;
}

export function IconButton({ onClick, icon, tooltip, shortcut, className = '', disabled = false }: IconButtonProps) {
  return (
    <Tooltip content={tooltip} shortcut={shortcut}>
      <button
        onClick={onClick}
        disabled={disabled}
        className={`p-2 hover:bg-accent rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
