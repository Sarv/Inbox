import { useEffect, useState } from 'react';

import { useUpdater } from '../hooks/useUpdater';

/**
 * The auto-update dialog.
 *
 * Shown in two situations, both decided by the MAIN process (see
 * `update-policy.ts`), never here:
 *
 *  - the hourly background check found a release and finished downloading it,
 *    and the user has not skipped that version or asked to be reminded later;
 *  - the user chose "Check for Updates..." from the menu, in which case every
 *    outcome is reported — including "you're up to date" and a failed check.
 *
 * Updates install automatically on the next quit regardless of what is pressed
 * here (unless "Skip this version" is), so the copy is careful to frame the
 * primary button as *sooner*, not as *the only way*.
 */
export function UpdateDialog() {
  const { state, install, skip, remindLater, dismiss } = useUpdater();
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const open = state?.prompt === true;

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

  if (!state || !open) return null;

  const version = state.version ? `Sarv Inbox ${state.version}` : 'A new version';

  const onInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    const started = await install();
    if (!started) {
      // The only way here is a race: the staged update went away between the
      // button rendering and the press. Re-enable rather than hanging on a
      // spinner that will never resolve.
      setInstalling(false);
      setInstallError('That update is no longer ready. Try checking again.');
    }
  };

  /** Title, body and which buttons make sense, per phase. */
  const content = (() => {
    switch (state.phase) {
      case 'checking':
        return { title: 'Checking for updates...', body: 'Contacting the update server.' };
      case 'downloading':
        return {
          title: `${version} is available`,
          body: 'Downloading it now. It will install automatically the next time you quit.',
        };
      case 'downloaded':
        return {
          title: `${version} is ready`,
          body: 'It will install automatically the next time you quit, or you can install it now.',
        };
      case 'up-to-date':
        return { title: "You're up to date", body: 'You already have the newest version.' };
      case 'unsupported':
        return { title: 'Updates are managed elsewhere', body: state.error ?? '' };
      case 'error':
        return {
          title: "Couldn't check for updates",
          body: `${state.error ?? 'The update server could not be reached.'}\n\nThis usually means no connection. The next automatic check is in an hour.`,
        };
      default:
        return { title: 'Updates', body: '' };
    }
  })();

  // Only a staged update can be acted on; everything else is informational.
  const canInstall = state.phase === 'downloaded';
  // The skip/later pair is only meaningful while an update is actually pending.
  const canDefer = state.phase === 'downloaded' || state.phase === 'downloading';

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
          {content.title}
        </h3>
        <p className="text-sm text-muted-foreground whitespace-pre-line">{content.body}</p>

        {state.phase === 'downloading' && (
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

        {installError && <p className="mt-3 text-sm text-destructive">{installError}</p>}

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {canDefer && (
              <button
                onClick={() => void skip()}
                disabled={installing}
                className="px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                Skip this version
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => void (canDefer ? remindLater() : dismiss())}
              disabled={installing}
              className="px-3 py-1.5 rounded-md text-sm font-medium border border-border hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              {canDefer ? 'Remind me later' : 'Close'}
            </button>

            {canInstall && (
              <button
                onClick={() => void onInstall()}
                disabled={installing}
                autoFocus
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {installing ? 'Installing...' : 'Install and Relaunch'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
