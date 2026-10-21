// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InAppNotification } from '../../../../src/components/InAppNotification';
import { act, cleanup, fire, render, type Mounted } from '../../../helpers/render';

const h = vi.hoisted(() => ({ openEmail: vi.fn() }));
vi.mock('../../../../src/utils/open-email-from-notification', () => ({ openEmailFromNotification: h.openEmail }));

const target = { eventId: 'recurring-series', startMs: Date.parse('2026-11-02T06:30:00Z'), occurrenceId: 'recurring-series:1793511000000' };
type Notice = { id: string; title: string; body: string; subtitle?: string; calendarEvent?: typeof target; emailId?: string; accountId?: string };
let onNotice: ((notice: Notice) => void) | undefined;
let mounted: Mounted;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  h.openEmail.mockClear();
  unsubscribe.mockClear();
  onNotice = undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    notifications: { onInApp: (callback: (notice: Notice) => void) => { onNotice = callback; return unsubscribe; } },
  };
  mounted = render(<InAppNotification />);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('in-app calendar reminder targets', () => {
  it('opens the exact recurring occurrence and dismisses its toast without invoking mail navigation', () => {
    const events: unknown[] = [];
    const receive = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('sarvinbox:calendar-open', receive);
    try {
      act(() => onNotice!({ id: 'calendar-1', title: 'Moved meeting', body: 'Monday at 06:30 UTC', subtitle: 'Calendar reminder', calendarEvent: target }));
      const button = mounted.find('button[title="Open this calendar event"]');
      expect(button).not.toBeNull();
      fire(button!, 'click');
      expect(events).toEqual([target]);
      expect(h.openEmail).not.toHaveBeenCalled();
      expect(mounted.container.textContent).not.toContain('Moved meeting');
    } finally { window.removeEventListener('sarvinbox:calendar-open', receive); }
  });

  it('dismissing a calendar reminder never opens a calendar or changes mail', () => {
    const receive = vi.fn();
    window.addEventListener('sarvinbox:calendar-open', receive);
    try {
      act(() => onNotice!({ id: 'calendar-2', title: 'Private calendar event', body: 'Wednesday at 12:00 UTC', calendarEvent: target }));
      fire(mounted.byLabel('Dismiss')!, 'click');
      expect(receive).not.toHaveBeenCalled();
      expect(h.openEmail).not.toHaveBeenCalled();
      expect(mounted.container.textContent).not.toContain('Private calendar event');
    } finally { window.removeEventListener('sarvinbox:calendar-open', receive); }
  });

  it('keeps ordinary email notifications on their existing mail navigation path', () => {
    act(() => onNotice!({ id: 'email-1', title: 'Regular email', body: 'A message', emailId: 'mail-id', accountId: 'account-id' }));
    fire(mounted.find('button[title="Open this email"]')!, 'click');
    expect(h.openEmail).toHaveBeenCalledExactlyOnceWith('mail-id', 'account-id', undefined);
    expect(mounted.container.textContent).not.toContain('Regular email');
  });

  it('unsubscribes from delivery when unmounted', () => {
    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
