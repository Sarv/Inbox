// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Security } from '../../../../src/components/security/Security';
import { SecurityStatusBanner } from '../../../../src/components/SecurityStatusBanner';
import { VaultPasswordField } from '../../../../src/components/VaultPasswordField';
import type { SecureStorageStatus } from '../../../../src/types/secure-storage';
import { act, render, settle, type Mounted } from '../../../helpers/render';

/** Current key-store access cannot prove how previously saved data is protected. */
type StatusResult = { success: boolean; data?: SecureStorageStatus; error?: string } | Error;
const protectedStorage: SecureStorageStatus = {
  platform: 'darwin', keyStore: 'available', databaseKey: 'encrypted', databaseKeyProtection: 'encrypted', databaseReadable: true,
  stores: [
    { id: 'credentials', label: 'Email credentials', envelope: 'encrypted', protectedByDatabase: false, protection: 'encrypted' },
    { id: 'oauth-tokens', label: 'OAuth tokens', envelope: 'plaintext', protectedByDatabase: true, protection: 'encrypted' },
    { id: 'ai-keys', label: 'AI API keys', envelope: 'plaintext', protectedByDatabase: true, protection: 'encrypted' },
    { id: 'pgp-keys', label: 'OpenPGP keys', envelope: 'encrypted', protectedByDatabase: false, protection: 'encrypted' },
  ],
};
const linuxUnprotected = (): SecureStorageStatus => ({
  ...protectedStorage, platform: 'linux', keyStore: 'basic-text', databaseKeyProtection: 'unprotected',
  stores: protectedStorage.stores.map(store => store.id === 'pgp-keys' ? store : { ...store, envelope: 'plaintext', protectedByDatabase: false, protection: 'unprotected' }),
});
let mounted: Mounted | null = null;
const setApi = (result: StatusResult) => {
  // Deliberately contradictory: saved metadata, not this legacy boolean, is authoritative.
  const available = vi.fn(async () => ({ success: true, data: false }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    secureCreds: {
      available,
      status: vi.fn(async () => { if (result instanceof Error) throw result; return result; }),
      hasPassword: vi.fn(async () => ({ success: true, data: true })),
    },
    security: { getHeaderBackfillState: async () => ({ success: false }), onHeaderBackfillProgress: () => () => {} },
    spam: {
      getReputationState: async () => ({ success: false }),
      onReputationProgress: () => () => {},
      kickReputation: async () => ({ success: true }),
    },
  };
  return available;
};
const text = () => mounted!.container.textContent ?? '';

afterEach(() => {
  mounted?.unmount(); mounted = null; document.body.innerHTML = '';
});

describe('SecurityStatusBanner', () => {
  it('names confirmed unprotected data without falsely including passphrase-protected PGP keys, and can be dismissed', async () => {
    setApi({ success: true, data: linuxUnprotected() });
    mounted = render(<SecurityStatusBanner />); await settle();
    expect(text()).toContain('Some saved data is not protected at rest.');
    expect(text()).toContain('database key is not protected by the operating system');
    expect(text()).toContain('Email credentials, OAuth tokens, AI API keys');
    expect(text()).not.toContain('OpenPGP keys');
    expect(text()).toContain('GNOME Keyring or KWallet');
    await act(async () => { (mounted!.byLabel('Dismiss') as HTMLButtonElement).click(); });
    expect(text()).toBe('');
  });

  it('shows no warning for verified protected data even when the legacy availability boolean is false', async () => {
    const available = setApi({ success: true, data: protectedStorage });
    mounted = render(<SecurityStatusBanner />); await settle();
    expect(text()).toBe(''); expect(available).not.toHaveBeenCalled();
  });

  it.each<[string, StatusResult]>([
    ['a failed metadata check', { success: false, error: 'Synthetic metadata failure' }],
    ['a check that throws', new Error('Synthetic IPC failure')],
  ])('keeps protection unknown and visible for %s', async (_name, result) => {
    setApi(result); mounted = render(<SecurityStatusBanner />); await settle();
    expect(text()).toContain('Credential protection could not be checked.');
    expect(text()).toContain('Saved storage protection is unknown.');
    expect(mounted.byLabel('Retry credential protection check')).not.toBeNull();
    expect(text()).not.toContain('Some saved data is not protected');
  });

  it('keeps unverifiable saved metadata visible without calling it plaintext or secure', async () => {
    setApi({ success: true, data: { ...protectedStorage, databaseKeyProtection: 'unknown', stores: [] } });
    mounted = render(<SecurityStatusBanner />); await settle();
    expect(text()).toContain('Some storage protection could not be verified.');
    expect(text()).toContain('Unknown status does not confirm either encryption or plaintext.');
  });
});

describe('Security overview — saved mail database key', () => {
  const panel = () => mounted!.byLabel('Saved credential protection')?.textContent ?? '';

  it('reports a legacy Linux obfuscated key unprotected even when its envelope is marked encrypted', async () => {
    setApi({ success: true, data: linuxUnprotected() });
    mounted = render(<Security initialTab="overview" />); await settle();
    expect(panel()).toContain('Saved database keyUnprotected saved key');
    expect(panel()).toContain('Unprotected at rest');
    expect(panel()).not.toContain('Encrypted by the OS secure store');
    expect(text()).not.toContain('the key lives in the operating system keychain');
  });

  it('reports the saved key protected separately from currently unavailable Mac Keychain access', async () => {
    setApi({ success: true, data: { ...protectedStorage, keyStore: 'unavailable' } });
    mounted = render(<Security initialTab="overview" />); await settle();
    expect(panel()).toContain('macOS Keychain'); expect(panel()).toContain('Currently unavailable');
    expect(panel()).toContain('Saved database keyEncrypted by the OS secure store');
    expect(panel()).toContain('Protected by encrypted database');
    expect(panel()).not.toContain('Unprotected saved key'); expect(panel()).not.toContain('KWallet');
  });

  it('does not hide an unknown database key after a failed metadata check', async () => {
    setApi({ success: false, error: 'Synthetic check failed' });
    mounted = render(<Security initialTab="overview" />); await settle();
    expect(panel()).toContain('Saved credential protection is unknown.');
    expect(panel()).not.toContain('Encrypted by the OS secure store');
  });
});

describe('VaultPasswordField — a saved password', () => {
  const field = () => <VaultPasswordField accountId="acct-1" kind="imap" value="" onChange={() => {}} />;

  it('warns about confirmed unprotected credential data', async () => {
    setApi({ success: true, data: linuxUnprotected() }); mounted = render(field()); await settle();
    expect(text()).toContain('Saved; some credential data is unprotected');
    expect(text()).not.toContain('Saved securely'); expect(text()).not.toContain('Saved with encryption');
  });

  it('describes confirmed encryption separately from current Mac Keychain access', async () => {
    setApi({ success: true, data: { ...protectedStorage, keyStore: 'unavailable' } }); mounted = render(field()); await settle();
    expect(text()).toContain('Saved with encryption — click the eye');
    expect(text()).not.toContain('unprotected');
  });

  it('keeps the saved label neutral when credential protection is unknown', async () => {
    setApi(new Error('Synthetic check unavailable')); mounted = render(field()); await settle();
    expect(text()).toContain('Saved — click the eye');
    expect(text()).not.toContain('Saved with encryption'); expect(text()).not.toContain('unprotected');
  });
});
