/**
 * The line shown under Settings → Test notification. Pure, so each outcome the
 * main process can report is unit-tested without rendering the tab.
 */

export interface TestNotificationResult {
  success: boolean;
  supported?: boolean;
  focus?: 'on' | 'off' | 'unknown';
  error?: string;
}

export const FOCUS_ON_MESSAGE =
  'Sent, but macOS Focus / Do Not Disturb is on, so it went straight to Notification Center with no banner. ' +
  'Turn Focus off in Control Center, or allow Sarv Inbox under System Settings → Focus.';

export const SENT_MESSAGE =
  'Sent. If nothing appears: check System Settings → Notifications for this app (Allow + Banners), ' +
  'check for a scheduled Focus, and look in Notification Center (the app must not be the frontmost window).';

export const UNSUPPORTED_MESSAGE = 'This OS reports notifications are not available for the app.';

export const FAILED_MESSAGE = 'Failed to send a test notification.';

export function describeTestNotificationResult(res: TestNotificationResult | null | undefined): string {
  if (res?.success && res.supported) return res.focus === 'on' ? FOCUS_ON_MESSAGE : SENT_MESSAGE;
  if (res && res.supported === false) return UNSUPPORTED_MESSAGE;
  return res?.error || FAILED_MESSAGE;
}
