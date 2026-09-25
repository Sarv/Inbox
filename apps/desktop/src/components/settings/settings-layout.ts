import type { SettingsTab } from './types';

/**
 * How wide the Settings content column is allowed to grow, per tab.
 *
 * Most tabs are a single column of label/control rows, and a line of prose is
 * only readable up to a point — so they stay capped at `max-w-3xl` and leave
 * the rest of a wide window empty on purpose.
 *
 * Appearance is the exception: it carries a live preview that is worth showing
 * BESIDE the controls rather than under them, and two columns need the room.
 * Kept here as a pure function so the rule is one testable decision instead of
 * a class name buried in JSX.
 */
export function settingsContentWidthClass(tab: SettingsTab): string {
  return tab === 'appearance' ? 'max-w-6xl' : 'max-w-3xl';
}
