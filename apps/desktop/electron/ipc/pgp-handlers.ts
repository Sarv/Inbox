/**
 * OpenPGP IPC — keys, compose state, and decrypt-on-view.
 *
 * Nothing secret travels to the renderer except what the user is looking at:
 * private keys never cross (backups go straight from here to a file the user
 * picked), and a decrypted message's attachments cross as metadata only — the
 * bytes are written from this process into a save dialog's path.
 *
 * The handler logic is a plain record built from its dependencies, so it is
 * tested without Electron; `registerPgpHandlers` is only the wiring.
 */
import { writeFile } from 'fs/promises';
import path from 'path';

import { createLogger } from '@sarvinbox/core';
import { PGP_ENCRYPTED_PLACEHOLDER, PgpKeyError } from '@sarvinbox/core/pgp';
import { dialog, ipcMain } from 'electron';

import { resolveAccountTarget } from '../services/account-target';
import { PgpKeyringError, type PgpKeyring } from '../services/pgp-keyring';
import { PgpReader, type StoredSource } from '../services/pgp-reader';
import { getPgpKeyring, readPgpPrefsFromSettings } from '../services/pgp-service';
import { getMainWindow } from '../shared';

const logger = createLogger('pgp-handlers');

export type PgpIpcResult<T> = { success: true; data: T } | { success: false; error: string; code?: string };

export interface PgpComposeDefaults {
  /** The From address has a usable key of its own — encrypting and signing are possible. */
  hasOwnKey: boolean;
  signByDefault: boolean;
  /** Turn encryption on by itself once every recipient has a key. */
  autoEncrypt: boolean;
}

export interface PgpHandlerDeps {
  keyring: () => PgpKeyring;
  reader: PgpReader;
  autoEncrypt: () => boolean;
  /** Ask where to save; null when the user cancels. */
  chooseSavePath: (defaultName: string, filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
  writeFile: (filePath: string, content: string | Buffer) => Promise<void>;
}

const ok = <T>(data: T): PgpIpcResult<T> => ({ success: true, data });

const failure = (error: unknown): PgpIpcResult<never> => {
  if (error instanceof PgpKeyringError || error instanceof PgpKeyError) {
    return { success: false, error: error.message, code: error.code };
  }
  logger.warn(`OpenPGP request failed: ${(error as Error)?.message ?? String(error)}`);
  return { success: false, error: (error as Error)?.message ?? String(error) };
};

const guarded =
  <A extends unknown[], T>(run: (...args: A) => T | Promise<T>) =>
  async (...args: A): Promise<PgpIpcResult<T>> => {
    try {
      return ok(await run(...args));
    } catch (error) {
      return failure(error);
    }
  };

const requireText = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is required`);
  return value;
};

/**
 * A name for the save dialog's default. The dialog's own choice is the real
 * path; this only keeps a crafted attachment name ("../../x") from pointing it
 * somewhere else to begin with.
 */
export const safeDefaultName = (name: string, fallback: string): string => {
  // win32.basename strips both separators, whichever OS this runs on.
  const base = path.win32.basename(name).trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
};

const ASC_FILTER = [{ name: 'OpenPGP key', extensions: ['asc'] }];

/** Which file an own key is saved as — the fingerprint's tail, so two keys never collide. */
const keyFileName = (fingerprint: string, kind: 'public' | 'secret') => `${fingerprint.slice(-16)}-${kind}.asc`;

export function createPgpHandlers(deps: PgpHandlerDeps) {
  const saveTo = async (defaultName: string, content: string | Buffer, filters?: typeof ASC_FILTER) => {
    const filePath = await deps.chooseSavePath(defaultName, filters);
    if (!filePath) return { saved: false as const };
    await deps.writeFile(filePath, content);
    return { saved: true as const, filePath };
  };

  return {
    'pgp:status': guarded(() => ({ keychainAvailable: deps.keyring().keychainAvailable() })),
    'pgp:listOwnKeys': guarded(() => deps.keyring().listOwnKeys()),
    'pgp:generateKey': guarded((input: { name?: string; email?: string; passphrase?: string }) =>
      deps.keyring().generateOwnKey({
        name: typeof input?.name === 'string' ? input.name.trim() : '',
        email: requireText(input?.email, 'An email address').trim(),
        passphrase: input?.passphrase || undefined,
      }),
    ),
    'pgp:importOwnKey': guarded((armored: string, passphrase?: string) =>
      deps.keyring().importOwnKey(requireText(armored, 'A key'), passphrase || undefined),
    ),
    'pgp:unlock': guarded((fingerprint: string, passphrase: string) =>
      deps.keyring().unlockOwnKey(requireText(fingerprint, 'A key'), requireText(passphrase, 'A passphrase')),
    ),
    'pgp:exportOwnKey': guarded(async (fingerprint: string, passphrase: string) => {
      const armored = await deps.keyring().exportOwnKey(requireText(fingerprint, 'A key'), passphrase);
      return saveTo(keyFileName(fingerprint, 'secret'), armored, ASC_FILTER);
    }),
    'pgp:exportPublicKey': guarded((fingerprint: string) =>
      saveTo(keyFileName(fingerprint, 'public'), deps.keyring().exportOwnPublicKey(requireText(fingerprint, 'A key')), ASC_FILTER),
    ),
    'pgp:deleteOwnKey': guarded((fingerprint: string) => {
      const deleted = deps.keyring().deleteOwnKey(requireText(fingerprint, 'A key'));
      // What that key opened must not stay readable.
      deps.reader.forget();
      return deleted;
    }),
    'pgp:setSignByDefault': guarded((fingerprint: string, on: boolean) =>
      deps.keyring().setSignByDefault(requireText(fingerprint, 'A key'), on === true),
    ),
    'pgp:listContactKeys': guarded(() => deps.keyring().listContactKeys()),
    'pgp:importContactKeys': guarded((armored: string) => deps.keyring().importContactKeys(requireText(armored, 'A key'))),
    'pgp:deleteContactKey': guarded((email: string, fingerprint: string) =>
      deps.keyring().deleteContactKey(requireText(email, 'An address'), requireText(fingerprint, 'A key')),
    ),
    'pgp:resolveRecipients': guarded((emails: unknown) =>
      deps.keyring().resolveRecipients(
        Array.isArray(emails) ? emails.filter((email): email is string => typeof email === 'string') : [],
        { discover: true },
      ),
    ),
    'pgp:composeDefaults': guarded(async (fromEmail: string): Promise<PgpComposeDefaults> => {
      const ring = deps.keyring();
      const from = typeof fromEmail === 'string' ? fromEmail : '';
      const [ownKey, signByDefault] = from
        ? await Promise.all([ring.ownPublicKeyFor(from), ring.signsByDefault(from)])
        : [null, false];
      return { hasOwnKey: ownKey !== null, signByDefault: ownKey !== null && signByDefault, autoEncrypt: deps.autoEncrypt() };
    }),
    // Returns the reader's own result shape: a refusal ("locked", "no-key") is
    // a state the reader shows, not an IPC failure.
    'pgp:open': async (emailId: string, accountId?: string) => {
      if (typeof emailId !== 'string' || !emailId) return { ok: false, code: 'unavailable', error: 'No message' } as const;
      return deps.reader.open(emailId, accountId);
    },
    'pgp:openDraft': async (emailId: string, accountId?: string) => {
      if (typeof emailId !== 'string' || !emailId) return { ok: false, code: 'unavailable', error: 'No draft' } as const;
      return deps.reader.openDraft(emailId, accountId);
    },
    'pgp:saveAttachment': guarded(async (emailId: string, accountId: string | undefined, index: number) => {
      const attachment = deps.reader.attachment(emailId, accountId, index);
      if (!attachment) throw new Error('Open the message again to save this attachment');
      return saveTo(safeDefaultName(attachment.name, 'attachment'), attachment.content);
    }),
  };
}

/** The stored message's raw source and sender, from the account that owns it. */
export async function storedSourceFor(emailId: string, accountId?: string): Promise<StoredSource | null> {
  const { storage, syncEngine } = await resolveAccountTarget(accountId);
  const email = await storage.getEmail(emailId);
  if (!email) return null;
  const fromAddress = email.fromAddress ?? null;
  // A draft encrypted here and not yet on the server (offline, or the append
  // failed) keeps its ciphertext as its raw body — the placeholder means a
  // synced row, whose source is on the server.
  const localCiphertext =
    email.pgpStatus === 'encrypted' && email.rawBody && email.rawBody !== PGP_ENCRYPTED_PLACEHOLDER ? email.rawBody : null;
  if (!email.uid || !syncEngine) return localCiphertext ? { raw: localCiphertext, fromAddress } : null;
  const folder = await storage.getFolder(email.folderId);
  if (!folder) return null;
  const raw = await syncEngine.getRawSource(emailId, folder.path, email.uid);
  if (raw) return { raw, fromAddress };
  return localCiphertext ? { raw: localCiphertext, fromAddress } : null;
}

let reader: PgpReader | null = null;

/** The process's one reader, so its cache can be cleared from wherever keys change. */
export function getPgpReader(): PgpReader {
  reader ??= new PgpReader({ keyring: getPgpKeyring, source: storedSourceFor });
  return reader;
}

export function registerPgpHandlers(): void {
  const handlers = createPgpHandlers({
    keyring: getPgpKeyring,
    reader: getPgpReader(),
    autoEncrypt: () => {
      try {
        return readPgpPrefsFromSettings().autoEncrypt;
      } catch {
        return false;
      }
    },
    chooseSavePath: async (defaultName, filters) => {
      const options: Electron.SaveDialogOptions = { defaultPath: defaultName, filters };
      const window = getMainWindow();
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    // 0600 where POSIX modes exist; a no-op on Windows, where the folder's ACL governs.
    writeFile: (filePath, content) => writeFile(filePath, content, { mode: 0o600 }),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args));
  }
}
