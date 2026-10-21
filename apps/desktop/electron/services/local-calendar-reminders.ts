import { randomUUID } from 'node:crypto';

import { createLogger } from '@sarvinbox/core';
import { Notification } from 'electron';

import { getMainWindow } from '../shared';
import { isDevBuild } from '../utils/dev-mode';

import { getLocalCalendarService } from './local-calendar-service';
import { notificationShouldBeSilent } from './notification-service';

const logger = createLogger('calendar-reminders');
let timer: ReturnType<typeof setInterval> | undefined;

export function checkLocalCalendarReminders(): void {
  try {
    const service = getLocalCalendarService();
    for (const reminder of service.dueReminders()) {
      const target = { eventId: reminder.eventId, startMs: reminder.startMs, occurrenceId: reminder.occurrenceId };
      const body = new Intl.DateTimeFormat(undefined, {
        weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: reminder.timeZone,
      }).format(new Date(reminder.startMs));
      let delivered = false;
      if (!isDevBuild() && Notification.isSupported()) {
        try {
          const notification = new Notification({ title: reminder.title, body, silent: notificationShouldBeSilent() });
          notification.on('click', () => {
            const window = getMainWindow();
            window?.show();
            window?.focus();
            window?.webContents.send('calendar:openEvent', target);
          });
          notification.show();
          delivered = true;
        } catch { /* Use the existing in-app notification surface below. */ }
      }
      const window = getMainWindow();
      if (!delivered && window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame()) {
        window.webContents.send('notifications:in-app', { id: `calendar-${randomUUID()}`, title: reminder.title, body, subtitle: 'Calendar reminder', calendarEvent: target });
        delivered = true;
      }
      if (delivered) service.markReminderDelivered(reminder.id);
    }
  } catch (error) {
    // An unreadable calendar is a failure, never an empty calendar.
    logger.warn('Could not check local calendar reminders', error instanceof Error ? error.message : 'Calendar unavailable');
  }
}

/** Reminders run while Sarv Inbox is open; delivered occurrences survive restarts. */
export function startLocalCalendarReminders(): void {
  if (timer) return;
  checkLocalCalendarReminders();
  timer = setInterval(checkLocalCalendarReminders, 30_000);
  timer.unref?.();
}

export function stopLocalCalendarReminders(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
