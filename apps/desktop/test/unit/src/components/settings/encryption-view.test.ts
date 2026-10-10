import { describe, expect, it } from 'vitest';

import {
  keyAddressChoices,
  keySourceLabel,
  keyWarnings,
  localDate,
  protectionText,
} from '../../../../../src/components/settings/encryption-view';

/**
 * The Encryption tab's wording. What this protects: a revoked or expired key
 * shown as fine to use, a key's protection misreported (a passphrase key
 * claiming the keychain holds it), and a key offered for an address the user
 * does not own — or not offered for an alias they do.
 */
describe('encryption-view', () => {
  // Breaks: a revoked key looks usable, or a healthy key carries a scary badge.
  it('lists a key’s warnings most serious first, and none for a healthy key', () => {
    expect(keyWarnings({ isRevoked: true, isExpired: true, unlocked: false })).toEqual(['Revoked', 'Expired', 'Locked']);
    expect(keyWarnings({ isRevoked: false, isExpired: false, unlocked: true })).toEqual([]);
    // A contact key has no lock state at all — it is never "Locked".
    expect(keyWarnings({ isRevoked: false, isExpired: true })).toEqual(['Expired']);
  });

  // Breaks: a Linux user with no keyring is told no passphrase is needed.
  it('says truthfully where a key’s secret lives', () => {
    expect(protectionText('keychain')).toContain('system keychain');
    expect(protectionText('passphrase')).toContain('passphrase');
    expect(protectionText('passphrase')).not.toContain('keychain');
  });

  // Linux without a keyring (basic_text): a key sealed with the "keychain"
  // there earlier is only obfuscated. Breaks: it is still called protected,
  // or the user is not told how to protect it.
  it('calls a keychain-sealed key unprotected where there is no real keychain, and says how to fix it', () => {
    const text = protectionText('keychain', false);
    expect(text).toMatch(/^Not protected/);
    expect(text).not.toContain('Protected by');
    expect(text).toContain('back up the secret key, then import that backup with its passphrase');
    // A passphrase key is protected whatever the keychain is.
    expect(protectionText('passphrase', false)).toBe(protectionText('passphrase'));
  });

  // Breaks: a key fetched from a third-party server looks like one the user imported.
  it('names every key source', () => {
    expect(keySourceLabel('manual')).toBe('Imported by you');
    expect(keySourceLabel('autocrypt')).toContain('Autocrypt');
    expect(keySourceLabel('wkd')).toContain('WKD');
    expect(keySourceLabel('keyserver')).toContain('keys.openpgp.org');
  });

  // Breaks: a missing expiry renders as "Invalid Date" or the epoch.
  it('renders a UTC timestamp as a local date, and nothing for none', () => {
    expect(localDate(null)).toBe('');
    expect(localDate('2026-03-15T12:00:00.000Z')).toContain('2026');
  });

  // Breaks: an alias cannot get a key, or the same address is offered twice.
  it('offers every account address and alias once, in account order', () => {
    expect(
      keyAddressChoices([
        { email: 'me@work.example', identities: ['sales@work.example', 'ME@work.example'] },
        { email: 'me@home.example' },
      ]),
    ).toEqual(['me@work.example', 'sales@work.example', 'me@home.example']);
    expect(keyAddressChoices([])).toEqual([]);
  });
});
