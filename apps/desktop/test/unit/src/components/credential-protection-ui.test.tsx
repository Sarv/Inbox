// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SavedAIKeyStorageNotice } from '../../../../src/components/SavedAIKeyStorageNotice';
import { CredentialStorageStatus } from '../../../../src/components/security/CredentialStorageStatus';
import { SecurityStatusBanner } from '../../../../src/components/SecurityStatusBanner';
import { VaultPasswordField } from '../../../../src/components/VaultPasswordField';
import { useSecureStorageProtected } from '../../../../src/hooks/useSecureStorageProtected';
import { useSecureStorageStatus } from '../../../../src/hooks/useSecureStorageStatus';
import type { SecureStorageStatus } from '../../../../src/types/secure-storage';
import { act, cleanup, fire, render, settle } from '../../../helpers/render';

type Result = { success: boolean; data?: SecureStorageStatus; error?: string };
const base: SecureStorageStatus = { platform: 'darwin', keyStore: 'available', databaseKey: 'encrypted', databaseKeyProtection: 'encrypted', databaseReadable: true, stores: [
  { id: 'credentials', label: 'Email passwords', envelope: 'encrypted', protectedByDatabase: false, protection: 'encrypted' },
  { id: 'oauth-tokens', label: 'OAuth tokens', envelope: 'plaintext', protectedByDatabase: true, protection: 'encrypted' },
  { id: 'ai-keys', label: 'AI API keys', envelope: 'plaintext', protectedByDatabase: true, protection: 'encrypted' },
] };
let current: SecureStorageStatus;
const status = vi.fn<() => Promise<Result>>(async () => ({ success: true, data: current }));
const available = vi.fn(async () => ({ success: true, data: false }));
const hasPassword = vi.fn(async () => ({ success: true, data: true }));
const reveal = vi.fn(async () => ({ success: false, error: 'auth-cancelled' }));
type AccessResult = { success: boolean; data?: { outcome: 'authorized' | 'cancelled' | 'unavailable'; status: number; restarting?: boolean }; error?: string };
const requestAccess = vi.fn<() => Promise<AccessResult>>();
async function mount(element: React.ReactElement) { const view = render(element); await settle(); return view; }
function Probe() {
  const value = useSecureStorageStatus();
  return <><output>{value.status?.databaseKey ?? 'unknown'}</output><button onClick={() => void value.retry()}>Retry status</button></>;
}
function AccessProbe() {
  const value = useSecureStorageStatus();
  return <><output>{value.accessMessage ?? 'No request'}</output><button onClick={() => void value.requestAccess()}>Request access</button><span>{value.requestingAccess ? 'Pending' : 'Idle'}</span></>;
}
function CompatibilityProbe() { const protectedAtRest = useSecureStorageProtected(); return <output>{String(protectedAtRest)}</output>; }

beforeEach(() => {
  current = structuredClone(base); vi.clearAllMocks();
  status.mockImplementation(async () => ({ success: true, data: current }));
  requestAccess.mockReset().mockResolvedValue({ success: true, data: { outcome: 'authorized', status: 0, restarting: true } });
  Object.assign(window, { electronAPI: { secureCreds: { status, available, hasPassword, reveal, requestAccess } } });
});
afterEach(cleanup);

describe('saved credential protection UI', () => {
  it('uses saved envelope/database facts instead of the old availability boolean on a healthy Mac', async () => {
    const view = await mount(<><SecurityStatusBanner /><CredentialStorageStatus /><VaultPasswordField accountId="account" kind="imap" value="" onChange={vi.fn()} /><SavedAIKeyStorageNotice /></>);
    expect(view.container.textContent).toContain('Encrypted by the OS secure store');
    expect(view.find('[data-credential-store="oauth-tokens"]')?.textContent).toContain('Protected by encrypted database');
    expect(view.container.textContent).toContain('Saved with encryption');
    expect(view.container.textContent).not.toContain('not protected at rest'); expect(view.container.textContent).not.toContain('without encryption');
    expect(available).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled();
  });

  it('distinguishes locked Mac Keychain access from plaintext, and retries status without modifying credentials', async () => {
    current.keyStore = 'unavailable';
    const view = await mount(<SecurityStatusBanner />);
    expect(view.container.textContent).toContain('macOS Keychain is currently unavailable.'); expect(view.container.textContent).toContain('saved database key remains encrypted');
    expect(view.container.textContent).toContain('approve the macOS permission prompt'); expect(view.container.textContent).not.toMatch(/GNOME|KWallet|aren.t protected|Some saved data is not protected|Open Keychain Access/);
    expect(view.byLabel('Allow Keychain access')).not.toBeNull(); expect(requestAccess).not.toHaveBeenCalled();
    current = structuredClone(base); fire(view.byLabel('Retry credential protection check'), 'click'); await settle();
    expect(view.container.textContent).toBe(''); expect(status).toHaveBeenCalledTimes(2); expect(reveal).not.toHaveBeenCalled();
  });

  it('warns only about actual unprotected Mac stores and uses Mac recovery advice', async () => {
    current.keyStore = 'unavailable'; current.databaseKey = 'plaintext'; current.databaseKeyProtection = 'unprotected';
    current.stores[0] = { ...current.stores[0]!, envelope: 'plaintext', protection: 'unprotected' };
    const view = await mount(<SecurityStatusBanner />);
    expect(view.container.textContent).toContain('Some saved data is not protected at rest.'); expect(view.container.textContent).toContain('Email passwords');
    expect(view.container.textContent).toContain('database key is not protected'); expect(view.container.textContent).toContain('Allow Keychain access');
    expect(view.container.textContent).not.toContain('OAuth tokens'); expect(view.container.textContent).not.toContain('AI API keys'); expect(view.container.textContent).not.toContain('KWallet');
  });

  it('requests the native prompt once, shows restart progress and retains actual saved protection facts', async () => {
    current.keyStore = 'unavailable'; current.databaseKeyProtection = 'unprotected';
    let resolve!: (result: AccessResult) => void;
    requestAccess.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount(<SecurityStatusBanner />);
    const allow = view.byLabel('Allow Keychain access') as HTMLButtonElement;
    fire(allow, 'click'); fire(allow, 'click'); await settle();
    expect(requestAccess).toHaveBeenCalledOnce(); expect(allow.disabled).toBe(true);
    expect(view.container.textContent).toContain('Waiting for macOS');
    expect((view.byLabel('Retry credential protection check') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ success: true, data: { outcome: 'authorized', status: 0, restarting: true } }));
    expect(view.container.textContent).toContain('Restarting Inbox to retry Keychain access and verify saved storage protection');
    expect(view.container.textContent).not.toMatch(/Keychain access allowed|permission was granted/);
    expect(view.container.textContent).toContain('database key is not protected');
    expect(view.container.textContent).not.toContain('Encrypted by the OS secure store');
    expect(allow.disabled).toBe(true); expect(status).toHaveBeenCalledOnce(); expect(reveal).not.toHaveBeenCalled();
  });

  it('provides the same explicit permission control in Security overview and keeps metadata checks prompt-free', async () => {
    current.keyStore = 'unavailable';
    requestAccess.mockResolvedValue({ success: true, data: { outcome: 'authorized', status: 0 } });
    const view = await mount(<CredentialStorageStatus />);
    const check = view.all('button').find(button => button.textContent?.includes('Check protection again'))!;
    fire(check, 'click'); await settle();
    expect(status).toHaveBeenCalledTimes(2); expect(requestAccess).not.toHaveBeenCalled();
    current = structuredClone(base);
    fire(view.byLabel('Allow Keychain access'), 'click'); await settle();
    expect(requestAccess).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledTimes(3);
    expect(view.byLabel('Allow Keychain access')).toBeNull();
    expect(view.container.textContent).toContain('Secure storage is available. Rechecking saved protection');
    expect(view.container.textContent).toContain('Encrypted by the OS secure store');
  });

  it.each<['cancelled' | 'unavailable', string]>([
    ['cancelled', 'request was cancelled'], ['unavailable', 'access is still unavailable'],
  ])('keeps existing protection metadata on a %s permission result', async (outcome, message) => {
    current.keyStore = 'unavailable'; current.databaseKeyProtection = 'unprotected';
    requestAccess.mockResolvedValue({ success: true, data: { outcome, status: -1 } });
    const view = await mount(<CredentialStorageStatus />);
    fire(view.byLabel('Allow Keychain access'), 'click'); await settle();
    expect(view.container.textContent).toContain(message);
    expect(view.container.textContent).toContain('Unprotected saved key');
    expect(view.container.textContent).not.toMatch(/permission was granted|access allowed|Secure storage is available|Restarting Inbox|Encrypted by the OS secure store/);
    expect((view.byLabel('Allow Keychain access') as HTMLButtonElement).disabled).toBe(false);
    expect(status).toHaveBeenCalledOnce(); expect(reveal).not.toHaveBeenCalled();
  });

  it('shows permission request failures without claiming permission or encryption succeeded', async () => {
    current.keyStore = 'unavailable'; current.databaseKeyProtection = 'unprotected';
    requestAccess.mockRejectedValue(new Error('Synthetic native authorization failure'));
    const view = await mount(<SecurityStatusBanner />);
    fire(view.byLabel('Allow Keychain access'), 'click'); await settle();
    expect(view.container.textContent).toContain('Synthetic native authorization failure');
    expect(view.container.textContent).toContain('database key is not protected');
    expect(view.container.textContent).not.toMatch(/permission was granted|access allowed|Secure storage is available|Restarting Inbox/);
    expect((view.byLabel('Allow Keychain access') as HTMLButtonElement).disabled).toBe(false);
  });

  it('guards hook requests synchronously and ignores an authorization response after unmount', async () => {
    let resolve!: (result: AccessResult) => void;
    requestAccess.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount(<AccessProbe />);
    const button = view.all('button')[0]!;
    fire(button, 'click'); fire(button, 'click'); await settle();
    expect(requestAccess).toHaveBeenCalledOnce(); expect(view.container.textContent).toContain('Pending');
    view.unmount();
    await act(async () => resolve({ success: true, data: { outcome: 'authorized', status: 0 } }));
    expect(status).toHaveBeenCalledOnce(); expect(view.container.isConnected).toBe(false);
  });

  it.each(['linux', 'win32'] as const)('keeps %s recovery as a metadata-only check', async platform => {
    current.platform = platform; current.keyStore = 'unavailable';
    const view = await mount(<><SecurityStatusBanner /><CredentialStorageStatus /></>);
    expect(view.byLabel('Allow Keychain access')).toBeNull(); expect(requestAccess).not.toHaveBeenCalled();
    fire(view.byLabel('Retry credential protection check'), 'click'); await settle();
    expect(status).toHaveBeenCalledTimes(3); expect(requestAccess).not.toHaveBeenCalled();
  });

  it('keeps the Linux basic-text warning without claiming every secret is exposed', async () => {
    current.platform = 'linux'; current.keyStore = 'basic-text'; current.databaseKey = 'plaintext'; current.databaseKeyProtection = 'unprotected';
    current.stores[0] = { ...current.stores[0]!, envelope: 'plaintext', protection: 'unprotected' };
    const view = await mount(<SecurityStatusBanner />);
    expect(view.container.textContent).toContain('GNOME Keyring or KWallet'); expect(view.container.textContent).toContain('Email passwords');
    expect(view.container.textContent).not.toContain('OpenPGP keys'); expect(view.container.textContent).not.toContain('Keychain Access');
  });

  it('labels an obfuscated Linux database key unprotected even with an encrypted envelope and an available keyring', async () => {
    current.platform = 'linux'; current.databaseKeyProtection = 'unprotected';
    const view = await mount(<><SecurityStatusBanner /><CredentialStorageStatus /></>);
    expect(view.container.textContent).toContain('database key is not protected by the operating system');
    expect(view.container.textContent).toContain('Unprotected saved key');
    expect(view.container.textContent).not.toContain('Encrypted by the OS secure store');
  });

  it('reports failed checks as unknown and keeps the password field neutral', async () => {
    status.mockResolvedValue({ success: false, error: 'Synthetic metadata check failed.' });
    const view = await mount(<><SecurityStatusBanner /><CredentialStorageStatus /><VaultPasswordField accountId="account" kind="imap" value="" onChange={vi.fn()} /><CompatibilityProbe /></>);
    expect(view.container.textContent).toContain('Credential protection could not be checked.'); expect(view.container.textContent).toContain('Saved credential protection is unknown.');
    expect(view.container.textContent).toContain('Saved — click the eye'); expect(view.container.textContent).not.toContain('Saved with encryption'); expect(view.container.textContent).not.toContain('Saved securely');
    expect(view.find('output')?.textContent).toBe('null'); expect(available).not.toHaveBeenCalled();
  });

  it('shows unknown stores individually, and preserves encryption facts when the database cannot be read', async () => {
    current.databaseReadable = false; current.stores[0] = { ...current.stores[0]!, envelope: 'unknown', protection: 'unknown' };
    const view = await mount(<CredentialStorageStatus />);
    expect(view.container.textContent).toContain('database key is encrypted, but the local database could not be read');
    expect(view.find('[data-credential-store="credentials"]')?.textContent).toContain('Could not verify protection');
    expect(view.container.textContent).not.toContain('Some saved data is not protected');
  });

  it('reports legacy plaintext copies even while the active credential and AI stores are encrypted', async () => {
    current.stores.push({ ...current.stores[0]!, id: 'credentials-legacy-0', label: 'Email passwords (legacy copy)', envelope: 'plaintext', protection: 'unprotected' });
    current.stores.push({ ...current.stores[2]!, id: 'ai-keys-legacy-0', label: 'AI keys (legacy copy)', envelope: 'plaintext', protectedByDatabase: false, protection: 'unprotected' });
    const view = await mount(<><CredentialStorageStatus /><VaultPasswordField accountId="account" kind="smtp" value="" onChange={vi.fn()} /><SavedAIKeyStorageNotice /></>);
    expect(view.container.textContent).toContain('Saved; some credential data is unprotected');
    expect(view.container.textContent).toContain('Some saved AI key data is not protected at rest.');
    expect(view.find('[data-credential-store="credentials-legacy-0"]')?.textContent).toContain('Unprotected at rest');
    expect(reveal).not.toHaveBeenCalled();
  });

  it('does not show a false AI plaintext warning for an unencrypted inner envelope protected by the database', async () => {
    const view = await mount(<SavedAIKeyStorageNotice />); expect(view.container.textContent).toBe('');
    current.stores[2] = { ...current.stores[2]!, envelope: 'unknown', protectedByDatabase: false, protection: 'unknown' };
    view.unmount(); const unknown = await mount(<SavedAIKeyStorageNotice />);
    expect(unknown.container.textContent).toContain('at-rest protection could not be verified'); expect(unknown.container.textContent).not.toContain('without encryption');
  });

  it('ignores a stale retry response instead of replacing a newer protection result', async () => {
    let resolve!: (result: Result) => void;
    status.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<Probe />); fire(view.all('button')[0]!, 'click'); await settle();
    expect(view.find('output')?.textContent).toBe('encrypted');
    await act(async () => resolve({ success: true, data: { ...base, databaseKey: 'plaintext', databaseKeyProtection: 'unprotected' } }));
    expect(view.find('output')?.textContent).toBe('encrypted');
    view.unmount(); expect(view.container.isConnected).toBe(false);
  });
});
