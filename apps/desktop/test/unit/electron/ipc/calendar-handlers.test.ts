import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
  frame: {}, sender: { mainFrame: {} as unknown, send: vi.fn() },
  getWindow: vi.fn(), getService: vi.fn(),
  invitationService: { lookup: vi.fn(), prepareResponse: vi.fn(), reserveResponseDelivery: vi.fn(), commitResponse: vi.fn() },
  mailProcess: vi.fn(), enqueue: vi.fn(), notifyOutbox: vi.fn(),
  storage: vi.fn(), accountEmail: vi.fn(),
  service: {
    snapshot: vi.fn(), saveCalendar: vi.fn(), deleteCalendar: vi.fn(),
    saveEvent: vi.fn(), deleteEvent: vi.fn(), savePreferences: vi.fn(),
    availability: vi.fn(), importIcs: vi.fn(), exportIcs: vi.fn(),
  },
}));

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => h.handlers.set(channel, handler) } }));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: h.getWindow, getStorageFor: h.storage }));
vi.mock('../../../../electron/services/local-calendar-service', () => ({ getLocalCalendarService: h.getService }));
vi.mock('../../../../electron/services/local-calendar-invitations', () => ({ getLocalCalendarInvitationService: () => h.invitationService }));
vi.mock('../../../../electron/services/calendar-mail-sync', () => ({ getCalendarMailSync: () => ({ process: h.mailProcess }) }));
vi.mock('../../../../electron/services/outbox-service', () => ({ getOutboxQueueForAccount: () => ({ enqueueAndSend: h.enqueue }), notifyOutboxChanged: h.notifyOutbox }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ registryAccountEmail: h.accountEmail }));

import { registerCalendarHandlers } from '../../../../electron/ipc/calendar-handlers';

const preferences = {
  timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00',
  durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 5, minimumNoticeMinutes: 60, slotIntervalMinutes: 15,
};
const calendar = { id: 'local-work', name: 'Work', color: '#2563eb', visible: true, blocksAvailability: true, isDefault: true };
const startMs = Date.parse('2026-10-21T10:00:00Z');
const event = {
  id: 'planning', calendarId: calendar.id, title: 'Planning', description: '', location: '',
  startMs, endMs: startMs + 3_600_000, timeZone: 'UTC', allDay: false, busy: true, status: 'confirmed', reminderMinutes: 15,
};
interface Route {
  channel: string;
  method: keyof typeof h.service;
  input: unknown;
  result: unknown;
  changed: boolean;
}
const routes: Route[] = [
  { channel: 'calendar:snapshot', method: 'snapshot', input: { startMs, endMs: startMs + 86_400_000 }, result: { calendars: [], preferences, occurrences: [] }, changed: false },
  { channel: 'calendar:saveCalendar', method: 'saveCalendar', input: calendar, result: { ...calendar, provider: 'local' }, changed: true },
  { channel: 'calendar:deleteCalendar', method: 'deleteCalendar', input: calendar.id, result: null, changed: true },
  { channel: 'calendar:saveEvent', method: 'saveEvent', input: event, result: { ...event, updatedAt: startMs }, changed: true },
  { channel: 'calendar:deleteEvent', method: 'deleteEvent', input: { id: event.id, scope: 'occurrence', occurrenceStartMs: startMs }, result: null, changed: true },
  { channel: 'calendar:savePreferences', method: 'savePreferences', input: preferences, result: preferences, changed: true },
  { channel: 'calendar:availability', method: 'availability', input: { startMs, endMs: startMs + 86_400_000, durationMinutes: 30, timeZone: 'UTC', limit: 5 }, result: { status: 'ready', slots: [] }, changed: false },
  { channel: 'calendar:importIcs', method: 'importIcs', input: { calendarId: calendar.id, text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }, result: { imported: 2 }, changed: true },
  { channel: 'calendar:importFileIcs', method: 'importIcs', input: { calendarId: calendar.id, text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }, result: { imported: 2 }, changed: true },
  { channel: 'calendar:exportIcs', method: 'exportIcs', input: { calendarId: calendar.id }, result: { text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }, changed: false },
];
const mutations = routes.filter(route => route.changed);
const trusted = () => ({ sender: h.sender, senderFrame: h.frame });
const call = (route: Route, request = trusted(), input = route.input) => h.handlers.get(route.channel)!(request, input);

beforeEach(() => {
  vi.resetAllMocks(); h.handlers.clear(); h.sender.mainFrame = h.frame;
  h.getWindow.mockReturnValue({ webContents: h.sender }); h.getService.mockReturnValue(h.service);
  for (const route of routes) h.service[route.method].mockReturnValue(route.result);
  registerCalendarHandlers();
});

describe('trusted local calendar IPC', () => {
  it('registers the complete calendar surface without opening a profile', () => {
    expect([...h.handlers.keys()].sort()).toEqual([...routes.map(route => route.channel), 'calendar:invitation', 'calendar:respondToInvitation'].sort());
    expect(h.getService).not.toHaveBeenCalled(); expect(h.getWindow).not.toHaveBeenCalled();
  });

  // Regression: calendar data or writes must never be reachable from an extension iframe or another window.
  it.each(routes)('rejects foreign frames, foreign senders and a missing main window for $channel', async route => {
    for (const request of [
      { sender: h.sender, senderFrame: {} },
      { sender: { mainFrame: h.frame, send: h.sender.send }, senderFrame: h.frame },
      { sender: h.sender, senderFrame: undefined },
    ]) {
      expect(await h.handlers.get(route.channel)!(request, route.input)).toEqual({ success: false, error: 'Calendar requests must come from the main Sarv Inbox window.' });
    }
    h.getWindow.mockReturnValue(null);
    expect(await call(route)).toEqual({ success: false, error: 'Calendar requests must come from the main Sarv Inbox window.' });
    expect(h.getService).not.toHaveBeenCalled(); expect(h.sender.send).not.toHaveBeenCalled();
    for (const method of Object.values(h.service)) expect(method).not.toHaveBeenCalled();
  });

  it.each(routes)('passes the exact request and result through the owning service for $channel', async route => {
    expect(await call(route)).toEqual({ success: true, data: route.result });
    expect(h.service[route.method]).toHaveBeenCalledExactlyOnceWith(route.input);
    expect(h.getService).toHaveBeenCalledOnce();
    for (const other of routes.filter(other => other.method !== route.method)) expect(h.service[other.method]).not.toHaveBeenCalled();
    if (route.changed) expect(h.sender.send).toHaveBeenCalledExactlyOnceWith('calendar:changed');
    else expect(h.sender.send).not.toHaveBeenCalled();
  });

  // Regression: a locked/unreadable profile must produce an error, rather than empty data or a change notification.
  it.each(routes)('serializes service errors without broadcasting a successful change for $channel', async route => {
    h.service[route.method].mockImplementationOnce(() => { throw new Error('Synthetic calendar store unavailable'); });
    expect(await call(route)).toEqual({ success: false, error: 'Synthetic calendar store unavailable' });
    expect(h.service[route.method]).toHaveBeenCalledExactlyOnceWith(route.input);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it.each(['snapshot', 'saveEvent'] as const)('uses a safe fallback for a non-Error %s failure', async method => {
    const route = routes.find(route => route.method === method)!;
    h.service[method].mockImplementationOnce(() => { throw null; });
    expect(await call(route)).toEqual({ success: false, error: 'The local calendar could not complete this request.' });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('serializes a service-access failure before any calendar operation runs', async () => {
    h.getService.mockImplementationOnce(() => { throw new Error('Synthetic profile locked'); });
    expect(await call(routes[0]!)).toEqual({ success: false, error: 'Synthetic profile locked' });
    for (const method of Object.values(h.service)) expect(method).not.toHaveBeenCalled();
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  // Regression: losing the window after a durable mutation must not tell the user that the saved write failed.
  it.each(mutations)('keeps a successful $channel result when its change broadcast cannot be delivered', async route => {
    h.sender.send.mockImplementationOnce(() => { throw new Error('Synthetic closed renderer'); });
    expect(await call(route)).toEqual({ success: true, data: route.result });
    expect(h.service[route.method]).toHaveBeenCalledExactlyOnceWith(route.input);
    h.service[route.method].mockClear(); h.sender.send.mockClear();
    h.getWindow.mockReset().mockReturnValueOnce({ webContents: h.sender }).mockReturnValueOnce(null);
    expect(await call(route)).toEqual({ success: true, data: route.result });
    expect(h.service[route.method]).toHaveBeenCalledExactlyOnceWith(route.input);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('waits for a successful save before acknowledging or broadcasting it', async () => {
    const route = routes.find(route => route.method === 'saveEvent')!;
    let finish!: (value: unknown) => void;
    h.service.saveEvent.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const response = call(route);
    expect(h.service.saveEvent).toHaveBeenCalledExactlyOnceWith(route.input);
    expect(h.sender.send).not.toHaveBeenCalled();
    finish(route.result);
    expect(await response).toEqual({ success: true, data: route.result });
    expect(h.sender.send).toHaveBeenCalledExactlyOnceWith('calendar:changed');
  });

  it('serializes an asynchronous rejected save without broadcasting', async () => {
    const route = routes.find(route => route.method === 'saveEvent')!;
    h.service.saveEvent.mockRejectedValueOnce(new Error('Synthetic save rejected'));
    expect(await call(route)).toEqual({ success: false, error: 'Synthetic save rejected' });
    expect(h.sender.send).not.toHaveBeenCalled();
  });
});

describe('meeting invitation IPC', () => {
  const request = { accountId: 'receiving-account', emailId: 'invite-email' };
  const invitation = { id: 'i1', title: 'Planning', accountEmail: 'recipient@sarv.com', response: 'needs-action' };
  const prepared = { invitation, invitationId: 'i1', versionToken: 'v1', accountId: request.accountId, accountEmail: invitation.accountEmail, organizer: 'organizer@example.com', subject: 'Accepted: Planning', replyIcs: 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR' };
  const invoke = (channel: string, value: unknown, event = trusted()) => h.handlers.get(channel)!(event, value);
  beforeEach(() => {
    h.storage.mockReturnValue({}); h.accountEmail.mockReturnValue(invitation.accountEmail);
    h.invitationService.lookup.mockReturnValue(invitation);
    h.invitationService.prepareResponse.mockReturnValue(prepared);
    h.invitationService.reserveResponseDelivery.mockReturnValue('delivery-1');
    h.invitationService.commitResponse.mockReturnValue({ ...invitation, response: 'accepted' });
    h.enqueue.mockResolvedValue({ status: 'success' });
  });

  it.each(['calendar:invitation', 'calendar:respondToInvitation'])('rejects untrusted callers of %s', async channel => {
    expect(await invoke(channel, request, { sender: h.sender, senderFrame: {} })).toMatchObject({ success: false });
    expect(h.mailProcess).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled(); expect(h.invitationService.lookup).not.toHaveBeenCalled();
  });

  it('returns linked invitation metadata without sending or downloading mail', async () => {
    expect(await invoke('calendar:invitation', request)).toEqual({ success: true, data: invitation });
    expect(h.mailProcess).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('processes the requested owning account before returning a newly discovered invitation', async () => {
    h.invitationService.lookup.mockReturnValueOnce(null);
    expect(await invoke('calendar:invitation', request)).toEqual({ success: true, data: invitation });
    expect(h.mailProcess).toHaveBeenCalledExactlyOnceWith(request.accountId, request.emailId, true);
  });

  it.each(['success', 'queued'])('sends an explicit RSVP through the receiving account (%s)', async status => {
    h.enqueue.mockResolvedValue({ status });
    expect(await invoke('calendar:respondToInvitation', { ...request, response: 'accepted' })).toEqual({ success: true, data: { invitation: { ...invitation, response: 'accepted' }, delivery: status === 'success' ? 'sent' : 'queued' } });
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ accountId: request.accountId, from: invitation.accountEmail, to: [prepared.organizer], attachments: [{ filename: 'reply.ics', content: prepared.replyIcs, contentType: 'text/calendar; charset=utf-8; method=REPLY', encoding: 'utf-8' }] }));
    expect(h.invitationService.commitResponse).toHaveBeenCalledExactlyOnceWith({ invitationId: 'i1', versionToken: 'v1', response: 'accepted' });
    expect(h.sender.send).toHaveBeenCalledWith('calendar:changed');
  });

  it('retains the previous response on permanent delivery failure', async () => {
    h.enqueue.mockResolvedValue({ status: 'failed', error: 'Invalid recipient' });
    expect(await invoke('calendar:respondToInvitation', { ...request, response: 'accepted' })).toEqual({ success: false, error: 'Invalid recipient' });
    expect(h.invitationService.commitResponse).not.toHaveBeenCalled();
  });

  it('rejects a changed account identity and malformed responses before enqueue', async () => {
    h.accountEmail.mockReturnValue('someone-else@sarv.com');
    expect(await invoke('calendar:respondToInvitation', { ...request, response: 'accepted' })).toMatchObject({ success: false });
    expect(await invoke('calendar:respondToInvitation', { ...request, response: 'send-all' })).toMatchObject({ success: false });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue twice while a response is sending', async () => {
    let finish!: (value: { status: string }) => void;
    h.enqueue.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = invoke('calendar:respondToInvitation', { ...request, response: 'accepted' });
    await Promise.resolve();
    expect(await invoke('calendar:respondToInvitation', { ...request, emailId: 'duplicate-delivery-email', response: 'declined' })).toMatchObject({ success: false, error: 'Your meeting response is already being sent.' });
    finish({ status: 'success' }); await first; expect(h.enqueue).toHaveBeenCalledOnce();
  });
});

describe('local calendar deletion identifiers', () => {
  const route = routes.find(route => route.method === 'deleteCalendar')!;
  it.each([undefined, null, '', 42, true, {}, [], 'x'.repeat(201)])('rejects invalid calendar id %j before deletion', async input => {
    expect(await h.handlers.get(route.channel)!(trusted(), input)).toEqual({ success: false, error: 'Choose a valid local calendar.' });
    expect(h.service.deleteCalendar).not.toHaveBeenCalled(); expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('accepts a nonempty calendar id at the length boundary without truncation', async () => {
    const id = 'x'.repeat(200);
    expect(await call(route, trusted(), id)).toEqual({ success: true, data: null });
    expect(h.service.deleteCalendar).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.sender.send).toHaveBeenCalledExactlyOnceWith('calendar:changed');
  });
});
