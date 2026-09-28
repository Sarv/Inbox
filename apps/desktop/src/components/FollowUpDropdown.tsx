import type { SendFollowUpRequest } from '@sarvinbox/core';
import { BellOff } from 'lucide-react';

import type { SendLaterDraft } from '../hooks/useSendLaterDrafts';
import { followUpPresets } from '../utils/follow-up-presets';

import { TimePickMenu } from './TimePickMenu';

export interface FollowUpDropdownProps {
  /** The reminder currently set on this message, or null. */
  value: SendFollowUpRequest | null;
  onChange: (value: SendFollowUpRequest | null) => void;
  onClose: () => void;
  draft: SendLaterDraft;
  onDraftChange: (patch: Partial<SendLaterDraft>) => void;
}

/**
 * The compose bell's menu: "remind me if nobody replies" in 1/2/3 days, a
 * week, or by a date and time — the same "when?" menu as Send later. Picking
 * only arms the reminder; it is recorded when the message is actually sent.
 */
export function FollowUpDropdown({ value, onChange, onClose, draft, onDraftChange }: FollowUpDropdownProps) {
  return (
    <TimePickMenu
      heading="Remind me if no reply"
      options={followUpPresets(new Date())}
      onPickOption={onChange}
      onPickCustom={(at) => onChange({ at })}
      onClose={onClose}
      draft={draft}
      onDraftChange={onDraftChange}
      dateLabel="Reminder date"
      timeLabel="Reminder time"
      confirmLabel="Set reminder"
      footer={
        value && (
          <>
            <div className="border-t border-border my-1" />
            <button
              onClick={(event) => {
                event.stopPropagation();
                onChange(null);
                onClose();
              }}
              className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2"
            >
              <BellOff className="h-4 w-4" />
              <span className="text-sm">Don&apos;t remind me</span>
            </button>
          </>
        )
      }
    />
  );
}
