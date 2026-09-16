import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'copied' | 'error';

/** How long the "Copied" / "Copy failed" acknowledgement stays up (ms). */
export const COPY_FEEDBACK_MS = 1800;

/**
 * The clipboard half of every copy affordance in the app: write the text, then
 * report what happened for long enough that the user can see it.
 *
 * A copy button with no acknowledgement is indistinguishable from a dead one —
 * the clipboard is invisible, so the click has to say something. Keep this the
 * only place that state machine lives; render it with `CopyButton`.
 *
 * `navigator.clipboard` is absent in a non-secure context and can reject when
 * the document is not focused, so a failure is a normal outcome, not a crash:
 * it surfaces to the user as an 'error' status rather than being swallowed.
 */
export function useCopyToClipboard(resetAfterMs: number = COPY_FEEDBACK_MS) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  }, []);

  // The reset timer must not outlive the mount, or it fires into a dead tree.
  useEffect(() => clearResetTimer, [clearResetTimer]);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      clearResetTimer();
      let copied = false;
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
      setStatus(copied ? 'copied' : 'error');
      resetTimer.current = setTimeout(() => setStatus('idle'), resetAfterMs);
      return copied;
    },
    [clearResetTimer, resetAfterMs],
  );

  return { status, copy };
}
