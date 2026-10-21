import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import type { LocalCalendarInvitationEmailRequest, LocalCalendarInvitationResponseRequest } from '../../src/types/calendar-invitations';
import type { LocalCalendarAPI, LocalCalendar, LocalCalendarEventInput, LocalCalendarPreferences, LocalCalendarAvailabilityRequest, LocalCalendarRange } from '../../src/types/local-calendar';
import { registryAccountEmail } from '../services/accounts-registry';
import { prepareCalendarFileImport } from '../services/calendar-file-import';
import { getCalendarMailSync } from '../services/calendar-mail-sync';
import { getLocalCalendarInvitationService } from '../services/local-calendar-invitations';
import { getLocalCalendarService } from '../services/local-calendar-service';
import { getOutboxQueueForAccount, notifyOutboxChanged } from '../services/outbox-service';
import { getMainWindow, getStorageFor } from '../shared';

function authorize(event: IpcMainInvokeEvent): void {
  const window = getMainWindow();
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Calendar requests must come from the main Sarv Inbox window.');
  }
}

export function registerCalendarHandlers(): void {
  const responding = new Set<string>();
  const register = (channel: string, run: (value: unknown) => unknown, changed = false) => {
    ipcMain.handle(channel, async (event, value: unknown) => {
      try {
        authorize(event);
        const data = await run(value);
        if (changed) {
          try { getMainWindow()?.webContents.send('calendar:changed'); } catch { /* The saved change survives a closed window. */ }
        }
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'The local calendar could not complete this request.' };
      }
    });
  };
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 200) throw new Error('Choose a valid local calendar.');
    return value;
  };
  const invitationRequest = (value: unknown): LocalCalendarInvitationEmailRequest => {
    if (!value || typeof value !== 'object') throw new Error('Choose a meeting invitation.');
    const request = value as LocalCalendarInvitationEmailRequest;
    return { accountId: id(request.accountId), emailId: id(request.emailId) };
  };
  register('calendar:invitation', async value => {
    const request = invitationRequest(value);
    const previous = getLocalCalendarInvitationService().lookup(request);
    if (previous) return previous;
    await getCalendarMailSync().process(request.accountId, request.emailId, true);
    return getLocalCalendarInvitationService().lookup(request);
  });
  register('calendar:respondToInvitation', async value => {
    const request = { ...invitationRequest(value), response: (value as LocalCalendarInvitationResponseRequest).response };
    if (!['accepted', 'tentative', 'declined'].includes(request.response)) throw new Error('Choose Accept, Tentative or Decline.');
    const service = getLocalCalendarInvitationService();
    const linked = service.lookup(request);
    if (!linked) throw new Error('This email has no linked meeting invitation.');
    const key = JSON.stringify([request.accountId, linked.id]);
    if (responding.has(key)) throw new Error('Your meeting response is already being sent.');
    responding.add(key);
    try {
      if (!getStorageFor(request.accountId)) throw new Error('The invitation account is not available.');
      const prepared = service.prepareResponse(request);
      if (registryAccountEmail(request.accountId).toLowerCase() !== prepared.accountEmail.toLowerCase()) throw new Error('The invitation account has changed. Refresh this email before responding.');
      const deliveryToken = service.reserveResponseDelivery({ invitationId: prepared.invitationId, versionToken: prepared.versionToken });
      const result = await getOutboxQueueForAccount(request.accountId).enqueueAndSend({
        accountId: request.accountId, from: prepared.accountEmail, to: [prepared.organizer],
        calendarInvitationResponse: { invitationId: prepared.invitationId, sequence: prepared.invitation.sequence, dtstampMs: prepared.invitation.dtstampMs, deliveryToken },
        subject: prepared.subject,
        body: `${prepared.accountEmail} ${request.response === 'accepted' ? 'accepted' : request.response === 'tentative' ? 'tentatively accepted' : 'declined'} ${prepared.invitation.title}.`,
        attachments: [{ filename: 'reply.ics', content: prepared.replyIcs, contentType: 'text/calendar; charset=utf-8; method=REPLY', encoding: 'utf-8' }],
      });
      notifyOutboxChanged();
      if (result.status === 'failed') throw new Error(result.error || 'Your response could not be sent.');
      const invitation = service.commitResponse({ invitationId: prepared.invitationId, versionToken: prepared.versionToken, response: request.response });
      return { invitation, delivery: result.status === 'success' ? 'sent' : 'queued' };
    } finally { responding.delete(key); }
  }, true);
  register('calendar:snapshot', value => getLocalCalendarService().snapshot(value as LocalCalendarRange));
  register('calendar:saveCalendar', value => getLocalCalendarService().saveCalendar(value as Omit<LocalCalendar, 'id' | 'provider'> & { id?: string }), true);
  register('calendar:deleteCalendar', value => { getLocalCalendarService().deleteCalendar(id(value)); return null; }, true);
  register('calendar:saveEvent', value => getLocalCalendarService().saveEvent(value as LocalCalendarEventInput), true);
  register('calendar:deleteEvent', value => {
    getLocalCalendarService().deleteEvent(value as Parameters<LocalCalendarAPI['deleteEvent']>[0]);
    return null;
  }, true);
  register('calendar:savePreferences', value => getLocalCalendarService().savePreferences(value as LocalCalendarPreferences), true);
  register('calendar:availability', value => getLocalCalendarService().availability(value as LocalCalendarAvailabilityRequest));
  register('calendar:importIcs', value => getLocalCalendarService().importIcs(value as Parameters<LocalCalendarAPI['importIcs']>[0]), true);
  register('calendar:importFileIcs', value => {
    const request = value as Parameters<LocalCalendarAPI['importFileIcs']>[0];
    return getLocalCalendarService().importIcs({ calendarId: id(request?.calendarId), text: prepareCalendarFileImport(request?.text) });
  }, true);
  register('calendar:exportIcs', value => getLocalCalendarService().exportIcs(value as Parameters<LocalCalendarAPI['exportIcs']>[0]));
}
