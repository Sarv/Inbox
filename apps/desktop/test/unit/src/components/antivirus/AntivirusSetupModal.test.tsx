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
  openExternal.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { antivirus: api, app: { openExternal } };
  mounted = render(<AntivirusSetupModal />);
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('trusted antivirus setup', () => {
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
});
