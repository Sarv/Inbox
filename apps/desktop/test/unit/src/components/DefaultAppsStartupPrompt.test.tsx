// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DefaultAppsStartupPrompt } from '../../../../src/components/DefaultAppsStartupPrompt';
import type { DefaultAppResult, DefaultAppsAPI, DefaultAppsState } from '../../../../src/types/default-apps';
import { act, cleanup, fire, render, settle, toggle } from '../../../helpers/render';

const ok = <T,>(data: T) => ({ success: true as const, data });
function seed(): DefaultAppsState {
  return { platform: 'darwin', packaged: true, shouldPrompt: true, suppressPrompt: false, email: { status: 'not-default', canRequest: true, method: 'protocol' }, calendar: { status: 'not-default', canRequest: true, method: 'file-association' } };
}
let state: DefaultAppsState;
const api = {
  getStatus: vi.fn<DefaultAppsAPI['getStatus']>(async () => ok(state)),
  requestDefault: vi.fn<DefaultAppsAPI['requestDefault']>(async target => {
    state = { ...state, [target]: { ...state[target], status: 'default' } };
    return ok({ state, outcome: 'default' as const, message: `Inbox is now the default ${target} app.` });
  }),
  openSettings: vi.fn<DefaultAppsAPI['openSettings']>(async () => ok({ opened: true })),
  setPromptSuppressed: vi.fn<DefaultAppsAPI['setPromptSuppressed']>(async suppressed => { state = { ...state, suppressPrompt: suppressed, shouldPrompt: !suppressed }; return ok(state); }),
};
function button(view: ReturnType<typeof render>, label: string) { return view.all('button').find(item => item.textContent?.trim() === label) ?? null; }
function dontAsk(view: ReturnType<typeof render>) { return view.all('label').find(item => item.textContent?.trim() === 'Don’t ask again')?.querySelector('input') ?? null; }
async function mount(props = {}) { const view = render(<DefaultAppsStartupPrompt {...props} />); await settle(); return view; }

beforeEach(() => {
  state = seed(); vi.clearAllMocks();
  api.getStatus.mockImplementation(async () => ok(state));
  api.requestDefault.mockImplementation(async target => {
    state = { ...state, [target]: { ...state[target], status: 'default' } };
    return ok({ state, outcome: 'default' as const, message: `Inbox is now the default ${target} app.` });
  });
  api.openSettings.mockResolvedValue(ok({ opened: true }));
  api.setPromptSuppressed.mockImplementation(async suppressed => { state = { ...state, suppressPrompt: suppressed, shouldPrompt: !suppressed }; return ok(state); });
  Object.assign(window, { electronAPI: { defaultApps: api } });
});
afterEach(cleanup);

describe('default app startup opt-in', () => {
  it('only reads defaults on startup and never registers anything without an explicit action', async () => {
    const view = await mount();
    expect(view.byLabel('Use Inbox for email')).not.toBeNull();
    expect(view.byLabel('Use Inbox for calendar')).not.toBeNull();
    expect(view.container.textContent).toContain('Calendar files (.ics)');
    expect(api.getStatus).toHaveBeenCalledOnce(); expect(api.requestDefault).not.toHaveBeenCalled(); expect(api.openSettings).not.toHaveBeenCalled(); expect(api.setPromptSuppressed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(view.find('#default-apps-title'));
    fire(document.activeElement, 'keydown', { key: 'Enter' }); expect(api.requestDefault).not.toHaveBeenCalled();
  });

  it('honors stored suppression and the backend decision that no prompt is needed', async () => {
    state = { ...seed(), shouldPrompt: false }; const first = await mount(); expect(first.find('[role="dialog"]')).toBeNull(); first.unmount();
    state = { ...seed(), suppressPrompt: true }; const second = await mount(); expect(second.find('[role="dialog"]')).toBeNull();
    expect(api.requestDefault).not.toHaveBeenCalled();
  });

  it('supports separate Email and Calendar choices and verifies the chosen target only', async () => {
    const view = await mount(); toggle(view.byLabel('Use Inbox for calendar'));
    fire(button(view, 'Make default'), 'click'); await settle();
    expect(api.requestDefault).toHaveBeenCalledExactlyOnceWith('email');
    expect(view.container.textContent).toContain('Inbox is now the default email app.');
    expect(view.container.textContent).toContain('Already default');
    expect((view.byLabel('Use Inbox for email') as HTMLInputElement).disabled).toBe(true);
    expect((view.byLabel('Use Inbox for calendar') as HTMLInputElement).checked).toBe(false);
  });

  it('does not repeat already-default targets or report a settings handoff as confirmed success', async () => {
    state.email = { ...state.email, status: 'default' }; state.calendar = { ...state.calendar, status: 'unknown', method: 'settings' };
    api.requestDefault.mockResolvedValueOnce(ok({ state, outcome: 'settings-opened', message: 'Choose Inbox for .ics files in system settings, then check again.' }));
    const view = await mount(); fire(button(view, 'Make default'), 'click'); await settle();
    expect(api.requestDefault).toHaveBeenCalledExactlyOnceWith('calendar');
    expect(view.container.textContent).toContain('Choose Inbox for .ics files');
    expect(view.all('span').filter(item => item.textContent === 'Already default')).toHaveLength(1);
    state = { ...state, calendar: { ...state.calendar, status: 'default' } };
    fire(button(view, 'Check defaults again'), 'click'); await settle();
    expect((view.byLabel('Use Inbox for calendar') as HTMLInputElement).disabled).toBe(true);
    expect((button(view, 'Make default') as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves Not now local to this launch and persists Don’t ask again only when explicitly chosen', async () => {
    const first = await mount(); fire(button(first, 'Not now'), 'click'); expect(first.find('[role="dialog"]')).toBeNull();
    expect(api.setPromptSuppressed).not.toHaveBeenCalled(); first.unmount();
    const second = await mount(); toggle(dontAsk(second)); fire(button(second, 'Not now'), 'click'); await settle();
    expect(api.setPromptSuppressed).toHaveBeenCalledExactlyOnceWith(true); expect(second.find('[role="dialog"]')).toBeNull(); second.unmount();
    const third = await mount(); expect(third.find('[role="dialog"]')).toBeNull(); expect(api.requestDefault).not.toHaveBeenCalled();
  });

  it('keeps preference save failures visible and lets the user close without saving that preference', async () => {
    api.setPromptSuppressed.mockRejectedValueOnce(new Error('Could not save your preference.'));
    const view = await mount(); toggle(dontAsk(view)); fire(button(view, 'Not now'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toBe('Could not save your preference.'); expect(view.find('[role="dialog"]')).not.toBeNull();
    toggle(dontAsk(view)); fire(button(view, 'Not now'), 'click'); expect(view.find('[role="dialog"]')).toBeNull();
  });

  it('allows an explicit Don’t ask again choice to be cleared before finishing', async () => {
    const view = await mount(); toggle(dontAsk(view)); fire(button(view, 'Make default'), 'click'); await settle();
    expect(api.setPromptSuppressed).toHaveBeenCalledWith(true);
    toggle(dontAsk(view)); fire(button(view, 'Done'), 'click'); await settle();
    expect(api.setPromptSuppressed).toHaveBeenLastCalledWith(false); expect(view.find('[role="dialog"]')).toBeNull();
  });

  it('does not override an unreadable stored prompt preference or request defaults when status loading fails', async () => {
    api.getStatus.mockRejectedValueOnce(new Error('Preference database unavailable.'));
    const view = await mount(); expect(view.find('[role="dialog"]')).toBeNull();
    expect(api.requestDefault).not.toHaveBeenCalled(); expect(api.setPromptSuppressed).not.toHaveBeenCalled();
  });

  it('shows platform limitations and system-settings errors instead of claiming to change defaults', async () => {
    state = { ...state, packaged: false, email: { status: 'unsupported', canRequest: false, method: 'none', detail: 'Install Inbox to choose it as your default app.' }, calendar: { status: 'unknown', canRequest: false, method: 'none', detail: 'Calendar file association cannot be checked in this build.' } };
    api.openSettings.mockResolvedValueOnce(ok({ opened: false }));
    const view = await mount(); expect((button(view, 'Make default') as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.textContent).toContain('Install Inbox');
    fire(button(view, 'Open system default app settings'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('could not be opened'); expect(api.requestDefault).not.toHaveBeenCalled();
  });

  it('retains per-target errors while trying the other selected target and blocks duplicate requests', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.requestDefault>>) => void;
    api.requestDefault.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount(); const make = button(view, 'Make default')!; fire(make, 'click'); fire(make, 'click');
    fire(view.find('#default-apps-title'), 'keydown', { key: 'Escape' }); expect(view.find('[role="dialog"]')).not.toBeNull(); expect(api.requestDefault).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ success: false, error: 'Email permission was declined.' })); await settle();
    expect(api.requestDefault.mock.calls.map(call => call[0])).toEqual(['email', 'calendar']);
    expect(view.find('[role="alert"]')?.textContent).toContain('Email permission was declined.');
    expect(view.container.textContent).toContain('Inbox is now the default calendar app.');
  });

  it('defers focus while suppressed, traps keyboard focus when open and restores the originating control', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    const onOpenChange = vi.fn(); const view = await mount({ suppressed: true, onOpenChange });
    expect(document.activeElement).toBe(opener); expect(view.find('[role="dialog"]')).toBeNull();
    view.rerender(<DefaultAppsStartupPrompt suppressed={false} onOpenChange={onOpenChange} />);
    expect(document.activeElement).toBe(view.find('#default-apps-title'));
    const make = button(view, 'Make default')!; make.focus(); fire(make, 'keydown', { key: 'Tab' }); expect(document.activeElement).toBe(view.byLabel('Close default app prompt'));
    fire(document.activeElement, 'keydown', { key: 'Escape' }); expect(view.find('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(onOpenChange).toHaveBeenCalledWith(true); expect(onOpenChange).toHaveBeenLastCalledWith(false); opener.remove();
  });

  it('ignores a late startup status after unmount and stops the remaining request sequence after leaving', async () => {
    let status!: (value: DefaultAppResult<DefaultAppsState>) => void;
    api.getStatus.mockImplementationOnce(() => new Promise(done => { status = done; }));
    const first = render(<DefaultAppsStartupPrompt />); first.unmount(); await act(async () => status(ok(state))); expect(first.container.isConnected).toBe(false);
    let resolve!: (value: Awaited<ReturnType<typeof api.requestDefault>>) => void;
    api.requestDefault.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const second = await mount(); fire(button(second, 'Make default'), 'click'); second.unmount();
    await act(async () => resolve(ok({ state, outcome: 'default', message: 'Email default updated.' })));
    expect(api.requestDefault).toHaveBeenCalledTimes(1);
  });
});
