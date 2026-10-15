import {
  accountIdFor,
  fetchBodyQueued,
  resolveTlsOptions,
  waitForAbortableOperation,
  type IMAPConfig,
} from '@sarvinbox/core';

import { getIsQuitting, getSystemSuspended } from '../shared';

import { requireAccountStorage, requireTargetAccountId, resolveNamedOrActiveAccountTarget } from './account-target';
import { readRegistryAccounts } from './accounts-registry';
import { attachImapBearer, getValidAccessToken } from './oauth-service';
import { getAccountSecrets } from './secure-credential-store';

type Mailbox = Awaited<ReturnType<typeof resolveNamedOrActiveAccountTarget>>;
type Engine = NonNullable<Mailbox['syncEngine']>;

const connecting = new WeakMap<Engine, Promise<void>>();
const failedUntil = new WeakMap<Engine, number>();
const CONNECT_TIMEOUT_MS = 45_000;

async function assertOwner(accountId: string, mailbox: Mailbox): Promise<void> {
  requireTargetAccountId(accountId);
  if (await requireAccountStorage(accountId) !== mailbox.storage) throw new Error('The source account changed during download.');
}

async function credentials(accountId: string, signal: AbortSignal): Promise<IMAPConfig> {
  const raw = readRegistryAccounts().find(account => account.id === accountId)?.imapConfig;
  if (!raw || typeof raw.host !== 'string' || !raw.host || typeof raw.username !== 'string' || !raw.username ||
    typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)
    throw new Error('This account needs its IMAP settings completed.');
  let config = { ...raw } as unknown as IMAPConfig;
  if (config.authMethod === 'oauth2' && config.oauthProvider) {
    config = { ...config, accessToken: await waitForAbortableOperation(getValidAccessToken(config.oauthProvider, config.username), signal) };
  } else {
    // The registry is intentionally secret-free. Match the foreground path's
    // legacy vault aliases without ever loading another account's saved config.
    const ids = [...new Set([accountId, accountIdFor(config.username, config.host), accountIdFor(config.username)])];
    let password: string | undefined;
    for (const id of ids) {
      signal.throwIfAborted();
      const secrets = await waitForAbortableOperation(getAccountSecrets(id), signal);
      if (secrets?.imap?.password) { password = secrets.imap.password; break; }
    }
    if (!password) throw new Error('This account needs its password or sign-in refreshed.');
    config = { ...config, password };
  }
  return attachImapBearer({ ...config, tlsOptions: resolveTlsOptions(config) });
}

/** Reuse the account's reconnect ladder; bootstrap credentials only for a fresh runtime. */
export async function ensureAssistantMailboxConnection(accountId: string, signal?: AbortSignal): Promise<Mailbox & { syncEngine: Engine }> {
  signal?.throwIfAborted();
  requireTargetAccountId(accountId);
  const storage = await requireAccountStorage(accountId);
  const mailbox = await resolveNamedOrActiveAccountTarget(accountId);
  if (mailbox.storage !== storage || !mailbox.syncEngine) throw new Error('This account is unavailable for download.');
  await assertOwner(accountId, mailbox);
  const engine = mailbox.syncEngine;
  if (engine.isConnected()) return { ...mailbox, syncEngine: engine };
  if (getIsQuitting() || getSystemSuspended()) throw new Error('Mail downloads are paused while the app is closing or asleep.');
  if ((failedUntil.get(engine) ?? 0) > Date.now()) throw new Error('This account could not reconnect. Check its connection or sign-in, then try again shortly.');
  let pending = connecting.get(engine);
  if (!pending) {
    pending = (async () => {
      let freshConnect = false;
      const deadline = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
      try {
        if (engine.hasConnectionConfig() || engine.isConnecting()) {
          // False for an existing configuration includes auth failure/backoff.
          // Never clear that state by forcing another password login.
          if (!await waitForAbortableOperation(engine.ensureConnection(), deadline))
            throw new Error('This account could not reconnect. Check its connection or sign-in.');
        } else {
          const config = await credentials(accountId, deadline);
          await assertOwner(accountId, mailbox);
          if (engine.isConnected()) return;
          if (engine.hasConnectionConfig() || engine.isConnecting()) {
            if (!await waitForAbortableOperation(engine.ensureConnection(), deadline))
              throw new Error('This account could not reconnect. Check its connection or sign-in.');
          } else {
            freshConnect = true;
            await waitForAbortableOperation(engine.connect(config), deadline);
          }
        }
        await assertOwner(accountId, mailbox);
        if (!engine.isConnected()) throw new Error('This account did not establish a mail connection.');
        failedUntil.delete(engine);
      } catch (error) {
        failedUntil.set(engine, Date.now() + 60_000);
        // Only tear down a handshake started here. Existing foreground/IDLE
        // sockets and another account's connection remain under their owners.
        if (freshConnect) { try { await engine.disconnect(); } catch {} }
        throw error;
      }
    })().finally(() => { connecting.delete(engine); });
    connecting.set(engine, pending);
  }
  // Cancellation stops this consumer without cancelling another consumer's
  // shared handshake. The handshake itself always has its own deadline.
  await (signal ? waitForAbortableOperation(pending, signal) : pending);
  signal?.throwIfAborted();
  await assertOwner(accountId, mailbox);
  return { ...mailbox, syncEngine: engine };
}

/** Download and persist a missing body through the normal queued BODY.PEEK path. */
export async function fetchAssistantMessageBody(accountId: string, emailId: string, signal?: AbortSignal, options: { force?: boolean } = {}) {
  signal?.throwIfAborted();
  requireTargetAccountId(accountId);
  const storage = await requireAccountStorage(accountId);
  const email = await storage.getEmail(emailId);
  if (!email) return null;
  if (!options.force && (email.cleanBody?.trim() || email.rawBody)) return email;
  const mailbox = await ensureAssistantMailboxConnection(accountId, signal);
  if (mailbox.storage !== storage) throw new Error('The source account changed during download.');
  const current = await storage.getEmail(emailId);
  if (!current) return null;
  const folder = await storage.getFolder(current.folderId);
  if (!folder) throw new Error('The source folder is unavailable.');
  const fetching = fetchBodyQueued(mailbox.syncEngine, emailId, folder.path, current.uid || 0);
  await (signal ? waitForAbortableOperation(fetching, signal) : fetching);
  signal?.throwIfAborted();
  await assertOwner(accountId, mailbox);
  return storage.getEmail(emailId);
}
