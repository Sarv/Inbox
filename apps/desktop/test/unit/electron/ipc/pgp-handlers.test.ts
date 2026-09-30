import { PgpKeyError } from '@sarvinbox/core/pgp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => h.channels.set(channel, fn) },
  dialog: { showSaveDialog: h.showSaveDialog },
  safeStorage: {},
}));
vi.mock('fs/promises', () => ({ writeFile: h.writeFile }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: h.resolve }));
vi.mock('../../../../electron/services/pgp-service', () => ({
  getPgpKeyring: () => h.keyring,
  readPgpPrefsFromSettings: () => h.prefs(),
}));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: () => h.window }));

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
  channels: new Map<string, (...a: unknown[]) => unknown>(),
  showSaveDialog: vi.fn(),
  writeFile: vi.fn(async () => undefined),
  keyring: null as unknown,
  prefs: (): { autoEncrypt: boolean } => ({ autoEncrypt: true }),
  window: null as unknown,
}));

import { createPgpHandlers, getPgpReader, registerPgpHandlers, safeDefaultName, storedSourceFor } from '../../../../electron/ipc/pgp-handlers';
import { PgpKeyringError, type PgpKeyring } from '../../../../electron/services/pgp-keyring';
import type { PgpReader } from '../../../../electron/services/pgp-reader';

/**
 * OpenPGP IPC. What this protects: a private-key backup or a decrypted
 * attachment written somewhere the user did not choose; plaintext kept in
 * memory after the key that opened it is deleted; a keyring refusal ("locked",
 * "needs a passphrase") reaching the renderer as an opaque crash; and compose
 * offering to sign from an address with no key.
 */
const keyringStub = (over: Partial<Record<keyof PgpKeyring, unknown>> = {}) =>
  ({
    keychainAvailable: vi.fn(() => true),
    listOwnKeys: vi.fn(async () => []),
    generateOwnKey: vi.fn(async (input: unknown) => ({ fingerprint: 'F'.repeat(40), input })),
    importOwnKey: vi.fn(async () => []),
    unlockOwnKey: vi.fn(async () => undefined),
    exportOwnKey: vi.fn(async () => 'SECRET-ARMOR'),
    exportOwnPublicKey: vi.fn(() => 'PUBLIC-ARMOR'),
    deleteOwnKey: vi.fn(() => true),
    setSignByDefault: vi.fn(() => true),
    listContactKeys: vi.fn(async () => []),
    importContactKeys: vi.fn(async () => []),
    deleteContactKey: vi.fn(() => true),
    resolveRecipients: vi.fn(async () => []),
    ownPublicKeyFor: vi.fn(async () => ({})),
    signsByDefault: vi.fn(async () => true),
    ...over,
  }) as unknown as PgpKeyring;

const setup = (options: { keyring?: PgpKeyring; savePath?: string | null; attachment?: unknown } = {}) => {
  const keyring = options.keyring ?? keyringStub();
  const reader = {
    open: vi.fn(async () => ({ ok: true })),
    openDraft: vi.fn(async () => ({ ok: true, attachments: [] })),
    attachment: vi.fn(() => options.attachment ?? null),
    forget: vi.fn(),
  } as unknown as PgpReader & {
    forget: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    openDraft: ReturnType<typeof vi.fn>;
  };
  const chooseSavePath = vi.fn(async () => (options.savePath === undefined ? '/chosen/file' : options.savePath));
  const writeFile = vi.fn(async () => undefined);
  const handlers = createPgpHandlers({ keyring: () => keyring, reader, autoEncrypt: () => true, chooseSavePath, writeFile });
  return { handlers, keyring, reader, chooseSavePath, writeFile };
};

describe('key management', () => {
  // Breaks: the settings tab cannot tell a Linux box without a keyring (passphrase needed) from one with.
  it('reports keychain availability and lists keys', async () => {
    const { handlers } = setup();
    expect(await handlers['pgp:status']()).toEqual({ success: true, data: { keychainAvailable: true } });
    expect(await handlers['pgp:listOwnKeys']()).toEqual({ success: true, data: [] });
    expect(await handlers['pgp:listContactKeys']()).toEqual({ success: true, data: [] });
  });

  // Breaks: a key generated for "" or with a whitespace-padded address that never matches From.
  it('generates a key for a trimmed address and refuses one with none', async () => {
    const { handlers, keyring } = setup();
    await handlers['pgp:generateKey']({ name: ' Rita ', email: ' rita@example.com ', passphrase: '' });
    expect(keyring.generateOwnKey).toHaveBeenCalledWith({ name: 'Rita', email: 'rita@example.com', passphrase: undefined });
    expect(await handlers['pgp:generateKey']({ email: '  ' })).toMatchObject({ success: false, error: 'An email address is required' });
    expect(await handlers['pgp:generateKey'](undefined as never)).toMatchObject({ success: false });
  });

  // Breaks: a keyring refusal arrives without its code, so the UI cannot ask for the passphrase.
  it('passes keyring and key errors through with their codes', async () => {
    const keyring = keyringStub({
      importOwnKey: vi.fn(async () => {
        throw new PgpKeyringError('This key needs its passphrase', 'passphrase-required');
      }),
      unlockOwnKey: vi.fn(async () => {
        throw new PgpKeyError('Wrong passphrase', 'bad-passphrase');
      }),
      listOwnKeys: vi.fn(async () => {
        throw new Error('db closed');
      }),
    });
    const { handlers } = setup({ keyring });
    expect(await handlers['pgp:importOwnKey']('ARMOR')).toEqual({
      success: false,
      error: 'This key needs its passphrase',
      code: 'passphrase-required',
    });
    expect(await handlers['pgp:unlock']('FP', 'nope')).toMatchObject({ success: false, code: 'bad-passphrase' });
    expect(await handlers['pgp:listOwnKeys']()).toEqual({ success: false, error: 'db closed' });
    expect(await handlers['pgp:unlock']('FP', '')).toMatchObject({ success: false, error: 'A passphrase is required' });
    expect(await handlers['pgp:importOwnKey']('')).toMatchObject({ success: false, error: 'A key is required' });
  });

  // Breaks: an empty passphrase sent from a blank field locks the import to "" instead of none.
  it('treats an empty import passphrase as none', async () => {
    const { handlers, keyring } = setup();
    await handlers['pgp:importOwnKey']('ARMOR', '');
    expect(keyring.importOwnKey).toHaveBeenCalledWith('ARMOR', undefined);
  });

  // Breaks: a private-key backup lands anywhere but the file the user chose, or is written when they cancel.
  it('writes a backup only to the chosen path', async () => {
    const fingerprint = 'A'.repeat(24) + 'B'.repeat(16);
    const saved = setup();
    expect(await saved.handlers['pgp:exportOwnKey'](fingerprint, 'backup pass')).toEqual({
      success: true,
      data: { saved: true, filePath: '/chosen/file' },
    });
    expect(saved.chooseSavePath).toHaveBeenCalledWith(`${'B'.repeat(16)}-secret.asc`, expect.any(Array));
    expect(saved.writeFile).toHaveBeenCalledWith('/chosen/file', 'SECRET-ARMOR');

    const cancelled = setup({ savePath: null });
    expect(await cancelled.handlers['pgp:exportPublicKey'](fingerprint)).toEqual({ success: true, data: { saved: false } });
    expect(cancelled.writeFile).not.toHaveBeenCalled();
  });

  // Breaks: exporting the public key writes the wrong armor.
  it('exports the public key', async () => {
    const { handlers, writeFile, chooseSavePath } = setup();
    await handlers['pgp:exportPublicKey']('C'.repeat(40));
    expect(chooseSavePath).toHaveBeenCalledWith(`${'C'.repeat(16)}-public.asc`, expect.any(Array));
    expect(writeFile).toHaveBeenCalledWith('/chosen/file', 'PUBLIC-ARMOR');
  });

  // Breaks: messages the deleted key opened stay readable from memory.
  it('forgets opened plaintext when a key is deleted', async () => {
    const { handlers, reader, keyring } = setup();
    expect(await handlers['pgp:deleteOwnKey']('FP')).toEqual({ success: true, data: true });
    expect(keyring.deleteOwnKey).toHaveBeenCalledWith('FP');
    expect(reader.forget).toHaveBeenCalled();
  });

  // Breaks: a truthy non-boolean from the renderer turns signing on.
  it('only a literal true turns sign-by-default on', async () => {
    const { handlers, keyring } = setup();
    await handlers['pgp:setSignByDefault']('FP', 'yes' as never);
    expect(keyring.setSignByDefault).toHaveBeenCalledWith('FP', false);
    await handlers['pgp:setSignByDefault']('FP', true);
    expect(keyring.setSignByDefault).toHaveBeenLastCalledWith('FP', true);
  });

  // Breaks: contact key import/delete reach the wrong key or accept nothing.
  it('imports and deletes contact keys', async () => {
    const { handlers, keyring } = setup();
    await handlers['pgp:importContactKeys']('ARMOR');
    expect(keyring.importContactKeys).toHaveBeenCalledWith('ARMOR');
    await handlers['pgp:deleteContactKey']('gee@example.org', 'FP');
    expect(keyring.deleteContactKey).toHaveBeenCalledWith('gee@example.org', 'FP');
    expect(await handlers['pgp:deleteContactKey']('', 'FP')).toMatchObject({ success: false });
  });
});

describe('compose', () => {
  // Breaks: compose looks up nothing, or chokes on a non-address from the renderer.
  it('resolves only string recipients, discovering as the settings allow', async () => {
    const { handlers, keyring } = setup();
    await handlers['pgp:resolveRecipients'](['a@x.org', 7, null]);
    expect(keyring.resolveRecipients).toHaveBeenCalledWith(['a@x.org'], { discover: true });
    await handlers['pgp:resolveRecipients']('a@x.org');
    expect(keyring.resolveRecipients).toHaveBeenLastCalledWith([], { discover: true });
  });

  // Breaks: compose offers to sign from an address with no key, or ignores sign-by-default.
  it('derives the compose defaults from the From address', async () => {
    expect(await setup().handlers['pgp:composeDefaults']('rita@example.com')).toEqual({
      success: true,
      data: { hasOwnKey: true, signByDefault: true, autoEncrypt: true },
    });
    const noKey = setup({ keyring: keyringStub({ ownPublicKeyFor: vi.fn(async () => null) }) });
    expect(await noKey.handlers['pgp:composeDefaults']('x@example.com')).toMatchObject({
      data: { hasOwnKey: false, signByDefault: false },
    });
    const noFrom = setup();
    expect(await noFrom.handlers['pgp:composeDefaults']('')).toMatchObject({ data: { hasOwnKey: false } });
    expect(noFrom.keyring.ownPublicKeyFor).not.toHaveBeenCalled();
  });
});

describe('reading', () => {
  // Breaks: the reader asks with no id and the keyring is queried for nothing.
  it('opens through the reader and refuses a missing id', async () => {
    const { handlers, reader } = setup();
    expect(await handlers['pgp:open']('e1', 'acct')).toEqual({ ok: true });
    expect(reader.open).toHaveBeenCalledWith('e1', 'acct');
    expect(await handlers['pgp:open']('')).toMatchObject({ ok: false, code: 'unavailable' });
  });

  // Breaks: an encrypted draft cannot be reopened into the composer, or is asked for with no id.
  it('opens a draft through the reader and refuses a missing id', async () => {
    const { handlers, reader } = setup();
    expect(await handlers['pgp:openDraft']('d1', 'acct')).toEqual({ ok: true, attachments: [] });
    expect(reader.openDraft).toHaveBeenCalledWith('d1', 'acct');
    expect(await handlers['pgp:openDraft'](undefined as unknown as string)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(reader.openDraft).toHaveBeenCalledTimes(1);
  });

  // Breaks: a decrypted attachment named "../../.ssh/x" proposes a path outside the save folder.
  it('saves an opened attachment under a safe default name', async () => {
    const { handlers, chooseSavePath, writeFile } = setup({
      attachment: { name: '..\\..\\evil/plan.pdf', content: Buffer.from('pdf') },
    });
    expect(await handlers['pgp:saveAttachment']('e1', 'acct', 0)).toMatchObject({ success: true, data: { saved: true } });
    expect(chooseSavePath).toHaveBeenCalledWith('plan.pdf', undefined);
    expect(writeFile).toHaveBeenCalledWith('/chosen/file', Buffer.from('pdf'));
  });

  // Breaks: saving from a message evicted from memory silently writes nothing.
  it('asks the user to reopen when the attachment is no longer held', async () => {
    expect(await setup().handlers['pgp:saveAttachment']('e1', undefined, 0)).toMatchObject({
      success: false,
      error: expect.stringContaining('Open the message again'),
    });
  });

  // Breaks: an empty or dot name becomes the default file name.
  it('falls back when the name has nothing usable', () => {
    expect(safeDefaultName('', 'attachment')).toBe('attachment');
    expect(safeDefaultName('..', 'attachment')).toBe('attachment');
    expect(safeDefaultName('/tmp/', 'attachment')).toBe('tmp');
    expect(safeDefaultName('report.txt', 'attachment')).toBe('report.txt');
  });
});

describe('storedSourceFor', () => {
  const target = (email: unknown, folder: unknown = { path: 'INBOX' }, raw = 'RAW') => {
    const syncEngine = { getRawSource: vi.fn(async () => raw) };
    h.resolve.mockResolvedValue({
      storage: { getEmail: vi.fn(async () => email), getFolder: vi.fn(async () => folder) },
      syncEngine,
    });
    return syncEngine;
  };

  // Breaks: an All-Inboxes message from another account is read from the wrong account's server.
  it("reads the source from the owning account's engine", async () => {
    const engine = target({ uid: 9, folderId: 'f', fromAddress: 'gee@example.org' });
    expect(await storedSourceFor('e1', 'acct')).toEqual({ raw: 'RAW', fromAddress: 'gee@example.org' });
    expect(h.resolve).toHaveBeenCalledWith('acct');
    expect(engine.getRawSource).toHaveBeenCalledWith('e1', 'INBOX', 9);
  });

  // Breaks: a missing message, folder, UID, engine or empty source throws instead of "unavailable".
  it('returns null whenever the source cannot be reached', async () => {
    target(null);
    expect(await storedSourceFor('e1')).toBeNull();
    target({ uid: 9, folderId: 'f' }, null);
    expect(await storedSourceFor('e1')).toBeNull();
    target({ uid: 9, folderId: 'f' }, { path: 'INBOX' }, '');
    expect(await storedSourceFor('e1')).toBeNull();
    h.resolve.mockResolvedValue({ storage: { getEmail: async () => ({ uid: 9 }) }, syncEngine: null });
    expect(await storedSourceFor('e1')).toBeNull();
    target({ uid: 9, folderId: 'f' });
    expect(await storedSourceFor('e1')).toEqual({ raw: 'RAW', fromAddress: null });
  });

  // Breaks: an encrypted draft saved offline (no UID yet) cannot be reopened — the
  // ciphertext on its own row is the only copy there is.
  it('opens an encrypted draft from its own row when the server has no copy', async () => {
    const draft = { uid: 0, folderId: 'f', fromAddress: 'me@x.org', pgpStatus: 'encrypted', rawBody: 'CIPHERTEXT' };
    const engine = target(draft);
    expect(await storedSourceFor('d1')).toEqual({ raw: 'CIPHERTEXT', fromAddress: 'me@x.org' });
    expect(engine.getRawSource).not.toHaveBeenCalled();

    // No engine for the account (offline start) — same.
    h.resolve.mockResolvedValue({ storage: { getEmail: async () => ({ ...draft, uid: 5 }) }, syncEngine: null });
    expect(await storedSourceFor('d1')).toEqual({ raw: 'CIPHERTEXT', fromAddress: 'me@x.org' });

    // Appended, but the server cannot hand the source back right now.
    target({ ...draft, uid: 5 }, { path: 'Drafts' }, '');
    expect(await storedSourceFor('d1')).toEqual({ raw: 'CIPHERTEXT', fromAddress: 'me@x.org' });
  });

  // Breaks: the placeholder of a synced row, or a plaintext draft's body, is fed to the decrypter as if it were ciphertext.
  it('never treats a placeholder or an unencrypted body as a local source', async () => {
    target({ uid: 0, folderId: 'f', pgpStatus: 'encrypted', rawBody: 'Encrypted message' });
    expect(await storedSourceFor('d1')).toBeNull();
    target({ uid: 0, folderId: 'f', pgpStatus: null, rawBody: '<p>plain</p>' });
    expect(await storedSourceFor('d1')).toBeNull();
    target({ uid: 0, folderId: 'f', pgpStatus: 'encrypted', rawBody: null });
    expect(await storedSourceFor('d1')).toBeNull();
  });
});

describe('registerPgpHandlers', () => {
  // Breaks: a channel the preload calls has no handler, so that button rejects with "No handler registered".
  it('registers every channel, wired to the real dialog, file write and settings', async () => {
    h.keyring = keyringStub({ ownPublicKeyFor: vi.fn(async () => null) });
    registerPgpHandlers();
    const invoke = (channel: string, ...args: unknown[]) => h.channels.get(channel)!(null, ...args);
    expect([...h.channels.keys()]).toEqual(expect.arrayContaining(['pgp:open', 'pgp:openDraft', 'pgp:saveAttachment', 'pgp:exportOwnKey']));
    expect(h.channels.size).toBe(17);

    // No window: the dialog is shown unparented. Cancelling writes nothing.
    h.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    expect(await invoke('pgp:exportPublicKey', 'F'.repeat(40))).toEqual({ success: true, data: { saved: false } });
    expect(h.showSaveDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: `${'F'.repeat(16)}-public.asc` }));
    expect(h.writeFile).not.toHaveBeenCalled();

    // A window: the dialog is its sheet; the file is written owner-only.
    h.window = { id: 1 };
    h.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/picked.asc' });
    expect(await invoke('pgp:exportPublicKey', 'F'.repeat(40))).toMatchObject({ data: { saved: true, filePath: '/picked.asc' } });
    expect(h.showSaveDialog).toHaveBeenLastCalledWith(h.window, expect.any(Object));
    expect(h.writeFile).toHaveBeenCalledWith('/picked.asc', 'PUBLIC-ARMOR', { mode: 0o600 });

    // Unreadable settings: never auto-encrypt on a guess.
    expect(await invoke('pgp:composeDefaults', 'a@x.org')).toMatchObject({ data: { autoEncrypt: true } });
    h.prefs = () => {
      throw new Error('corrupt settings');
    };
    expect(await invoke('pgp:composeDefaults', 'a@x.org')).toMatchObject({ data: { autoEncrypt: false } });
  });

  // Breaks: key deletion clears a different reader's cache than the one that holds the plaintext.
  it('shares one reader across the process', () => {
    expect(getPgpReader()).toBe(getPgpReader());
  });
});
