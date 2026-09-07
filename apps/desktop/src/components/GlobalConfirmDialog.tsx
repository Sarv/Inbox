import { useConfirmStore } from '../store/confirm-service';

import { ConfirmDialogView } from './ConfirmDialog';

/**
 * Renders the single app-wide confirmation dialog backed by
 * {@link useConfirmStore}. Mount once at the app root. Any code (including
 * store slices) can raise a prompt via `requestConfirm(...)`.
 */
export function GlobalConfirmDialog() {
  const current = useConfirmStore((s) => s.current);
  const resolve = useConfirmStore((s) => s.resolve);

  if (!current) return null;

  return (
    <ConfirmDialogView
      {...current}
      onConfirm={() => resolve(true)}
      onCancel={() => resolve(false)}
    />
  );
}
