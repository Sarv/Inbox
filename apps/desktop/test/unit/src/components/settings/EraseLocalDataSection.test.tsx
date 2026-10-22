// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdvancedTab } from '../../../../../src/components/settings/AdvancedTab';
import { EraseLocalDataSection } from '../../../../../src/components/settings/EraseLocalDataSection';
import type { LocalDataProfiles as Profiles } from '../../../../../src/types/local-data';
import { act, cleanup, fire, render, settle, toggle, typeInto, type Mounted } from '../../../../helpers/render';

type EraseResult = { success: boolean; data?: { restarting: boolean; requiresManualStart?: boolean }; error?: string };
const initial: Profiles = {
  currentProfile: 'production', profiles: [
    { id: 'production', label: 'Production', current: true, exists: true, running: true, path: '/mock/production' },
    { id: 'development', label: 'Development', current: false, exists: true, running: false, path: '/mock/development' },
  ],
};
let profiles: Profiles;
const getProfiles = vi.fn<() => Promise<{ success: boolean; data?: Profiles; error?: string }>>();
const erase = vi.fn<(input: { profile: 'production' | 'development'; confirmation: string }) => Promise<EraseResult>>();
const button = (view: Mounted, name: string) => view.all('button').find(element => element.textContent === name) as HTMLButtonElement | undefined;
const openDialog = async (view: Mounted) => { fire(button(view, 'Erase all local data…')!, 'click'); await settle(); };
const mount = async () => { const view = render(<EraseLocalDataSection />); await settle(); return view; };

beforeEach(() => {
  profiles = structuredClone(initial);
  getProfiles.mockReset().mockImplementation(async () => ({ success: true, data: structuredClone(profiles) }));
  erase.mockReset().mockResolvedValue({ success: false, error: 'Cancelled in system confirmation.' });
  window.electronAPI = { localData: { getProfiles, erase } } as unknown as typeof window.electronAPI;
});
afterEach(cleanup);

describe('EraseLocalDataSection', () => {
  it('is available in Advanced beside the existing storage and threading settings', async () => {
    const getUsage = vi.fn(async () => ({ success: true, data: [] }));
    window.electronAPI = { localData: { getProfiles, erase }, storage: { getUsage } } as unknown as typeof window.electronAPI;
    const view = render(<AdvancedTab />); await settle();
    expect(view.byLabel('Erase all local data')).not.toBeNull();
    expect(view.container.textContent).toContain('Conversation Threading');
    expect(view.container.textContent).toContain('No open account databases to compress');
    expect(getUsage).toHaveBeenCalledOnce(); expect(erase).not.toHaveBeenCalled();
  });

  it('defaults to the current profile and explains local losses and preserved data before any mutation', async () => {
    const view = await mount();
    expect((view.byLabel('Production (current profile)') as HTMLInputElement).checked).toBe(true);
    expect((view.byLabel('Development') as HTMLInputElement).checked).toBe(false);
    expect(view.container.textContent).toContain('/mock/production');
    expect(view.container.textContent).toContain('accounts, saved passwords and sign-in tokens, drafts and outbox, Inbox Agent chats, contacts, local calendars, and settings');
    expect(view.container.textContent).toContain('Mail on your email servers and the other Inbox profile are unaffected');
    expect(view.container.textContent).toContain('Browser sign-in sessions');
    expect(view.container.textContent).toContain('Keychain encryption master are preserved');
    expect(erase).not.toHaveBeenCalled(); expect(getProfiles).toHaveBeenCalledOnce();
  });

  it('uses a development build’s current profile by default instead of assuming production', async () => {
    profiles.currentProfile = 'development'; profiles.profiles.forEach(profile => { profile.current = profile.id === 'development'; profile.running = profile.current; });
    const view = await mount(); await openDialog(view);
    expect((view.byLabel('Development (current profile)') as HTMLInputElement).checked).toBe(true);
    expect(view.find('[role="alertdialog"]')?.textContent).toContain('Type ERASE development to confirm');
    expect(view.find('[role="alertdialog"]')?.textContent).toContain('/mock/development');
    expect(button(view, 'Erase and quit')).toBeDefined();
    expect(view.find('[role="alertdialog"]')?.textContent).toContain('restart your development server after the reset finishes');
    expect(view.find('[role="alertdialog"]')?.textContent).not.toContain('Inbox will close and restart');
  });

  it('requires the exact case-sensitive profile phrase and only passes the fixed profile id to native confirmation', async () => {
    const view = await mount(); await openDialog(view);
    const form = view.find('form')!;
    for (const invalid of ['', 'ERASE', 'erase production', 'ERASE development', 'ERASE production ']) {
      typeInto(view.byLabel('Erase confirmation'), invalid);
      expect(button(view, 'Erase selected profile')!.disabled).toBe(true);
      fire(form, 'submit'); expect(erase).not.toHaveBeenCalled();
    }
    typeInto(view.byLabel('Erase confirmation'), 'ERASE production');
    expect(button(view, 'Erase selected profile')!.disabled).toBe(false);
    fire(form, 'submit'); await settle();
    expect(erase).toHaveBeenCalledExactlyOnceWith({ profile: 'production', confirmation: 'ERASE production' });
    expect(view.find('[role="alert"]')?.textContent).toBe('Cancelled in system confirmation.');
    expect(view.find('[role="alertdialog"]')).not.toBeNull();
  });

  it('refreshes metadata on profile selection and every dialog open, resetting the typed confirmation', async () => {
    const view = await mount(); toggle(view.byLabel('Development')); await settle();
    expect(getProfiles).toHaveBeenCalledTimes(2);
    await openDialog(view); expect(getProfiles).toHaveBeenCalledTimes(3);
    typeInto(view.byLabel('Erase confirmation'), 'ERASE development');
    fire(button(view, 'Cancel')!, 'click');
    await openDialog(view); expect(getProfiles).toHaveBeenCalledTimes(4);
    expect((view.byLabel('Erase confirmation') as HTMLInputElement).value).toBe('');
    expect(erase).not.toHaveBeenCalled();
  });

  it('blocks a running other profile and a profile with no local data, while allowing a current running profile', async () => {
    profiles.profiles[1]!.running = true;
    const view = await mount(); expect(button(view, 'Erase all local data…')!.disabled).toBe(false);
    toggle(view.byLabel('Development')); await settle();
    expect(button(view, 'Erase all local data…')!.disabled).toBe(true);
    expect(view.container.textContent).toContain('Close the development Inbox app');
    profiles.profiles[1]!.running = false; profiles.profiles[1]!.exists = false;
    fire(button(view, 'Refresh profile status')!, 'click'); await settle();
    expect(button(view, 'Erase all local data…')!.disabled).toBe(true);
    expect(view.container.textContent).toContain('No local profile data found');
    expect(erase).not.toHaveBeenCalled();
  });

  it('rechecks before enabling the confirmation if the other app started after selection', async () => {
    const view = await mount(); toggle(view.byLabel('Development')); await settle();
    profiles.profiles[1]!.running = true;
    await openDialog(view); typeInto(view.byLabel('Erase confirmation'), 'ERASE development');
    expect(view.find('[role="alert"]')?.textContent).toContain('Close the development Inbox app');
    expect(button(view, 'Erase selected profile')!.disabled).toBe(true);
    fire(view.find('form')!, 'submit'); expect(erase).not.toHaveBeenCalled();
  });

  it('surfaces an explicit backend profile block and never allows that target to be erased', async () => {
    profiles.profiles[1]!.blockedReason = 'Synthetic profile path is not supported for reset.';
    const view = await mount(); toggle(view.byLabel('Development')); await settle();
    expect(view.container.textContent).toContain('Synthetic profile path is not supported for reset.');
    expect(button(view, 'Erase all local data…')!.disabled).toBe(true);
    expect(erase).not.toHaveBeenCalled();
  });

  it('contains keyboard focus, closes with Escape/cancel, and restores the opener without erasing', async () => {
    const view = await mount(); const opener = button(view, 'Erase all local data…')!; opener.focus();
    await openDialog(view);
    const dialog = view.find('[role="alertdialog"]')!;
    const heading = document.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    expect(document.activeElement).toBe(heading);
    const outsideKeys = vi.fn(); window.addEventListener('keydown', outsideKeys);
    fire(heading, 'keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(button(view, 'Cancel'));
    fire(button(view, 'Cancel')!, 'keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(view.byLabel('Close erase local data dialog'));
    fire(view.byLabel('Erase confirmation'), 'keydown', { key: 'Escape' });
    expect(view.find('[role="alertdialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(outsideKeys).not.toHaveBeenCalled(); window.removeEventListener('keydown', outsideKeys);
    await openDialog(view); fire(button(view, 'Cancel')!, 'click');
    expect(view.find('[role="alertdialog"]')).toBeNull(); expect(erase).not.toHaveBeenCalled();
  });

  it('single-flights the native request and prevents closing or editing while it is pending', async () => {
    let resolve!: (result: EraseResult) => void;
    erase.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount(); await openDialog(view); typeInto(view.byLabel('Erase confirmation'), 'ERASE production');
    fire(view.find('form')!, 'submit'); fire(view.find('form')!, 'submit');
    expect(erase).toHaveBeenCalledOnce();
    expect((view.byLabel('Erase confirmation') as HTMLInputElement).disabled).toBe(true);
    expect(button(view, 'Cancel')!.disabled).toBe(true);
    fire(view.byLabel('Erase confirmation'), 'keydown', { key: 'Escape' });
    expect(view.find('[role="alertdialog"]')).not.toBeNull();
    await act(async () => resolve({ success: false, error: 'System confirmation declined.' }));
    expect(view.find('[role="alert"]')?.textContent).toBe('System confirmation declined.');
    expect(button(view, 'Erase selected profile')!.disabled).toBe(false);
  });

  it('keeps focus in the reset section when Escape closes a dialog while its metadata refresh is pending', async () => {
    let resolve!: (result: { success: boolean; data?: Profiles }) => void;
    const view = await mount();
    getProfiles.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    button(view, 'Erase all local data…')!.focus(); fire(button(view, 'Erase all local data…')!, 'click');
    fire(view.byLabel('Erase confirmation'), 'keydown', { key: 'Escape' });
    expect(view.find('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(view.find('h3'));
    await act(async () => resolve({ success: true, data: structuredClone(profiles) }));
    expect(button(view, 'Erase all local data…')!.disabled).toBe(false); expect(erase).not.toHaveBeenCalled();
  });

  it('shows metadata errors and allows a fresh read without enabling an unverified target', async () => {
    getProfiles.mockResolvedValueOnce({ success: false, error: 'Synthetic profile check failed.' });
    const view = await mount();
    expect(view.find('[role="alert"]')?.textContent).toBe('Synthetic profile check failed.');
    expect(button(view, 'Erase all local data…')!.disabled).toBe(true);
    fire(button(view, 'Refresh profile status')!, 'click'); await settle();
    expect(view.find('[role="alert"]')).toBeNull();
    expect(button(view, 'Erase all local data…')!.disabled).toBe(false); expect(erase).not.toHaveBeenCalled();
  });

  it('surfaces a rejected native request and preserves the selected target and confirmation for retry', async () => {
    erase.mockRejectedValueOnce(new Error('Synthetic reset failed.'));
    const view = await mount(); await openDialog(view); typeInto(view.byLabel('Erase confirmation'), 'ERASE production');
    fire(view.find('form')!, 'submit'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toBe('Synthetic reset failed.');
    expect((view.byLabel('Erase confirmation') as HTMLInputElement).value).toBe('ERASE production');
    expect(button(view, 'Erase selected profile')!.disabled).toBe(false);
  });

  it('reports a current-profile restart without claiming deletion has already completed or allowing a duplicate reset', async () => {
    erase.mockResolvedValueOnce({ success: true, data: { restarting: true } });
    const view = await mount(); await openDialog(view); typeInto(view.byLabel('Erase confirmation'), 'ERASE production');
    fire(view.find('form')!, 'submit'); await settle();
    expect(view.find('[role="alertdialog"]')).toBeNull();
    expect(view.container.textContent).toContain('Inbox is restarting to finish erasing the production profile.');
    expect(view.container.textContent).not.toContain('Local data erased for');
    expect(button(view, 'Erase all local data…')!.disabled).toBe(true); expect(getProfiles).toHaveBeenCalledTimes(2);
  });

  it('reports another closed profile erased and refreshes its state without changing the current profile', async () => {
    erase.mockImplementationOnce(async () => { profiles.profiles[1]!.exists = false; return { success: true, data: { restarting: false } }; });
    const view = await mount(); toggle(view.byLabel('Development')); await settle(); await openDialog(view);
    typeInto(view.byLabel('Erase confirmation'), 'ERASE development'); fire(view.find('form')!, 'submit'); await settle();
    expect(erase).toHaveBeenCalledExactlyOnceWith({ profile: 'development', confirmation: 'ERASE development' });
    expect(view.container.textContent).toContain('Local data erased for the development profile.');
    expect(view.container.textContent).toContain('No local profile data found.');
    expect(profiles.currentProfile).toBe('production'); expect(profiles.profiles[0]!.exists).toBe(true);
  });

  it('reports a current development reset as quitting and requiring a manual dev-server restart', async () => {
    profiles.currentProfile = 'development'; profiles.profiles.forEach(profile => { profile.current = profile.id === 'development'; profile.running = profile.current; });
    erase.mockResolvedValueOnce({ success: true, data: { restarting: true, requiresManualStart: true } });
    const view = await mount(); await openDialog(view); typeInto(view.byLabel('Erase confirmation'), 'ERASE development');
    fire(view.find('form')!, 'submit'); await settle();
    expect(view.container.textContent).toContain('Inbox is quitting to erase the development profile. Restart your development server after the reset finishes.');
    expect(view.container.textContent).not.toContain('Inbox is restarting');
    expect(button(view, 'Erase all local data…')!.disabled).toBe(true);
    expect(erase).toHaveBeenCalledExactlyOnceWith({ profile: 'development', confirmation: 'ERASE development' });
  });

  it('ignores an erase response after unmount instead of refreshing or displaying another reset', async () => {
    let resolve!: (result: EraseResult) => void;
    erase.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount(); await openDialog(view); typeInto(view.byLabel('Erase confirmation'), 'ERASE production');
    fire(view.find('form')!, 'submit'); view.unmount();
    await act(async () => resolve({ success: true, data: { restarting: false } }));
    expect(getProfiles).toHaveBeenCalledTimes(2); expect(view.container.isConnected).toBe(false);
  });
});
