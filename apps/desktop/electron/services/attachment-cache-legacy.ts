import * as fs from 'fs';
import * as path from 'path';

import { createLogger, parseAttachmentNames, resolveWithinDir, safeFilename } from '@sarvinbox/core';

import { readRegistryAccounts } from './accounts-registry';
import { ensureAccountRuntime } from './accounts-runtime';
import { legacyAttachmentCacheRoot, storeCachedAttachment } from './attachment-cache';

const logger = createLogger('attachment-cache-legacy');

/**
 * Retire the PLAINTEXT attachment cache older builds kept in
 * `userData/attachment-cache/<emailId>/<name>` (CASA M-7). It names no account,
 * so each folder is matched to the account whose database has that email:
 *
 *  - mail the server still has (a UID) is re-fetchable: its plaintext goes;
 *  - an unsynced draft (no UID) has its files ONLY here: they are sealed into
 *    that account's store first, then the plaintext goes;
 *  - what no registered account claims (removed accounts, deleted mail) goes
 *    with the rest of the folder — but only once EVERY registered account was
 *    opened and checked. An account that could not be opened (a locked key
 *    store, a primary not yet claimed) might own a draft in here, so the
 *    folder then stays for the next launch. The account list comes from the
 *    throwing `readRegistryAccounts`, and an empty list is not authoritative:
 *    an unreadable store and an empty store are the same value and opposite
 *    facts (CLAUDE.md).
 *
 * Runs at startup until the folder is gone; costs one `readdir` after that.
 */
export async function migrateLegacyAttachmentCache(deps: {
  accountIds?: () => string[];
  openAccount?: (accountId: string) => Promise<{ storage: LegacyLookup } | null>;
} = {}): Promise<'none' | 'done' | 'partial'> {
  const root = legacyAttachmentCacheRoot();
  let names: string[];
  try {
    names = (await fs.promises.readdir(root)).filter((name) => !name.startsWith('.'));
  } catch {
    return 'none';
  }

  let accountIds: string[];
  try {
    accountIds = (deps.accountIds ?? (() => readRegistryAccounts().map((account) => account.id)))();
  } catch (error) {
    logger.warn('[attachment-cache] legacy cache kept: the account list could not be read', (error as Error).message);
    return 'partial';
  }
  if (!accountIds.length) return 'partial';

  const openAccount = deps.openAccount ?? ensureAccountRuntime;
  const unclaimed = new Set(names);
  let complete = true;
  let adopted = 0;
  for (const accountId of accountIds) {
    const runtime = await openAccount(accountId).catch(() => null);
    if (!runtime?.storage) {
      complete = false;
      continue;
    }
    for (const name of [...unclaimed]) {
      let email: LegacyEmail | null | undefined;
      try {
        email = await runtime.storage.getEmail(name);
      } catch {
        // A busy or failing database is not "not this account's mail": the
        // folder may hold an unsynced draft's only copy. Keep it for next time.
        complete = false;
        continue;
      }
      if (!email) continue;
      unclaimed.delete(name);
      if (await retireLegacyEmail(accountId, email, path.join(root, name))) adopted++;
      else complete = false;
    }
  }

  if (!complete) {
    logger.info(`[attachment-cache] legacy cache partly retired (${adopted} email folder(s)); the rest waits for every account to open`);
    return 'partial';
  }
  await fs.promises.rm(root, { recursive: true, force: true });
  logger.info(`[attachment-cache] legacy plaintext cache removed (${adopted} email folder(s) matched to an account)`);
  return 'done';
}

interface LegacyEmail {
  id: string;
  uid?: number | null;
  attachmentNames?: string | null;
}

interface LegacyLookup {
  getEmail(id: string): Promise<LegacyEmail | null | undefined>;
}

/** Seal an unsynced draft's files, then remove the plaintext folder. False keeps it. */
async function retireLegacyEmail(accountId: string, email: LegacyEmail, dir: string): Promise<boolean> {
  if (!email.uid) {
    for (const filename of parseAttachmentNames(email.attachmentNames)) {
      let content: Buffer;
      try {
        content = await fs.promises.readFile(resolveWithinDir(dir, safeFilename(filename)));
      } catch (error) {
        // Never cached, or already moved by an open of the draft: nothing to keep.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Unreadable right now (permissions, I/O): it may be the only copy.
        logger.warn('[attachment-cache] could not read a legacy draft attachment; keeping it for the next launch', error);
        return false;
      }
      try {
        await storeCachedAttachment(accountId, email.id, filename, content);
      } catch (error) {
        logger.warn('[attachment-cache] could not seal a legacy draft attachment; keeping it for the next launch', error);
        return false;
      } finally {
        content.fill(0);
      }
    }
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
  return true;
}
