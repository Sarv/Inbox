import { Loader2, RefreshCw } from 'lucide-react';

import { useUpdater } from '../../hooks/useUpdater';
import { describeUpdateStatus } from '../update-dialog-view';

/**
 * Settings → Advanced → Updates.
 *
 * Renders entirely from the state the main process pushes, so this pane, the
 * update dialog and the menu item can never disagree about what is happening.
 * The toggle writes through to `update-prefs.json` (not app settings) because
 * the updater has to work before — and regardless of whether — the mail
 * database opens.
 */
export function UpdatesSection() {
  const { state, check, setAutoUpdate } = useUpdater();

  const checking = state?.phase === 'checking';
  const autoUpdate = state?.autoUpdate !== false;
  const unsupported = state?.phase === 'unsupported';

  return (
    <div className="border-b border-border pb-6">
      <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
        Updates
      </h3>

      <label className="flex items-start gap-3 cursor-pointer mb-3">
        <input
          type="checkbox"
          checked={autoUpdate}
          disabled={unsupported}
          onChange={(event) => void setAutoUpdate(event.target.checked)}
          className="w-4 h-4 mt-0.5"
        />
        <span>
          <span className="font-medium text-sm">Install updates automatically</span>
          <span className="block text-sm text-muted-foreground">
            New versions download quietly in the background and are applied the next time you quit
            the app — nothing interrupts you, and the app is never restarted for you. Turn this off
            to be asked before anything is downloaded, which is what you want on a metered or slow
            connection.
          </span>
        </span>
      </label>

      <p className="text-sm text-muted-foreground mb-4">
        {state ? describeUpdateStatus(state) : 'Loading…'}
        {state?.checkedAt ? (
          <span className="block">
            {/* Stored UTC, rendered in the reader's own locale and zone. */}
            Last checked {new Date(state.checkedAt).toLocaleString()}
          </span>
        ) : null}
      </p>

      <button
        onClick={() => void check()}
        disabled={checking || unsupported}
        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {checking ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {checking ? 'Checking…' : 'Check for updates'}
      </button>
    </div>
  );
}
