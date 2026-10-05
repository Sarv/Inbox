// @vitest-environment happy-dom
import type { AntivirusSetupStatus } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AntivirusSetupModal } from '../../../../../src/components/antivirus/AntivirusSetupModal';
import { act, cleanup, fire, render, settle, toggle, typeInto, type Mounted } from '../../../../helpers/render';

const base: AntivirusSetupStatus = {
  endpoint: '', configured: false, enabled: false, allowedAccountIds: [], allowBody: false,
  accounts: [{ id: 'work', name: 'Work', email: 'work@example.test' }, { id: 'personal', name: 'Personal', email: 'personal@example.test' }],
};
const verified: AntivirusSetupStatus = {
  ...base, endpoint: 'https://scanner.example.test', operator: 'Example operator', region: 'Test region',
  privacyPolicyUrl: 'https://scanner.example.test/privacy', privacyTermsVersion: 'privacy-v1',
  scanPolicyVersion: 'scan-v1', metadataRetentionSeconds: 3600,
  contentLifetimeSeconds: 300, resultLifetimeSeconds: 3600,
};
let openSetup: ((payload: { extensionId: string }) => void) | undefined;
let mounted: Mounted;
const api = {
  getSetup: vi.fn(async () => ({ success: true, data: base })),
  probe: vi.fn(async (_extensionId: string, _endpoint: string, _credential?: string) => ({ success: true, data: { challenge: 'verified-challenge', setup: verified } })),
  configure: vi.fn(async () => ({ success: true })),
  disable: vi.fn(async () => ({ success: true })),
  getUnscannedWarningPreferences: vi.fn(async () => ({ success: true, data: { suppressedAccountIds: [] as string[] } })),
  resetUnscannedWarningPreference: vi.fn(async (_accountId: string) => ({ success: true })),
  onOpenSetup: (callback: typeof openSetup) => { openSetup = callback; return () => { openSetup = undefined; }; },
};
const openExternal = vi.fn(async () => ({ success: true }));

const button = (text: string) => mounted.all('button').find((element) => element.textContent === text) as HTMLButtonElement;
const checkbox = (text: string) => mounted.all('label').find((element) => element.textContent?.includes(text))?.querySelector('input') ?? null;
const open = async () => {
  act(() => openSetup?.({ extensionId: 'clamav-scan' }));
  await settle();
};
const probe = async () => {
  typeInto(mounted.byLabel('Scanner endpoint'), verified.endpoint);
  typeInto(mounted.byLabel('Authentication credential'), 'synthetic-credential');
  fire(button('Verify scanner'), 'click');
  await settle();
};

beforeEach(() => {
  api.getSetup.mockReset().mockResolvedValue({ success: true, data: base });
  api.probe.mockReset().mockResolvedValue({ success: true, data: { challenge: 'verified-challenge', setup: verified } });
  api.configure.mockReset().mockResolvedValue({ success: true });
  api.disable.mockReset().mockResolvedValue({ success: true });
  api.getUnscannedWarningPreferences.mockReset().mockResolvedValue({ success: true, data: { suppressedAccountIds: [] } });
  api.resetUnscannedWarningPreference.mockReset().mockResolvedValue({ success: true });
  openExternal.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { antivirus: api, app: { openExternal } };
  mounted = render(<AntivirusSetupModal />);
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('trusted antivirus setup', () => {
  // Breaks: consent still describes manual scans alone, hiding the automatic
  // attachment upload on Download or implying that email bodies are uploaded.
  it('discloses scan-before-save for approved accounts across mail providers', async () => {
    await open(); await probe();
    const copy = mounted.container.textContent;
    expect(copy).toContain('When you view, open or download an attachment from an approved account');
    expect(copy).toContain('view, open or save it only after a complete scan reports no threat');
    expect(copy).toContain('If scanning has not been set up for an account, you can choose to continue without scanning after a warning.');
    expect(copy).toContain('The attachment will be marked as not scanned.');
    expect(copy).toContain('every mail provider');
    expect(copy).toContain('Attachment viewing, opening and downloads do not send the email body');
    expect(checkbox('including each attachment I view, open or download')).not.toBeNull();
    expect((checkbox('Allow email body scanning') as HTMLInputElement).checked).toBe(false);
  });

  it('opens only for the app event and leaves new account consent unchecked', async () => {
    expect(mounted.find('[role="dialog"]')).toBeNull();
    await open();
    expect(api.getSetup).toHaveBeenCalledWith('clamav-scan');
    expect(mounted.all('input[type="checkbox"]').every((input) => !(input as HTMLInputElement).checked)).toBe(true);
    expect(button('Enable scanning').disabled).toBe(true);
    expect(mounted.byLabel('Authentication credential')).not.toBeNull();
  });

  it('probes through host RPC, clears the credential and presents privacy details', async () => {
    await open(); await probe();
    expect(api.probe).toHaveBeenCalledWith('clamav-scan', verified.endpoint, 'synthetic-credential');
    expect((mounted.byLabel('Authentication credential') as HTMLInputElement).value).toBe('');
    expect(mounted.container.textContent).toContain('Example operator');
    expect(mounted.container.textContent).toContain('Test region');
    expect(mounted.container.textContent).toContain('3600 seconds');
    expect(mounted.container.textContent).toContain('privacy-v1');
    expect(mounted.container.textContent).toContain('Content processing lifetimeUp to 300 seconds');
    expect(mounted.container.textContent).toContain('Result lifetimeUp to 3600 seconds');
    expect(mounted.container.textContent).toContain('cancellation requests do not prove deletion');
    expect(api.configure).not.toHaveBeenCalled();
    fire(button('Read privacy policy'), 'click');
    expect(openExternal).toHaveBeenCalledWith(verified.privacyPolicyUrl);
  });

  it('requires explicit account, attachment and separate body consent before saving', async () => {
    await open(); await probe();
    toggle(checkbox('Work'));
    expect(button('Enable scanning').disabled).toBe(true);
    toggle(checkbox('I agree to send selected attachments'));
    expect(button('Enable scanning').disabled).toBe(false);
    toggle(checkbox('Allow email body scanning'));
    expect(button('Enable scanning').disabled).toBe(true);
    toggle(checkbox('I separately agree to share email body text'));
    fire(button('Enable scanning'), 'click');
    await settle();
    expect(api.configure).toHaveBeenCalledWith('clamav-scan', {
      challenge: 'verified-challenge', allowedAccountIds: ['work'], allowBody: true,
      attachmentConsent: true, bodyConsent: true,
    });
    expect(JSON.stringify(api.configure.mock.calls)).not.toContain('synthetic-credential');
    expect(mounted.find('[role="dialog"]')).toBeNull();
  });

  it('invalidates verified consent and clears account choices when the endpoint changes', async () => {
    await open(); await probe();
    toggle(checkbox('Work')); toggle(checkbox('I agree to send selected attachments'));
    expect(button('Enable scanning').disabled).toBe(false);
    typeInto(mounted.byLabel('Scanner endpoint'), 'https://different.example.test');
    expect(button('Enable scanning').disabled).toBe(true);
    expect((checkbox('Work') as HTMLInputElement).checked).toBe(false);
    expect((checkbox('I agree to send selected attachments') as HTMLInputElement).checked).toBe(false);
    expect(api.configure).not.toHaveBeenCalled();
  });

  it('shows a failed probe and clears the credential without enabling sharing', async () => {
    api.probe.mockRejectedValueOnce(new Error('Synthetic authentication failure'));
    await open(); await probe();
    expect(mounted.find('[role="alert"]')?.textContent).toContain('Synthetic authentication failure');
    expect((mounted.byLabel('Authentication credential') as HTMLInputElement).value).toBe('');
    expect(button('Enable scanning').disabled).toBe(true);
    expect(api.configure).not.toHaveBeenCalled();
  });

  it('disables scanner consent through the host and closes on success', async () => {
    api.getSetup.mockResolvedValueOnce({ success: true, data: { ...verified, configured: true, enabled: true, allowedAccountIds: ['work'] } });
    await open();
    fire(button('Disable scanning'), 'click');
    await settle();
    expect(api.disable).toHaveBeenCalledWith('clamav-scan');
    expect(mounted.find('[role="dialog"]')).toBeNull();
  });

  // Breaks: a user cannot restore the warning hidden for one account without changing scanner consent.
  it('restores missing-setup warnings for only the account selected in scanner setup', async () => {
    api.getUnscannedWarningPreferences.mockResolvedValueOnce({ success: true, data: { suppressedAccountIds: ['work', 'personal'] } });
    await open();
    const section = mounted.byLabel('Missing-setup warnings');
    expect(section?.textContent).toContain('Work');
    expect(section?.textContent).toContain('Personal');
    fire(mounted.byLabel('Show antivirus warnings again for work@example.test'), 'click');
    await settle();
    expect(api.resetUnscannedWarningPreference).toHaveBeenCalledExactlyOnceWith('work');
    expect(mounted.byLabel('Show antivirus warnings again for work@example.test')).toBeNull();
    expect(mounted.byLabel('Show antivirus warnings again for personal@example.test')).not.toBeNull();
    expect(api.configure).not.toHaveBeenCalled();
    expect(api.disable).not.toHaveBeenCalled();
  });

  // Breaks: warning preferences for a deleted account appear as an unrelated mailbox setting.
  it('shows no reset section for unknown accounts or when no warnings are hidden', async () => {
    api.getUnscannedWarningPreferences.mockResolvedValueOnce({ success: true, data: { suppressedAccountIds: ['deleted-account'] } });
    await open();
    expect(mounted.byLabel('Missing-setup warnings')).toBeNull();
  });

  // Breaks: a preference read failure prevents the user from configuring antivirus scanning.
  it.each(['result', 'rejection'] as const)('allows scanner setup when warning preference loading fails with %s', async (failure) => {
    if (failure === 'result') api.getUnscannedWarningPreferences.mockResolvedValueOnce({ success: false, data: { suppressedAccountIds: [] } });
    else api.getUnscannedWarningPreferences.mockRejectedValueOnce(new Error('synthetic preference failure'));
    await open();
    expect(mounted.find('[role="dialog"]')).not.toBeNull();
    expect(mounted.byLabel('Scanner endpoint')).not.toBeNull();
    expect(mounted.byLabel('Missing-setup warnings')).toBeNull();
    expect(mounted.find('[role="alert"]')).toBeNull();
  });

  // Breaks: a failed reset silently claims warnings are restored instead of allowing a retry.
  it.each(['result', 'rejection'] as const)('keeps the preference and supports retry after a reset %s failure', async (failure) => {
    api.getUnscannedWarningPreferences.mockResolvedValueOnce({ success: true, data: { suppressedAccountIds: ['work'] } });
    if (failure === 'result') api.resetUnscannedWarningPreference.mockResolvedValueOnce({ success: false });
    else api.resetUnscannedWarningPreference.mockRejectedValueOnce(new Error('synthetic private path'));
    await open();
    fire(mounted.byLabel('Show antivirus warnings again for work@example.test'), 'click');
    await settle();
    expect(mounted.find('[role="alert"]')?.textContent).toBe('Could not restore antivirus warnings. Try again.');
    expect(mounted.container.textContent).not.toContain('synthetic private path');
    expect(mounted.byLabel('Show antivirus warnings again for work@example.test')).not.toBeNull();
    fire(mounted.byLabel('Show antivirus warnings again for work@example.test'), 'click');
    await settle();
    expect(api.resetUnscannedWarningPreference).toHaveBeenCalledTimes(2);
    expect(mounted.byLabel('Missing-setup warnings')).toBeNull();
  });

  // Breaks: a user without an account display name cannot identify its hidden warning preference.
  it('uses the account email as the reset label when a display name is absent', async () => {
    api.getSetup.mockResolvedValueOnce({ success: true, data: { ...base, accounts: [{ id: 'work', name: '', email: 'work@example.test' }] } });
    api.getUnscannedWarningPreferences.mockResolvedValueOnce({ success: true, data: { suppressedAccountIds: ['work'] } });
    await open();
    expect(mounted.byLabel('Missing-setup warnings')?.textContent).toContain('work@example.test');
  });

  // Breaks: repeated clicks submit duplicate resets while a preference is being saved.
  it('disables reset controls while saving and ignores late success after setup closes', async () => {
    let resolve!: (value: { success: boolean }) => void;
    api.getUnscannedWarningPreferences.mockResolvedValueOnce({ success: true, data: { suppressedAccountIds: ['work'] } });
    api.resetUnscannedWarningPreference.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await open();
    const resetButton = mounted.byLabel('Show antivirus warnings again for work@example.test');
    fire(resetButton, 'click'); fire(resetButton, 'click');
    expect(resetButton?.textContent).toBe('Restoring…');
    expect((resetButton as HTMLButtonElement).disabled).toBe(true);
    expect(api.resetUnscannedWarningPreference).toHaveBeenCalledTimes(1);
    fire(button('Cancel'), 'click');
    await act(async () => resolve({ success: true }));
    expect(mounted.find('[role="dialog"]')).toBeNull();
  });

  // Breaks: a late reset rejection reopens or mutates a scanner setup dialog that was closed.
  it('ignores late reset errors after setup closes', async () => {
    let reject!: (failure: Error) => void;
    api.getUnscannedWarningPreferences.mockResolvedValueOnce({ success: true, data: { suppressedAccountIds: ['work'] } });
    api.resetUnscannedWarningPreference.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    await open();
    fire(mounted.byLabel('Show antivirus warnings again for work@example.test'), 'click');
    fire(button('Cancel'), 'click');
    await act(async () => reject(new Error('late preference failure')));
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.find('[role="alert"]')).toBeNull();
  });
});
