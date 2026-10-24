import { BellRing, ChevronDown, Download, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';

import { useClickAway } from '../hooks/useClickAway';
import { useSendLaterDraft } from '../hooks/useSendLaterDrafts';
import { useUpdater } from '../hooks/useUpdater';
import { toEpochSeconds, updateReminderPresets } from '../utils/time-presets';

import { BannerBar } from './BannerBar';
import { TimePickMenu } from './TimePickMenu';

/** Controls on the strip, matching the other banners' action buttons: the
 *  primary action filled, the secondary one only on hover. */
const ACTION_BASE =
  'flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition-colors flex-shrink-0 disabled:opacity-50';
const PRIMARY_ACTION = `${ACTION_BASE} bg-primary/15 hover:bg-primary/25`;
const SECONDARY_ACTION = `${ACTION_BASE} hover:bg-primary/15`;

/**
 * "Sarv Inbox X is ready — restart to install", shown while a downloaded
 * update waits for the next quit.
 *
 * A staged update used to announce itself with one silent system notification
 * and nothing else, so it could wait for weeks with the app never quitting
 * (closing the window is not quitting on macOS). This stays on screen until it
 * is answered, without blocking anything: "Restart now", or a reminder for
 * later — in an hour, tonight, tomorrow morning, or a picked time.
 *
 * Whether it shows is decided by the main process (`state.banner`), which also
 * keeps the dialog and this from saying the same thing at once.
 */
export function UpdateReadyBanner() {
  const { state, install, remindLater } = useUpdater();
  const [menuOpen, setMenuOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { draft, update } = useSendLaterDraft();

  useClickAway(menuRef, menuOpen, () => setMenuOpen(false));

  if (!state?.banner || !state.version) return null;

  const restart = async () => {
    setFailed(false);
    setRestarting(true);
    // On success the app is already quitting; a false only comes back when
    // the staged update went away under the button.
    const started = await install();
    if (!started) {
      setRestarting(false);
      setFailed(true);
    }
  };

  const options = updateReminderPresets(new Date()).map((preset) => ({
    label: preset.label,
    sublabel: preset.sublabel,
    value: toEpochSeconds(preset.time),
  }));
  const remindAt = (epochSeconds: number) => void remindLater(epochSeconds);

  return (
    <BannerBar
      tone="info"
      icon={<Download className="h-4 w-4" />}
      actions={
        <>
          <button onClick={() => void restart()} disabled={restarting} className={PRIMARY_ACTION}>
            <RotateCw className="h-3.5 w-3.5" />
            {restarting ? 'Restarting…' : 'Restart now'}
          </button>
          <div ref={menuRef} className="relative flex-shrink-0">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              disabled={restarting}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className={SECONDARY_ACTION}
            >
              <BellRing className="h-3.5 w-3.5" />
              Remind me later
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <TimePickMenu
                heading="Remind me"
                options={options}
                onPickOption={remindAt}
                onPickCustom={remindAt}
                onClose={() => setMenuOpen(false)}
                draft={draft}
                onDraftChange={update}
                direction="down"
                align="right"
                dateLabel="Reminder date"
                timeLabel="Reminder time"
                confirmLabel="Remind me"
              />
            )}
          </div>
        </>
      }
    >
      <span className="font-semibold">Sarv Inbox {state.version} is ready.</span>{' '}
      <span className="opacity-90">
        {failed
          ? 'That update is no longer ready. Try Check for Updates.'
          : 'Restart to install it, or it installs the next time you quit.'}
      </span>
    </BannerBar>
  );
}
