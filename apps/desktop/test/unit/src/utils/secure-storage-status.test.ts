import { describe, expect, it } from 'vitest';

import type { SecureStorageStatus } from '../../../../src/types/secure-storage';
import { credentialStoreProtection, savedSecretsProtected, secureStorageNotice } from '../../../../src/utils/secure-storage-status';

const encrypted: SecureStorageStatus = { platform: 'darwin', keyStore: 'available', databaseKey: 'encrypted', databaseKeyProtection: 'encrypted', databaseReadable: true, stores: [
  { id: 'credentials', label: 'Email credentials', envelope: 'encrypted', protectedByDatabase: false, protection: 'encrypted' },
  { id: 'oauth-tokens', label: 'OAuth tokens', envelope: 'plaintext', protectedByDatabase: true, protection: 'encrypted' },
  { id: 'ai-keys', label: 'AI API keys', envelope: 'plaintext', protectedByDatabase: true, protection: 'encrypted' },
] };

describe('saved credential protection wording', () => {
  it('keeps encrypted data protected when the Mac Keychain becomes unavailable', () => {
    const status = { ...encrypted, keyStore: 'unavailable' as const };
    expect(savedSecretsProtected(status)).toBe(true);
    const notice = secureStorageNotice(status)!;
    expect(notice.title).toBe('macOS Keychain is currently unavailable.');
    expect(notice.detail).toContain('database key remains encrypted');
    expect(notice.advice).toContain('Allow Keychain access'); expect(notice.advice).toContain('approve the macOS permission prompt');
    expect(notice.advice).toContain('sign out and back in or restart your Mac');
    expect(notice.advice).not.toContain('Open Keychain Access');
    expect(notice.advice).not.toMatch(/GNOME|KWallet|install.*keyring/i);
  });

  it('names only proven unprotected stores and includes a plaintext database key independently of availability', () => {
    const status: SecureStorageStatus = { ...encrypted, databaseKey: 'plaintext', databaseKeyProtection: 'unprotected', stores: [...encrypted.stores, { id: 'credentials-legacy-0', label: 'Email credentials (legacy copy)', envelope: 'plaintext', protectedByDatabase: false, protection: 'unprotected' }] };
    const notice = secureStorageNotice(status)!;
    expect(savedSecretsProtected(status)).toBe(false); expect(notice.title).toBe('Some saved data is not protected at rest.');
    expect(notice.detail).toContain('database key is not protected'); expect(notice.detail).toContain('Email credentials (legacy copy)');
    expect(notice.detail).not.toContain('OAuth tokens'); expect(notice.detail).not.toContain('AI API keys');
  });

  it('does not treat plaintext inner rows in an OS-protected database as exposed', () => {
    expect(savedSecretsProtected(encrypted)).toBe(true); expect(secureStorageNotice(encrypted)).toBeNull();
    expect(credentialStoreProtection(encrypted, 'ai-keys')).toBe('encrypted');
  });

  it('reports unknown status without silently treating a failed check as secure', () => {
    expect(savedSecretsProtected(null)).toBeNull(); expect(secureStorageNotice(null, 'Failed')?.title).toContain('could not be checked');
    const status: SecureStorageStatus = { ...encrypted, databaseKey: 'unknown', databaseKeyProtection: 'unknown', stores: [{ ...encrypted.stores[0]!, protection: 'unknown', envelope: 'unknown' }] };
    expect(savedSecretsProtected(status)).toBeNull(); expect(secureStorageNotice(status)?.title).toContain('could not be verified');
    expect(savedSecretsProtected({ ...encrypted, databaseKey: 'missing', databaseKeyProtection: 'missing', stores: [] })).toBeNull();
  });

  it('keeps Linux basic-text warnings actionable without applying that advice to Windows', () => {
    const linux: SecureStorageStatus = { ...encrypted, platform: 'linux', keyStore: 'basic-text', databaseKey: 'plaintext', databaseKeyProtection: 'unprotected' };
    expect(secureStorageNotice(linux)?.advice).toContain('GNOME Keyring or KWallet');
    const windows: SecureStorageStatus = { ...encrypted, platform: 'win32', keyStore: 'unavailable' };
    expect(secureStorageNotice(windows)?.title).toContain('Windows credential protection');
    expect(secureStorageNotice(windows)?.advice).toContain('Windows account'); expect(secureStorageNotice(windows)?.advice).not.toMatch(/Keychain|GNOME|KWallet/);
  });

  it('does not mistake legacy Linux encrypted envelopes for OS-backed key protection', () => {
    const legacyLinux: SecureStorageStatus = { ...encrypted, platform: 'linux', databaseKeyProtection: 'unprotected' };
    expect(savedSecretsProtected(legacyLinux)).toBe(false);
    expect(secureStorageNotice(legacyLinux)?.detail).toContain('database key is not protected by the operating system');
    expect(secureStorageNotice(legacyLinux)?.detail).not.toContain('OAuth tokens');
  });

  it('does not claim unreadable credential data is protected merely because the saved key is encrypted', () => {
    const unreadable: SecureStorageStatus = { ...encrypted, databaseReadable: false, keyStore: 'unavailable', stores: [{ ...encrypted.stores[0]!, envelope: 'unknown', protection: 'unknown' }] };
    expect(savedSecretsProtected(unreadable)).toBeNull();
    expect(secureStorageNotice(unreadable)?.detail).toContain('saved database key remains encrypted');
    expect(secureStorageNotice(unreadable)?.detail).toContain('unreadable credential data could not be verified');
  });

  it('does not hide an unprotected or unknown legacy copy behind an encrypted active store', () => {
    const legacy = { ...encrypted.stores[0]!, id: 'credentials-legacy-0', protection: 'unprotected' as const, envelope: 'plaintext' as const };
    expect(credentialStoreProtection({ ...encrypted, stores: [...encrypted.stores, legacy] }, 'credentials')).toBe('unprotected');
    expect(credentialStoreProtection({ ...encrypted, stores: [...encrypted.stores, { ...legacy, protection: 'unknown' }] }, 'credentials')).toBe('unknown');
    expect(credentialStoreProtection(encrypted, 'missing-store')).toBeUndefined();
  });
});
