import { create } from 'zustand';

import type { ConfirmOptions } from '../components/ConfirmDialog';

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmServiceState {
  current: PendingConfirm | null;
  request: (opts: ConfirmOptions) => Promise<boolean>;
  resolve: (confirmed: boolean) => void;
}

/**
 * App-wide, promise-based confirmation that can be triggered from ANYWHERE —
 * including non-React code such as store slices. `useConfirm()` is
 * component-scoped (its dialog only renders where it's mounted), which is why a
 * store method like `bulkRemoveEmails` can't use it. This global service backs
 * a single {@link GlobalConfirmDialog} mounted once at the app root, so a
 * dangerous action guarded in the store chokepoint prompts no matter which
 * entry point (list, toolbar, keyboard) triggered it.
 *
 * A second request replaces the visible prompt and cancels the prior request.
 * Hidden prompts must never leave an operation waiting for an unavailable choice.
 */
export const useConfirmStore = create<ConfirmServiceState>((set, get) => ({
  current: null,
  request: (opts) =>
    new Promise<boolean>((resolve) => {
      const previous = get().current;
      set({ current: { ...opts, resolve } });
      previous?.resolve(false);
    }),
  resolve: (confirmed) => {
    const cur = get().current;
    cur?.resolve(confirmed);
    set({ current: null });
  },
}));

/** Imperative confirm usable outside React (store slices, plain modules). */
export const requestConfirm = (opts: ConfirmOptions): Promise<boolean> =>
  useConfirmStore.getState().request(opts);
