import { useEffect, useState } from 'react';

import { useUpdater } from '../hooks/useUpdater';

import { describeUpdateDialog, type UpdateDialogAction } from './update-dialog-view';

/** How long a check may run before the dialog admits it is slow. */
const SLOW_CHECK_MS = 6000;

/**
 * The auto-update dialog.
 *
 * Shown in three situations, all decided by the MAIN process (see
 * `update-policy.ts`), never here:
 *
 *  - the user chose "Check for Updates..." from the menu, in which case every
 *    outcome is reported — including "you're on the latest version" and a
 *    failed check;
 *  - automatic updates are OFF and a background check found a release, in which
 *    case the dialog asks before a byte is downloaded;
 *  - a download the user started has finished, in which case it offers the
 *    restart.
 *
 * With automatic updates ON (the default) a background cycle never opens this
 * at all: the download and the install both happen without the user, and the
 * new version is simply what launches next time.
 *
 * What this file must NOT do is decide any of that. The renderer can be
 * reloaded, remounted or reopened at any moment, and every one of those has to
 * show the same answer — which is only true while the main process is the sole
 * owner of the state.
 */
export function UpdateDialog() {
  const { state, install, download, setAutoUpdate, skip, remindLater, dismiss } = useUpdater();
  const [installing, setInstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [slowCheck, setSlowCheck] = useState(false);

  const open = state?.prompt === true;
  const phase = state?.phase;

  // Escape dismisses without recording an answer, matching ConfirmDialog. The
  // listener is only attached while the dialog is open so it cannot swallow
  // Escape for the mail list underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void dismiss();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, dismiss]);

  // A check that runs long is the thing that made updates feel broken: the
  // dialog sat on "Contacting the update server" with nothing to say. It is
  // bounded in the main process now, and after a few seconds it says so.
  useEffect(() => {
    if (phase !== 'checking') {
      setSlowCheck(false);
      return;
    }
    const timer = setTimeout(() => setSlowCheck(true), SLOW_CHECK_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!state || !open) return null;

  const view = describeUpdateDialog(state, { slowCheck });

  const run = async (action: UpdateDialogAction) => {
    setActionError(null);
    switch (action) {
      case 'install': {
        setInstalling(true);
        const started = await install();
        if (!started) {
          // The only way here is a race: the staged update went away between
          // the button rendering and the press. Re-enable rather than hanging
          // on a spinner that will never resolve.
          setInstalling(false);
          setActionError('That update is no longer ready. Try checking again.');
        }
        return;
      }
      case 'download': {
        const started = await download();
        if (!started) setActionError('That update is no longer available. Try checking again.');
        return;
      }
      case 'skip':
        await skip();
        return;
      case 'later':
        await remindLater();
        return;
      default:
        await dismiss();
    }
  };

  /**
   * The automatic-updates checkbox.
   *
   * Kept out of `run` because it is not one of the dialog's ANSWERS: it changes
   * a standing preference and never closes the dialog. At phase 'available'
   * ticking it also starts this download — the main process does that, and the
   * pushed state moves the dialog to 'downloading' on its own.
   */
  const toggleAutoUpdate = async (enabled: boolean) => {
    setActionError(null);
    const saved = await setAutoUpdate(enabled);
    // The checkbox renders from the main process's state, so a failed write
    // leaves it visibly unchanged — say why rather than letting it look stuck.
    if (!saved) setActionError('That preference could not be saved.');
  };

  const buttonClass = (kind: 'primary' | 'neutral' | 'quiet') =>
    kind === 'primary'
      ? 'px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50'
      : kind === 'neutral'
        ? 'px-3 py-1.5 rounded-md text-sm font-medium border border-border hover:bg-muted/50 transition-colors disabled:opacity-50'
        : 'px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-50';

  // z-250: above the app's own overlays, below the z-300 confirmation dialog,
  // which is always raised BY something and must stay on top of it.
  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 p-4"
      onClick={() => void dismiss()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="update-dialog-title" className="text-base font-semibold mb-2">
          {view.title}
        </h3>
        <p className="text-sm text-muted-foreground whitespace-pre-line">{view.body}</p>

        {view.showProgress && (
          <div className="mt-4">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={state.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Download progress"
            >
              <div
                className="h-full bg-primary transition-[width] duration-300"
                style={{ width: `${state.percent}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{state.percent}%</p>
          </div>
        )}

        {view.autoUpdateToggle && (
          <label className="mt-4 flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={view.autoUpdateToggle.checked}
              disabled={installing}
              onChange={(event) => void toggleAutoUpdate(event.target.checked)}
              className="w-4 h-4 mt-0.5"
            />
            <span>
              <span className="text-sm">{view.autoUpdateToggle.label}</span>
              <span className="block text-xs text-muted-foreground">
                {view.autoUpdateToggle.hint}
              </span>
            </span>
          </label>
        )}

        {actionError && <p className="mt-3 text-sm text-destructive">{actionError}</p>}

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {view.tertiary && (
              <button
                onClick={() => void run(view.tertiary!.action)}
                disabled={installing}
                className={buttonClass('quiet')}
              >
                {view.tertiary.label}
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => void run(view.secondary.action)}
              disabled={installing}
              className={buttonClass('neutral')}
            >
              {view.secondary.label}
            </button>

            {view.primary && (
              <button
                onClick={() => void run(view.primary!.action)}
                disabled={installing}
                autoFocus
                className={buttonClass('primary')}
              >
                {installing && view.primary.action === 'install'
                  ? 'Restarting…'
                  : view.primary.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
