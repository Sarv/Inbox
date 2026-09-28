import { describe, expect, it } from 'vitest';

import {
  FAILED_MESSAGE,
  FOCUS_ON_MESSAGE,
  SENT_MESSAGE,
  UNSUPPORTED_MESSAGE,
  describeTestNotificationResult,
} from '../../../../../src/components/settings/test-notification-message';

// The line under Settings → Test notification. Its whole job is to explain why
// no banner appeared, so each outcome must reach the right text.
describe('describeTestNotificationResult', () => {
  // Breaks: Focus silently eats the toast and the user is told it was sent.
  it('names Focus / Do Not Disturb when it is on', () => {
    expect(describeTestNotificationResult({ success: true, supported: true, focus: 'on' })).toBe(FOCUS_ON_MESSAGE);
    expect(FOCUS_ON_MESSAGE).toMatch(/Focus/);
  });

  // Breaks: users without Focus on get no pointer to the other OS settings.
  it('falls back to the general checklist when Focus is off or unknown', () => {
    expect(describeTestNotificationResult({ success: true, supported: true, focus: 'off' })).toBe(SENT_MESSAGE);
    expect(describeTestNotificationResult({ success: true, supported: true, focus: 'unknown' })).toBe(SENT_MESSAGE);
    // An older main process that doesn't send `focus` yet.
    expect(describeTestNotificationResult({ success: true, supported: true })).toBe(SENT_MESSAGE);
  });

  // Breaks: a platform with no notification support reads as success.
  it('reports unsupported', () => {
    expect(describeTestNotificationResult({ success: true, supported: false })).toBe(UNSUPPORTED_MESSAGE);
  });

  // Breaks: a main-process error is replaced by a vague message, or crashes on null.
  it('surfaces the error text, with a generic fallback', () => {
    expect(describeTestNotificationResult({ success: false, error: 'boom' })).toBe('boom');
    expect(describeTestNotificationResult({ success: false })).toBe(FAILED_MESSAGE);
    expect(describeTestNotificationResult(null)).toBe(FAILED_MESSAGE);
    expect(describeTestNotificationResult(undefined)).toBe(FAILED_MESSAGE);
  });
});
