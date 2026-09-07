import { useCallback, useEffect, useState } from 'react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action (red). Default true. */
  destructive?: boolean;
}

interface DialogState extends ConfirmOptions {
  open: boolean;
  resolve?: (confirmed: boolean) => void;
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

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, open: true, resolve });
    });
  }, []);

  const close = useCallback((confirmed: boolean) => {
    setState((s) => {
      s.resolve?.(confirmed);
      return { ...s, open: false, resolve: undefined };
    });
  }, []);

  const confirmDialog = state.open ? (
    <ConfirmDialogView
      {...state}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;

  return { confirm, confirmDialog };
}

export function ConfirmDialogView({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
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
