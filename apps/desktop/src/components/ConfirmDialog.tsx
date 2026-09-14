import { useCallback, useEffect, useState } from 'react';

/**
 * Which button the user pressed. `cancel` also covers Escape and a backdrop
 * click, so a dismissed dialog is never mistaken for a choice.
 */
export type ConfirmChoice = 'confirm' | 'secondary' | 'cancel';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action (red). Default true. */
  destructive?: boolean;
  /**
   * Optional THIRD button, for a question with two real answers rather than a
   * yes/no — "download 500 now" vs "download all 4,000". Omit it and the dialog
   * is the usual two-button confirm.
   *
   * Only {@link useConfirm().choose} can report it; `confirm()` keeps its
   * boolean contract and reads anything but the primary as "no".
   */
  secondaryLabel?: string;
}

interface DialogState extends ConfirmOptions {
  open: boolean;
  resolve?: (choice: ConfirmChoice) => void;
}

/**
 * Reusable, promise-based confirmation dialog.
 *
 *   const { confirm, confirmDialog } = useConfirm();
 *   ...
 *   if (!(await confirm({ message: 'Delete this filter?' }))) return;
 *   ...
 *   return <>{confirmDialog}{rest}</>;
 *
 * Backdrop click and Escape cancel; Enter confirms.
 */
export function useConfirm() {
  const [state, setState] = useState<DialogState>({ open: false, message: '' });

  /** Ask a question with up to three answers. */
  const choose = useCallback((opts: ConfirmOptions) => {
    return new Promise<ConfirmChoice>((resolve) => {
      setState({ ...opts, open: true, resolve });
    });
  }, []);

  /** The yes/no form. Anything but the primary button is a "no". */
  const confirm = useCallback(
    (opts: ConfirmOptions) => choose(opts).then((c) => c === 'confirm'),
    [choose],
  );

  const close = useCallback((choice: ConfirmChoice) => {
    setState((s) => {
      s.resolve?.(choice);
      return { ...s, open: false, resolve: undefined };
    });
  }, []);

  const confirmDialog = state.open ? (
    <ConfirmDialogView
      {...state}
      onConfirm={() => close('confirm')}
      onSecondary={() => close('secondary')}
      onCancel={() => close('cancel')}
    />
  ) : null;

  return { confirm, choose, confirmDialog };
}

export function ConfirmDialogView({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  secondaryLabel,
  onConfirm,
  onSecondary,
  onCancel,
}: ConfirmOptions & {
  onConfirm: () => void;
  onCancel: () => void;
  onSecondary?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onConfirm, onCancel]);

  // z-300: a confirmation is always raised BY something — often a z-200 overlay
  // such as the add-account wizard — so it must outrank every other overlay
  // rather than tie with them and depend on DOM order to paint on top.
  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h3 className="text-base font-semibold mb-2">{title}</h3>}
        {/* pre-line so callers can separate paragraphs with \n\n; single-line
            messages are unaffected. */}
        <p className="text-sm text-muted-foreground whitespace-pre-line">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-sm font-medium border border-border hover:bg-muted/50 transition-colors"
          >
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              onClick={onSecondary}
              className="px-3 py-1.5 rounded-md text-sm font-medium border border-border hover:bg-muted/50 transition-colors"
            >
              {secondaryLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            autoFocus
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
