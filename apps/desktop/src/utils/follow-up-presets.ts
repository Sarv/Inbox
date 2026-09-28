import type { SendFollowUpRequest } from '@sarvinbox/core';
import { format } from 'date-fns';

/**
 * The compose bell's "remind me if nobody replies" choices, and how a chosen
 * one reads back on the button. Pure and clock-injected, like time-presets.
 *
 * The presets are DELAYS, not times: "3 days" counts from the moment the
 * message actually leaves (an outbox retry or a Send later can hold it), which
 * the main process resolves when it records the reminder.
 */
const DAY_SECONDS = 24 * 60 * 60;

const DELAYS: Array<{ label: string; short: string; days: number }> = [
  { label: 'In 1 day', short: '1 day', days: 1 },
  { label: 'In 2 days', short: '2 days', days: 2 },
  { label: 'In 3 days', short: '3 days', days: 3 },
  { label: 'In 1 week', short: '1 week', days: 7 },
];

export interface FollowUpPreset {
  label: string;
  /** When it would fall due for a message sent right now. */
  sublabel: string;
  value: SendFollowUpRequest;
}

export function followUpPresets(now: Date = new Date()): FollowUpPreset[] {
  return DELAYS.map(({ label, days }) => ({
    label,
    sublabel: format(new Date(now.getTime() + days * DAY_SECONDS * 1000), 'EEE, MMM d'),
    value: { afterSeconds: days * DAY_SECONDS },
  }));
}

/**
 * What the active reminder says on the bell's tooltip — "Remind me if no reply
 * in 3 days" / "…by Mon, Oct 5, 9:00 AM" — or null when none is set.
 */
export function describeFollowUp(request: SendFollowUpRequest | null | undefined): string | null {
  if (!request) return null;
  if (typeof request.at === 'number' && request.at > 0) {
    return `Remind me if no reply by ${format(new Date(request.at * 1000), 'EEE, MMM d, h:mm a')}`;
  }
  if (typeof request.afterSeconds === 'number' && request.afterSeconds > 0) {
    const preset = DELAYS.find(({ days }) => days * DAY_SECONDS === request.afterSeconds);
    const days = Math.max(1, Math.round(request.afterSeconds / DAY_SECONDS));
    const span = preset?.short ?? `${days} ${days === 1 ? 'day' : 'days'}`;
    return `Remind me if no reply in ${span}`;
  }
  return null;
}

/**
 * A reminder's state in words, for the Follow-ups list and the thread banner,
 * in the reader's local time: "No reply since Mon, Sep 28" once it is due,
 * "Reminder Thu, Oct 1, 9:00 AM" while it waits.
 */
export function followUpStatusText(followUp: { status: string; sentAt: number; dueAt: number }): string {
  if (followUp.status === 'due') return `No reply since ${format(new Date(followUp.sentAt * 1000), 'EEE, MMM d')}`;
  return `Reminder ${format(new Date(followUp.dueAt * 1000), 'EEE, MMM d, h:mm a')}`;
}
