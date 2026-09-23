import { useCallback, useEffect, useState } from 'react';

import type { UpdateState } from '../../electron/services/update-policy';

/**
 * Subscribe to the main process's auto-update state.
 *
 * The main process is the single owner of that state; this hook only mirrors
 * it. That is deliberate — a renderer reload, a closed-and-reopened window or a
 * second mount all re-read the truth instead of resurrecting a stale copy, so
 * the dialog can never offer an update that was already installed or skipped.
 */
export const useUpdater = () => {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let active = true;

    // Seed from the current state: the renderer usually mounts long after the
    // first background check, so waiting only for pushes would miss it.
    void window.electronAPI?.updater
      ?.getState()
      .then((result) => {
        if (active && result?.success && result.data) setState(result.data);
      })
      .catch(() => {
        // An updater bridge that isn't there (older preload, test harness) just
        // means no update UI — never a broken app.
      });

    // Returns its own disposer; without detaching it a remount would stack a
    // second listener and double-handle every push.
    const dispose = window.electronAPI?.updater?.onState((next) => {
      if (active) setState(next);
    });

    return () => {
      active = false;
      dispose?.();
    };
  }, []);

  const install = useCallback(async () => {
    const result = await window.electronAPI?.updater?.install();
    // On success the app is already quitting, so there is nothing to render.
    return result?.success ?? false;
  }, []);

  const skip = useCallback(async () => {
    await window.electronAPI?.updater?.skip();
  }, []);

  const remindLater = useCallback(async () => {
    await window.electronAPI?.updater?.remindLater();
  }, []);

  const dismiss = useCallback(async () => {
    await window.electronAPI?.updater?.dismiss();
  }, []);

  return { state, install, skip, remindLater, dismiss };
};
