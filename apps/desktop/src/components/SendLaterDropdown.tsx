import type { SendLaterDraft } from '../hooks/useSendLaterDrafts';
import { sendLaterPresets, toEpochSeconds } from '../utils/time-presets';

import { TimePickMenu } from './TimePickMenu';

export interface SendLaterDropdownProps {
  /** Receives the chosen delivery time as UTC epoch SECONDS. */
  onPick: (sendAt: number) => void;
  onClose: () => void;
  /** What the reader has typed so far, held by the owner so a click outside
   *  (which unmounts this menu) doesn't discard it. See useSendLaterDrafts. */
  draft: SendLaterDraft;
  onDraftChange: (patch: Partial<SendLaterDraft>) => void;
  direction?: 'up' | 'down';
  align?: 'left' | 'right';
}

/**
 * "Send later" — the shared "when?" menu (TimePickMenu) with the send-later
 * presets from utils/time-presets, the same ones Snooze draws on.
 */
export function SendLaterDropdown({ onPick, ...menu }: SendLaterDropdownProps) {
  const options = sendLaterPresets(new Date()).map((preset) => ({
    label: preset.label,
    sublabel: preset.sublabel,
    value: toEpochSeconds(preset.time),
  }));
  return <TimePickMenu heading="Send later" options={options} onPickOption={onPick} onPickCustom={onPick} {...menu} />;
}
