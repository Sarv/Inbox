import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  interface Reminder {
    id: string;
    eventId: string;
    occurrenceId: string;
    title: string;
    startMs: number;
    timeZone: string;
  }
  interface Options { title: string; body: string; silent: boolean }
  const state = {
    dev: false,
    supported: true,
    nativeFailure: '' as '' | 'constructor' | 'show',
    reminders: [] as Reminder[],
    delivered: new Set<string>(),
    window: null as ReturnType<typeof makeWindow> | null,
  };
  function makeWindow() {
    return {
      show: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn(),
        isLoadingMainFrame: vi.fn(() => false),
      },
    };
  }
  const notices: FakeNotification[] = [];
  class FakeNotification {
    readonly callbacks = new Map<string, () => void>();
    readonly show = vi.fn(() => {
      if (state.nativeFailure === 'show') throw new Error('Native delivery unavailable');
    });
    constructor(readonly options: Options) {
      if (state.nativeFailure === 'constructor') throw new Error('Native notifications unavailable');
      notices.push(this);
    }
    static isSupported = vi.fn(() => state.supported);
    on(event: string, callback: () => void): this { this.callbacks.set(event, callback); return this; }
  }
  const service = {
    dueReminders: vi.fn(() => state.reminders.filter(reminder => !state.delivered.has(reminder.id))),
    markReminderDelivered: vi.fn((id: string) => { state.delivered.add(id); }),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), isLevelEnabled: vi.fn(() => false) };
  const getEventBus = vi.fn(() => { throw new Error('Calendar reminders must not subscribe to or mutate mail'); });
  return { state, makeWindow, notices, FakeNotification, service, logger, getEventBus };
});

vi.mock('electron', () => ({ Notification: h.FakeNotification }));
vi.mock('@sarvinbox/core', () => ({ createLogger: () => h.logger, getEventBus: h.getEventBus }));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: () => h.state.window }));
vi.mock('../../../../electron/utils/dev-mode', () => ({ isDevBuild: () => h.state.dev, isReleaseBundle: () => !h.state.dev }));
vi.mock('../../../../electron/services/local-calendar-service', () => ({ getLocalCalendarService: () => h.service }));

import { checkLocalCalendarReminders, startLocalCalendarReminders, stopLocalCalendarReminders } from '../../../../electron/services/local-calendar-reminders';
import { setNotificationConfig } from '../../../../electron/services/notification-service';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const reminder = () => ({
  id: 'series:original:30:relocated', eventId: 'series-1', occurrenceId: 'series-1:1792589400000',
  title: 'Moved recurring meeting', startMs: NOW + 30 * 60_000, timeZone: 'UTC',
});
const target = () => ({ eventId: reminder().eventId, startMs: reminder().startMs, occurrenceId: reminder().occurrenceId });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.state.dev = false;
  h.state.supported = true;
  h.state.nativeFailure = '';
  h.state.reminders = [reminder()];
  h.state.delivered.clear();
  h.state.window = h.makeWindow();
  h.notices.length = 0;
  setNotificationConfig({ mode: 'important', sound: true, workingHours: { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } });
});

afterEach(() => {
  stopLocalCalendarReminders();
  expect(h.getEventBus).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('local calendar reminder delivery', () => {
  it('delivers natively once, marks only after show, and never mirrors the same notice in-app', () => {
    h.service.markReminderDelivered.mockImplementationOnce((id: string) => {
      expect(h.notices[0].show).toHaveBeenCalledOnce();
      h.state.delivered.add(id);
    });
    checkLocalCalendarReminders();
    checkLocalCalendarReminders();

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].options).toMatchObject({ title: reminder().title, silent: false });
    expect(h.notices[0].options.body).toContain('UTC');
    expect(h.service.markReminderDelivered).toHaveBeenCalledExactlyOnceWith(reminder().id);
    expect(h.state.window!.webContents.send).not.toHaveBeenCalled();
  });

  it.each([
    ['sound disabled', false, { enabled: false, days: [], start: '00:00', end: '23:59' }],
    ['outside working days', true, { enabled: true, days: [(new Date(NOW).getDay() + 1) % 7], start: '00:00', end: '23:59' }],
  ])('uses the shared silent policy when %s', (_name, sound, workingHours) => {
    setNotificationConfig({ sound, workingHours });
    checkLocalCalendarReminders();
    expect(h.notices[0].options.silent).toBe(true);
    expect(h.service.markReminderDelivered).toHaveBeenCalledWith(reminder().id);
  });

  it('keeps an explicit reminder visible when mail notifications are off', () => {
    setNotificationConfig({ mode: 'off', sound: true });
    checkLocalCalendarReminders();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].options.silent).toBe(false);
    expect(h.service.markReminderDelivered).toHaveBeenCalledOnce();
  });

  it('opens the exact relocated recurring occurrence on native click', () => {
    checkLocalCalendarReminders();
    h.notices[0].callbacks.get('click')!();
    expect(h.state.window!.show).toHaveBeenCalledOnce();
    expect(h.state.window!.focus).toHaveBeenCalledOnce();
    expect(h.state.window!.webContents.send).toHaveBeenCalledExactlyOnceWith('calendar:openEvent', target());
  });

  it('tolerates a native click after the main window has closed', () => {
    checkLocalCalendarReminders();
    h.state.window = null;
    expect(() => h.notices[0].callbacks.get('click')!()).not.toThrow();
    expect(h.service.markReminderDelivered).toHaveBeenCalledOnce();
  });

  it.each(['dev', 'unsupported', 'constructor', 'show'] as const)('falls back once in-app when native delivery is %s', reason => {
    h.state.dev = reason === 'dev';
    h.state.supported = reason !== 'unsupported';
    h.state.nativeFailure = reason === 'constructor' || reason === 'show' ? reason : '';
    h.state.window!.webContents.send.mockImplementationOnce((channel, notice) => {
      expect(h.service.markReminderDelivered).not.toHaveBeenCalled();
      expect(channel).toBe('notifications:in-app');
      expect(notice).toMatchObject({ title: reminder().title, subtitle: 'Calendar reminder', calendarEvent: target() });
      expect(notice).not.toHaveProperty('emailId');
      expect(notice).not.toHaveProperty('accountId');
    });
    checkLocalCalendarReminders();
    checkLocalCalendarReminders();
    expect(h.state.window!.webContents.send).toHaveBeenCalledOnce();
    expect(h.service.markReminderDelivered).toHaveBeenCalledExactlyOnceWith(reminder().id);
    if (reason === 'dev' || reason === 'unsupported') expect(h.notices).toHaveLength(0);
  });

  it.each(['missing', 'destroyed', 'loading'] as const)('does not consume an in-app reminder while the window is %s', reason => {
    h.state.supported = false;
    const initialWindow = h.state.window!;
    if (reason === 'missing') h.state.window = null;
    if (reason === 'destroyed') initialWindow.isDestroyed.mockReturnValue(true);
    if (reason === 'loading') initialWindow.webContents.isLoadingMainFrame.mockReturnValue(true);
    checkLocalCalendarReminders();
    expect(initialWindow.webContents.send).not.toHaveBeenCalled();
    expect(h.service.markReminderDelivered).not.toHaveBeenCalled();

    h.state.window = h.makeWindow();
    checkLocalCalendarReminders();
    expect(h.state.window.webContents.send).toHaveBeenCalledOnce();
    expect(h.service.markReminderDelivered).toHaveBeenCalledWith(reminder().id);
  });

  it('does not mark a failed in-app send delivered and retries it next check', () => {
    h.state.supported = false;
    h.state.window!.webContents.send.mockImplementationOnce(() => { throw new Error('Renderer closed before delivery'); });
    expect(checkLocalCalendarReminders).not.toThrow();
    expect(h.service.markReminderDelivered).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith('Could not check local calendar reminders', 'Renderer closed before delivery');

    checkLocalCalendarReminders();
    expect(h.state.window!.webContents.send).toHaveBeenCalledTimes(2);
    expect(h.service.markReminderDelivered).toHaveBeenCalledExactlyOnceWith(reminder().id);
  });

  it('can deliver natively with no loaded renderer', () => {
    h.state.window!.webContents.isLoadingMainFrame.mockReturnValue(true);
    checkLocalCalendarReminders();
    expect(h.notices[0].show).toHaveBeenCalledOnce();
    expect(h.service.markReminderDelivered).toHaveBeenCalledWith(reminder().id);
    expect(h.state.window!.webContents.send).not.toHaveBeenCalled();
  });

  it('retains every undelivered receipt when the calendar cannot be read', () => {
    h.service.dueReminders.mockImplementationOnce(() => { throw new Error('Encrypted calendar is unavailable'); });
    expect(checkLocalCalendarReminders).not.toThrow();
    expect(h.notices).toHaveLength(0);
    expect(h.service.markReminderDelivered).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith('Could not check local calendar reminders', 'Encrypted calendar is unavailable');
    checkLocalCalendarReminders();
    expect(h.notices).toHaveLength(1);
  });
});

describe('local calendar reminder timer', () => {
  it('starts immediately once, polls every 30 seconds, and stops idempotently', () => {
    h.state.reminders = [];
    startLocalCalendarReminders();
    startLocalCalendarReminders();
    expect(h.service.dueReminders).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(29_999);
    expect(h.service.dueReminders).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(h.service.dueReminders).toHaveBeenCalledTimes(2);
    stopLocalCalendarReminders();
    stopLocalCalendarReminders();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(h.service.dueReminders).toHaveBeenCalledTimes(2);
    startLocalCalendarReminders();
    expect(h.service.dueReminders).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps polling after an initial unreadable calendar and records only subsequent delivery', () => {
    h.service.dueReminders.mockImplementationOnce(() => { throw new Error('Calendar temporarily locked'); });
    startLocalCalendarReminders();
    expect(h.service.markReminderDelivered).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(h.notices).toHaveLength(1);
    expect(h.service.markReminderDelivered).toHaveBeenCalledExactlyOnceWith(reminder().id);
  });
});
