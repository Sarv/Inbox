// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalOpenIntents } from '../../../../src/components/ExternalOpenIntents';
import type { DefaultAppsAPI, ExternalOpenIntent } from '../../../../src/types/default-apps';
import type { LocalCalendarAPI } from '../../../../src/types/local-calendar';
import { act, cleanup, fire, render, settle } from '../../../helpers/render';

const ok = <T,>(data: T) => ({ success: true as const, data });
const compose: Extract<ExternalOpenIntent, { kind: 'compose' }> = { id: 'mail-1', kind: 'compose', to: ['recipient@example.com'], cc: ['copy@example.com'], bcc: [], subject: 'Hello', body: '<script>Keep as draft text</script>\nSecond line.' };
const file: Extract<ExternalOpenIntent, { kind: 'calendar-import' }> = { id: 'calendar-1', kind: 'calendar-import', filename: 'meeting.ics', text: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR' };
let pending: ExternalOpenIntent | null;
const listeners = new Set<() => void>();
const api = {
  getPendingOpen: vi.fn<DefaultAppsAPI['getPendingOpen']>(async () => ok(pending)),
  acknowledgeOpen: vi.fn<DefaultAppsAPI['acknowledgeOpen']>(async id => { if (pending?.id === id) pending = null; return ok(null); }),
  onPendingOpen: vi.fn<DefaultAppsAPI['onPendingOpen']>(listener => { listeners.add(listener); return () => listeners.delete(listener); }),
};
const calendars = [
  { id: 'work', name: 'Work', provider: 'local' as const, color: '#2563eb', visible: true, blocksAvailability: true, isDefault: true },
  { id: 'personal', name: 'Personal', provider: 'local' as const, color: '#b45309', visible: false, blocksAvailability: false, isDefault: false },
];
const calendar = {
  snapshot: vi.fn<LocalCalendarAPI['snapshot']>(async () => ok({ calendars, occurrences: [], preferences: { timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0, slotIntervalMinutes: 15 } })),
  importFileIcs: vi.fn<LocalCalendarAPI['importFileIcs']>(async () => ok({ imported: 2 })),
};
const onCompose = vi.fn(async () => true);
const clipboard = vi.fn(async () => {});
function button(view: ReturnType<typeof render>, text: string) { return view.all('button').find(item => item.textContent?.trim() === text) ?? null; }
async function mount(props = {}) { const view = render(<ExternalOpenIntents onCompose={onCompose} {...props} />); await settle(); await settle(); return view; }
function notify() { act(() => { for (const listener of listeners) listener(); }); }

beforeEach(() => {
  pending = null; listeners.clear(); vi.clearAllMocks();
  api.getPendingOpen.mockImplementation(async () => ok(pending));
  api.acknowledgeOpen.mockImplementation(async id => { if (pending?.id === id) pending = null; return ok(null); });
  calendar.importFileIcs.mockResolvedValue(ok({ imported: 2 }));
  calendar.snapshot.mockResolvedValue(ok({ calendars, occurrences: [], preferences: { timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0, slotIntervalMinutes: 15 } }));
  onCompose.mockResolvedValue(true); clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  Object.assign(window, { electronAPI: { defaultApps: api, calendar } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('system-open request handling', () => {
  it('hands email links to the existing composer only after startup suppression ends and acknowledges accepted handoffs', async () => {
    pending = compose; const view = await mount({ suppressed: true });
    expect(onCompose).not.toHaveBeenCalled(); expect(api.acknowledgeOpen).not.toHaveBeenCalled(); expect(view.find('[role="dialog"]')).toBeNull();
    view.rerender(<ExternalOpenIntents suppressed={false} onCompose={onCompose} />); await settle(); await settle();
    expect(onCompose).toHaveBeenCalledExactlyOnceWith({ to: compose.to, cc: compose.cc, bcc: compose.bcc, subject: compose.subject, body: compose.body });
    expect(api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith(compose.id); expect(calendar.importFileIcs).not.toHaveBeenCalled(); expect(view.find('script')).toBeNull();
  });

  it('keeps an email request pending when the unsaved-draft guard declines and offers an explicit retry', async () => {
    pending = compose; onCompose.mockResolvedValueOnce(false);
    const view = await mount(); expect(api.acknowledgeOpen).not.toHaveBeenCalled(); expect(view.container.textContent).toContain('Your current draft has been kept.');
    fire(button(view, 'Open email draft'), 'click'); await settle(); await settle();
    expect(onCompose).toHaveBeenCalledTimes(2); expect(api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith(compose.id);
  });

  it('retries a failed acknowledgement without opening a second draft', async () => {
    pending = compose; api.acknowledgeOpen.mockRejectedValueOnce(new Error('Request acknowledgement failed.'));
    const view = await mount(); expect(view.find('[role="alert"]')?.textContent).toContain('acknowledgement failed');
    expect(view.container.textContent).toContain('The email draft is open.');
    fire(button(view, 'Retry acknowledgement'), 'click'); await settle(); await settle();
    expect(onCompose).toHaveBeenCalledOnce(); expect(api.acknowledgeOpen).toHaveBeenCalledTimes(2); expect(view.find('[role="dialog"]')).toBeNull();
  });

  it('shows composer errors without claiming the current draft was preserved', async () => {
    pending = compose; onCompose.mockRejectedValueOnce(new Error('Composer unavailable.'));
    const view = await mount(); expect(view.find('[role="alert"]')?.textContent).toBe('Composer unavailable.');
    expect(view.container.textContent).not.toContain('Your current draft has been kept.'); expect(api.acknowledgeOpen).not.toHaveBeenCalled();
    fire(button(view, 'Close'), 'click'); await settle(); expect(api.acknowledgeOpen).toHaveBeenCalledWith(compose.id);
  });

  it('requires explicit local-copy import of a METHOD:REQUEST file, preserves its exact text, and shows the imported count', async () => {
    pending = file; const view = await mount();
    expect(view.container.textContent).toContain('meeting.ics'); expect(view.container.textContent).toContain('Import a local copy. This does not send a meeting response.'); expect(calendar.importFileIcs).not.toHaveBeenCalled(); expect(api.acknowledgeOpen).not.toHaveBeenCalled();
    const picker = view.byLabel('Import into local calendar') as HTMLSelectElement;
    expect([...picker.options].map(option => option.text)).toEqual(['Work', 'Personal']);
    act(() => { picker.value = 'personal'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    fire(button(view, 'Import events'), 'click'); await settle();
    expect(calendar.importFileIcs).toHaveBeenCalledExactlyOnceWith({ calendarId: 'personal', text: file.text });
    expect(view.container.textContent).toContain('2 events imported into Personal.'); expect(api.acknowledgeOpen).not.toHaveBeenCalled();
    expect(button(view, 'Import events')).toBeNull(); fire(button(view, 'Done'), 'click'); await settle();
    expect(api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith(file.id);
  });

  it('keeps failed calendar imports editable and never imports twice while a request is pending', async () => {
    pending = file; let resolve!: (result: Awaited<ReturnType<LocalCalendarAPI['importFileIcs']>>) => void;
    calendar.importFileIcs.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount(); const importButton = button(view, 'Import events')!; fire(importButton, 'click'); fire(importButton, 'click');
    expect(calendar.importFileIcs).toHaveBeenCalledOnce(); expect((view.byLabel('Close system-open request') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ success: false, error: 'This file is not valid iCalendar.' }));
    expect(view.find('[role="alert"]')?.textContent).toContain('not valid iCalendar'); expect(view.byLabel('Import into local calendar')).not.toBeNull(); expect(api.acknowledgeOpen).not.toHaveBeenCalled();
    fire(button(view, 'Cancel'), 'click'); await settle(); expect(api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith(file.id);
  });

  it('retains an import receipt across temporary suppression and acknowledgement failure', async () => {
    pending = file; api.acknowledgeOpen.mockRejectedValueOnce(new Error('Could not acknowledge.'));
    const onOpenChange = vi.fn();
    const view = await mount({ onOpenChange }); expect(onOpenChange).toHaveBeenLastCalledWith(true); fire(button(view, 'Import events'), 'click'); await settle();
    view.rerender(<ExternalOpenIntents suppressed onCompose={onCompose} onOpenChange={onOpenChange} />); expect(view.find('[role="dialog"]')).toBeNull(); expect(onOpenChange).toHaveBeenLastCalledWith(false);
    view.rerender(<ExternalOpenIntents onCompose={onCompose} onOpenChange={onOpenChange} />); expect(view.container.textContent).toContain('2 events imported'); expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fire(button(view, 'Done'), 'click'); await settle(); expect(view.find('[role="alert"]')?.textContent).toBe('Could not acknowledge.');
    fire(button(view, 'Done'), 'click'); await settle(); expect(calendar.importFileIcs).toHaveBeenCalledOnce(); expect(api.acknowledgeOpen).toHaveBeenCalledTimes(2);
  });

  it('shows calendar subscriptions as unsupported locally and only copies their URL on request', async () => {
    const url = 'webcal://calendar.example.com/private.ics'; pending = { id: 'link-1', kind: 'calendar-link', url };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const view = await mount(); expect(view.container.textContent).toContain('This link has not been fetched or added.');
    expect((view.byLabel('Calendar subscription URL') as HTMLTextAreaElement).value).toBe(url); expect(view.all('a')).toHaveLength(0);
    expect(clipboard).not.toHaveBeenCalled(); fire(button(view, 'Copy link'), 'click'); await settle();
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(url); expect(button(view, 'Copied')).not.toBeNull(); expect(fetch).not.toHaveBeenCalled(); expect(calendar.importFileIcs).not.toHaveBeenCalled();
    fire(button(view, 'Close'), 'click'); await settle(); expect(api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith('link-1');
  });

  it('listens for queued requests, ignores stale queue reads and removes the listener on unmount', async () => {
    let resolve!: (result: Awaited<ReturnType<DefaultAppsAPI['getPendingOpen']>>) => void;
    api.getPendingOpen.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<ExternalOpenIntents onCompose={onCompose} />); expect(listeners.size).toBe(1);
    pending = file; notify(); await settle(); await settle();
    await act(async () => resolve(ok(compose))); expect(view.container.textContent).toContain(file.filename); expect(onCompose).not.toHaveBeenCalled();
    view.unmount(); expect(listeners.size).toBe(0);
  });

  it('does not acknowledge an email handoff which resolves after the consumer unmounts', async () => {
    pending = compose; let resolve!: (accepted: boolean) => void;
    onCompose.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount(); view.unmount(); await act(async () => resolve(true));
    expect(api.acknowledgeOpen).not.toHaveBeenCalled(); expect(view.container.isConnected).toBe(false);
  });
});
