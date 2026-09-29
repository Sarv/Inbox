// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EncryptionTab } from '../../../../../src/components/settings/EncryptionTab';
import type { AppSettings } from '../../../../../src/components/settings/types';
import { render, settle, toggle, typeInto, type Mounted } from '../../../../helpers/render';

/**
 * Settings → Encryption. What this protects: the only place a user makes,
 * imports, unlocks, backs up or deletes an OpenPGP key, and where they decide
 * whether keys are fetched from a third party. A button that silently does
 * nothing here means mail that cannot be read, or a key deleted without a
 * backup, or lookups leaking who the user writes to.
 */
const storeState = { accounts: [{ email: 'me@work.example', identities: ['sales@work.example'] }] };
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: (select: (state: typeof storeState) => unknown) => select(storeState),
}));

const FP = 'A'.repeat(32) + '12345678';
const ownKey = (over: Record<string, unknown> = {}) => ({
  fingerprint: FP,
  keyId: '12345678',
  userIds: ['Me <me@work.example>'],
  emails: ['me@work.example'],
  email: 'me@work.example',
  algorithm: 'curve25519',
  createdAt: '2026-01-02T00:00:00.000Z',
  expiresAt: null,
  isExpired: false,
  isRevoked: false,
  isPrivate: true,
  protection: 'keychain',
  signByDefault: false,
  unlocked: true,
  addedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});
const contactKey = {
  fingerprint: 'B'.repeat(40),
  keyId: 'BBBBBBBB',
  userIds: ['Gee <gee@example.org>'],
  emails: ['gee@example.org'],
  email: 'gee@example.org',
  algorithm: 'curve25519',
  createdAt: '2026-01-02T00:00:00.000Z',
  expiresAt: null,
  isExpired: false,
  isRevoked: false,
  isPrivate: false,
  source: 'wkd',
  preferEncrypt: 'mutual',
  firstSeen: '2026-01-02T00:00:00.000Z',
  lastSeen: '2026-02-03T00:00:00.000Z',
};

const ok = <T,>(data: T) => ({ success: true as const, data });
const fail = (error: string) => ({ success: false as const, error });

const api = {
  status: vi.fn(),
  listOwnKeys: vi.fn(),
  listContactKeys: vi.fn(),
  generateKey: vi.fn(),
  importOwnKey: vi.fn(),
  unlock: vi.fn(),
  exportOwnKey: vi.fn(),
  exportPublicKey: vi.fn(),
  deleteOwnKey: vi.fn(),
  setSignByDefault: vi.fn(),
  importContactKeys: vi.fn(),
  deleteContactKey: vi.fn(),
};

const settings = { pgpWkdLookup: true, pgpKeyserverLookup: false, pgpAutoEncrypt: true } as AppSettings;
const updateSetting = vi.fn();

let mounted: Mounted | null = null;
const mount = async () => {
  mounted = render(<EncryptionTab settings={settings} updateSetting={updateSetting} />);
  await settle();
  await settle();
  return mounted;
};
const buttonNamed = (view: Mounted, text: string) =>
  [...view.container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) ?? null;
const click = async (element: Element | null) => {
  if (!element) throw new Error('missing element');
  await act(async () => (element as HTMLElement).click());
  await settle();
  await settle();
};
const submit = async (form: Element | null | undefined) => {
  if (!form) throw new Error('missing form');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  await settle();
};
const formOf = (element: Element | null) => element?.closest('form');

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  updateSetting.mockReset();
  api.status.mockResolvedValue(ok({ keychainAvailable: true }));
  api.listOwnKeys.mockResolvedValue(ok([ownKey()]));
  api.listContactKeys.mockResolvedValue(ok([contactKey]));
  (window as unknown as { electronAPI: unknown }).electronAPI = { pgp: api };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('EncryptionTab', () => {
  // Breaks: the user cannot see which keys they have, or where a contact's key came from.
  it('lists own keys and contacts’ keys with their details', async () => {
    const view = await mount();
    const own = view.find(`[data-own-key="${FP}"]`);
    expect(own?.textContent).toContain('me@work.example');
    expect(own?.textContent).toContain('system keychain');
    expect(own?.textContent).not.toContain('Locked');
    expect(buttonNamed(view, 'Unlock')).toBeNull();
    expect(view.find('[data-contact-key]')?.textContent).toContain('From their mail domain (WKD)');
    expect(view.container.textContent).not.toContain('no keychain');
  });

  // Breaks: an expiring key hides its expiry, or an unreadable keychain status crashes the tab.
  it('shows an expiry date, and tolerates a failed status and contact list', async () => {
    api.status.mockResolvedValue(fail('no status'));
    api.listOwnKeys.mockResolvedValue(ok([ownKey({ expiresAt: '2027-06-01T00:00:00.000Z' })]));
    api.listContactKeys.mockResolvedValue(fail('Contacts unreadable'));
    const view = await mount();
    expect(view.find(`[data-own-key="${FP}"]`)?.textContent).toContain('expires');
    expect(view.find('[role="alert"]')?.textContent).toBe('Contacts unreadable');
    expect(view.container.textContent).not.toContain('no keychain');
  });

  // Breaks: a first-time user sees an empty box with no idea what to do.
  it('explains the empty state and warns when there is no keychain', async () => {
    api.status.mockResolvedValue(ok({ keychainAvailable: false }));
    api.listOwnKeys.mockResolvedValue(ok([]));
    api.listContactKeys.mockResolvedValue(ok([]));
    const view = await mount();
    expect(view.container.textContent).toContain('You have no OpenPGP key yet');
    expect(view.container.textContent).toContain('no keychain');
    expect(view.container.textContent).toContain('No keys yet');
  });

  // Breaks: a failing key list reads as "no keys" with no hint anything went wrong.
  it('shows a list failure, and a rejected bridge', async () => {
    api.listOwnKeys.mockResolvedValue(fail('Keyring unreadable'));
    const view = await mount();
    expect(view.find('[role="alert"]')?.textContent).toBe('Keyring unreadable');
    view.unmount();

    api.status.mockRejectedValue(new Error('IPC gone'));
    mounted = await mount();
    expect(mounted.find('[role="alert"]')?.textContent).toBe('IPC gone');
    expect(mounted.container.textContent).toContain('You have no OpenPGP key yet');
  });

  // Breaks: a key made for the wrong address, or one that asks for a passphrase it will ignore.
  it('creates a key for the chosen address, with no passphrase when the keychain holds it', async () => {
    api.generateKey.mockResolvedValue(ok(ownKey({ email: 'sales@work.example' })));
    const view = await mount();
    expect(view.byLabel('Passphrase for the new key')).toBeNull();
    const select = view.byLabel('Address for the key') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['me@work.example', 'sales@work.example']);
    await act(async () => {
      select.value = 'sales@work.example';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    typeInto(view.byLabel('Your name (optional)'), 'Me');
    await submit(formOf(select));
    expect(api.generateKey).toHaveBeenCalledWith({ name: 'Me', email: 'sales@work.example', passphrase: undefined });
    expect(view.find('[role="status"]')?.textContent).toBe('Created a key for sales@work.example');
    expect(api.listOwnKeys).toHaveBeenCalledTimes(2);
  });

  // Breaks: on Linux with no keyring a key is made with no protection at all.
  it('requires a passphrase to create a key when there is no keychain', async () => {
    api.status.mockResolvedValue(ok({ keychainAvailable: false }));
    api.generateKey.mockResolvedValue(fail('Too weak'));
    const view = await mount();
    const create = buttonNamed(view, 'Create key') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await submit(formOf(create));
    expect(api.generateKey).not.toHaveBeenCalled();
    typeInto(view.byLabel('Passphrase for the new key'), 'secret');
    await submit(formOf(create));
    expect(api.generateKey).toHaveBeenCalledWith({ name: '', email: 'me@work.example', passphrase: 'secret' });
    expect(view.find('[role="alert"]')?.textContent).toBe('Too weak');
    // A failed create keeps what was typed.
    expect((view.byLabel('Passphrase for the new key') as HTMLInputElement).value).toBe('secret');
  });

  // Breaks: a user with no account is offered an empty address list.
  it('asks for an account before a key can be made', async () => {
    const accounts = storeState.accounts;
    storeState.accounts = [];
    const view = await mount();
    expect(view.container.textContent).toContain('Add an account first');
    storeState.accounts = accounts;
  });

  // Breaks: importing an existing key loses its passphrase, or the pasted key stays in the box.
  it('imports a pasted own key with its passphrase and clears the form', async () => {
    api.importOwnKey.mockResolvedValue(ok([ownKey(), ownKey({ fingerprint: 'C'.repeat(40) })]));
    const view = await mount();
    const textarea = view.byLabel('Paste your private key') as HTMLTextAreaElement;
    typeInto(textarea, '-----BEGIN PGP PRIVATE KEY BLOCK-----');
    typeInto(view.byLabel('Its passphrase, if it has one'), 'pw');
    await submit(formOf(textarea));
    expect(api.importOwnKey).toHaveBeenCalledWith('-----BEGIN PGP PRIVATE KEY BLOCK-----', 'pw');
    expect(view.find('[role="status"]')?.textContent).toBe('Imported 2 keys');
    expect(textarea.value).toBe('');
  });

  // Breaks: a failed import wipes what the user pasted, or a non-Error rejection shows nothing.
  it('keeps the pasted key when the import fails', async () => {
    api.importOwnKey.mockResolvedValueOnce(ok([ownKey()])).mockResolvedValueOnce(fail('Not a key')).mockRejectedValueOnce('boom');
    const view = await mount();
    const textarea = view.byLabel('Paste your private key') as HTMLTextAreaElement;
    typeInto(textarea, 'KEY');
    await submit(formOf(textarea));
    expect(api.importOwnKey).toHaveBeenLastCalledWith('KEY', undefined);
    expect(view.find('[role="status"]')?.textContent).toBe('Imported your key');
    typeInto(textarea, 'JUNK');
    await submit(formOf(textarea));
    expect(view.find('[role="alert"]')?.textContent).toBe('Not a key');
    expect(textarea.value).toBe('JUNK');
    await submit(formOf(textarea));
    expect(view.find('[role="alert"]')?.textContent).toBe('boom');
  });

  // Breaks: a key file cannot be picked, or an unreadable file fails silently.
  it('reads a chosen key file into the box, and shows a read error', async () => {
    const view = await mount();
    const input = view.byLabel('Choose a file with your private key') as HTMLInputElement;
    const pick = async (file: { text: () => Promise<string> }) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      await settle();
    };
    await pick({ text: async () => 'ARMORED' });
    expect((view.byLabel('Paste your private key') as HTMLTextAreaElement).value).toBe('ARMORED');
    await pick({ text: async () => Promise.reject(new Error('cannot read')) });
    expect(view.container.textContent).toContain('cannot read');
    // Cancelling the picker clears the error and leaves the box alone.
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(view.container.textContent).not.toContain('cannot read');
  });

  // Breaks: a pasted public key is not imported, or an empty box sends an empty import.
  it('imports a contact’s key, and ignores an empty box', async () => {
    api.importContactKeys.mockResolvedValueOnce(ok([contactKey])).mockResolvedValueOnce(ok([contactKey, contactKey]));
    const view = await mount();
    const textarea = view.byLabel('Paste a public key') as HTMLTextAreaElement;
    await submit(formOf(textarea));
    expect(api.importContactKeys).not.toHaveBeenCalled();
    typeInto(textarea, 'PUBLIC');
    await submit(formOf(textarea));
    expect(api.importContactKeys).toHaveBeenCalledWith('PUBLIC');
    expect(view.find('[role="status"]')?.textContent).toBe('Imported a key for gee@example.org');
    typeInto(textarea, 'TWO KEYS');
    await submit(formOf(textarea));
    expect(view.find('[role="status"]')?.textContent).toBe('Imported 2 keys');
  });

  // Breaks: a locked key cannot be unlocked from Settings, or the form never closes.
  it('unlocks a locked key with its passphrase', async () => {
    api.listOwnKeys.mockResolvedValue(ok([ownKey({ protection: 'passphrase', unlocked: false })]));
    api.unlock.mockResolvedValueOnce(fail('Wrong passphrase')).mockResolvedValueOnce(ok(undefined));
    const view = await mount();
    expect(view.find(`[data-own-key="${FP}"]`)?.textContent).toContain('Locked');
    await click(buttonNamed(view, 'Unlock'));
    const field = view.byLabel('Passphrase of this key');
    typeInto(field, 'wrong');
    await submit(formOf(field));
    expect(view.find('[role="alert"]')?.textContent).toBe('Wrong passphrase');
    expect(view.byLabel('Passphrase of this key')).not.toBeNull();
    typeInto(view.byLabel('Passphrase of this key'), 'right');
    await submit(formOf(view.byLabel('Passphrase of this key')));
    expect(api.unlock).toHaveBeenLastCalledWith(FP, 'right');
    expect(view.byLabel('Passphrase of this key')).toBeNull();
  });

  // Breaks: a backup is written unprotected, or the form cannot be dismissed.
  it('backs a key up under a passphrase, and cancels', async () => {
    api.exportOwnKey.mockResolvedValue(ok({ saved: true, filePath: '/keys/me.asc' }));
    const view = await mount();
    await click(buttonNamed(view, 'Back up secret key'));
    await click(buttonNamed(view, 'Cancel'));
    expect(view.byLabel('Passphrase for the backup file')).toBeNull();

    await click(buttonNamed(view, 'Back up secret key'));
    const field = view.byLabel('Passphrase for the backup file');
    await submit(formOf(field));
    expect(api.exportOwnKey).not.toHaveBeenCalled();
    typeInto(field, 'backup-pw');
    await submit(formOf(field));
    expect(api.exportOwnKey).toHaveBeenCalledWith(FP, 'backup-pw');
    expect(view.find('[role="status"]')?.textContent).toBe('Backup saved to /keys/me.asc');
  });

  // Breaks: exporting the public key does nothing, or a cancelled save claims success.
  it('exports the public key, and says nothing when the save is cancelled', async () => {
    api.exportPublicKey.mockResolvedValueOnce(ok({ saved: true, filePath: '/keys/pub.asc' })).mockResolvedValueOnce(ok({ saved: false }));
    const view = await mount();
    await click(buttonNamed(view, 'Export public key'));
    expect(view.find('[role="status"]')?.textContent).toBe('Public key saved to /keys/pub.asc');
    await click(buttonNamed(view, 'Export public key'));
    expect(view.find('[role="status"]')).toBeNull();
  });

  // Breaks: the per-key signing default cannot be changed.
  it('toggles signing by default for a key', async () => {
    api.setSignByDefault.mockResolvedValue(ok(true));
    const view = await mount();
    const checkbox = [...view.container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Sign messages from'))
      ?.querySelector('input');
    toggle(checkbox ?? null);
    await settle();
    expect(api.setSignByDefault).toHaveBeenCalledWith(FP, true);
  });

  // Breaks: a key is deleted with no confirmation — or deleted even after "Cancel".
  it('deletes an own key only after confirming', async () => {
    api.deleteOwnKey.mockResolvedValue(ok(true));
    const view = await mount();
    await click(buttonNamed(view, 'Delete'));
    expect(view.container.textContent).toContain('Back it up first');
    await click(buttonNamed(view, 'Cancel'));
    expect(api.deleteOwnKey).not.toHaveBeenCalled();

    await click(buttonNamed(view, 'Delete'));
    await click(buttonNamed(view, 'Delete key'));
    expect(api.deleteOwnKey).toHaveBeenCalledWith(FP);
    expect(view.find('[role="status"]')?.textContent).toBe('Key deleted');
  });

  // Breaks: a contact's key cannot be removed, or a rejected removal leaves the tab stuck busy.
  it('removes a contact’s key after confirming, and recovers from a rejection', async () => {
    api.deleteContactKey.mockRejectedValueOnce(new Error('bridge down')).mockResolvedValueOnce(ok(true));
    const view = await mount();
    const remove = () => view.find('[data-contact-key] button');
    await click(remove());
    await click([...(view.find('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Remove') ?? null);
    expect(api.deleteContactKey).toHaveBeenCalledWith('gee@example.org', 'B'.repeat(40));
    expect(view.find('[role="alert"]')?.textContent).toBe('bridge down');
    expect((remove() as HTMLButtonElement).disabled).toBe(false);
  });

  // Breaks: the privacy switches do not save — keyserver lookups stay on, or auto-encrypt cannot be turned off.
  it('saves the key-discovery switches through settings', async () => {
    const view = await mount();
    const switchFor = (title: string) =>
      [...view.container.querySelectorAll('label')].find((label) => label.textContent?.includes(title))?.querySelector('input') ?? null;
    expect((switchFor('Search keys.openpgp.org') as HTMLInputElement).checked).toBe(false);
    toggle(switchFor('Search keys.openpgp.org'));
    toggle(switchFor('Encrypt automatically'));
    toggle(switchFor('mail domain for their key'));
    expect(updateSetting.mock.calls).toEqual([
      ['pgpKeyserverLookup', true],
      ['pgpAutoEncrypt', false],
      ['pgpWkdLookup', false],
    ]);
  });
});
