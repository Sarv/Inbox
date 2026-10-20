import { beforeEach, describe, expect, it, vi } from 'vitest';

// The single answer to "is this secret really encrypted at rest?". What breaks
// if this file fails: on Linux without a keyring (Chromium's basic_text
// backend, whose key is public) the app tells the user — and the PGP and
// antivirus code — that secrets are protected when they aren't (CASA M-1);
// or a real keyring / macOS / Windows is wrongly reported as unprotected.

const h = vi.hoisted(() => ({
  available: true,
  backend: 'gnome_libsecret' as string,
  backendThrows: false,
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    getSelectedStorageBackend: () => {
      if (h.backendThrows) throw new Error('not linux');
      return h.backend;
    },
  },
}));

import { isOsBackedEncryption, secretStorageDescription } from '../../../../electron/services/os-encryption';
import { asPlatform } from '../../../helpers/as-platform';

beforeEach(() => {
  h.available = true;
  h.backend = 'gnome_libsecret';
  h.backendThrows = false;
});

describe('isOsBackedEncryption', () => {
  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('is true on Linux with the %s keyring', (backend) => {
    h.backend = backend;
    expect(asPlatform('linux', isOsBackedEncryption)).toBe(true);
  });

  it('is false on Linux basic_text, even though safeStorage says encryption is available', () => {
    h.backend = 'basic_text';
    expect(asPlatform('linux', isOsBackedEncryption)).toBe(false);
  });

  it('is false when the backend cannot be determined on Linux', () => {
    h.backendThrows = true;
    expect(asPlatform('linux', isOsBackedEncryption)).toBe(false);
  });

  it('is true on macOS and Windows without asking about a Linux backend', () => {
    h.backendThrows = true;
    expect(asPlatform('darwin', isOsBackedEncryption)).toBe(true);
    expect(asPlatform('win32', isOsBackedEncryption)).toBe(true);
  });

  it('is false everywhere when safeStorage has no encryption at all', () => {
    h.available = false;
    expect(asPlatform('darwin', isOsBackedEncryption)).toBe(false);
    expect(asPlatform('linux', isOsBackedEncryption)).toBe(false);
  });
});

describe('secretStorageDescription', () => {
  // The startup log line support reads to explain the warning banner.
  it('names the three states', () => {
    expect(asPlatform('linux', secretStorageDescription)).toBe('os-keychain');
    h.backend = 'basic_text';
    expect(asPlatform('linux', secretStorageDescription)).toMatch(/basic_text.*NOT protected/);
    h.available = false;
    expect(asPlatform('linux', secretStorageDescription)).toMatch(/unavailable/);
  });
});
