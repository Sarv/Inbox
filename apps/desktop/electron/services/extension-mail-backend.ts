/**
 * Extension mail backend — what `context.mail` actually does to the mailbox.
 *
 * Extensions could previously only ASK for a change, by returning
 * `labelsToAdd`/`labelsToRemove` from a workflow, which meant they could act
 * only at the instant a message arrived and never in response to anything the
 * reader did. An extension that puts a verification code on screen could not
 * mark the mail read when the reader copied it, because there was no way for an
 * extension to touch mail at all outside the arrival path.
 *
 * Three rules hold this together:
 *
 *  1. **The permission has already been checked** — by `context.mail`, in the
 *     main process, against the set the user approved at install time. The
 *     label changes are then checked a SECOND time by `planWorkflowEffects`,
 *     which is the same planner a workflow result goes through, so the tag
 *     rules and the refusal of unsyncable flags are written once.
 *  2. **The extension names an id, never a record.** Every method reads the row
 *     itself, so nothing an extension invents about a message reaches storage.
 *  3. **Every mutation is logged with the extension's id.** An installed
 *     extension is third-party code the reader trusted; what it actually did to
 *     their mailbox has to be answerable afterwards from the log alone.
 */

import {
  createLogger,
  planWorkflowEffects,
  type EmailRecord,
  type ExtensionMailBackend,
  type ExtensionMailFolder,
  type ExtensionPermission,
} from '@sarvinbox/core';

import { moveOrCopyOne } from '../ipc/email-handlers';
import {
  findStorageForEmail,
  getAccountIdForStorage,
  getExtensionManager,
  getStorage,
  getStorageFor,
  getSyncEngineForStorage,
  sendToWindow,
} from '../shared';

import { pushFlagToServer } from './flag-push';

const logger = createLogger('extension-mail-backend');

/**
 * The channel that tells the open window an extension changed a message's tags.
 *
 * Every OTHER writer of the `read` tag is the renderer itself, which flips its
 * own row optimistically and then persists — so main has never needed to push a
 * tag change back. An extension inverts that: the write starts in main, lands in
 * the database, reaches the server, and the list the reader is looking at is
 * never told. The symptom is exact — the OTP card's copy button marked the mail
 * read in every store that matters and the row stayed bold until the next sync
 * happened to re-query it, which reads as a button that does nothing.
 *
 * The whole tag string is sent, not "read: true": the same call can add `otp`
 * and flip `read` at once, and a per-flag payload would have to grow a field per
 * tag the SDK ever learns to write.
 */
export const EMAIL_TAGS_UPDATED_CHANNEL = 'emails:tags-updated';

/** What the renderer needs to find the row and replace its tags. */
export interface EmailTagsUpdatedPayload {
  emailId: string;
  accountId: string | null;
  tags: string;
}

/** What the extension was granted, straight from the installed record. */
function permissionsFor(extensionId: string): readonly ExtensionPermission[] {
  return getExtensionManager()?.getExtensionInfo(extensionId)?.manifest.permissions ?? [];
}

/** The folder subset a panel or extension is shown — never the whole row. */
function toExtensionFolder(folder: any, accountId?: string): ExtensionMailFolder {
  return {
    id: String(folder.id),
    name: String(folder.name ?? folder.path ?? folder.id),
    path: String(folder.path ?? ''),
    type: folder.type ? String(folder.type) : undefined,
    accountId,
  };
}

/**
 * Build the backend handed to `ExtensionManager`.
 *
 * The storage lookups are resolved per call rather than captured: an account
 * can be added, switched or closed while an extension is active, and a captured
 * handle would write to a mailbox the reader has since left.
 */
export function createExtensionMailBackend(): ExtensionMailBackend {
  /** The row plus the database it lives in, or a thrown error naming neither. */
  const locate = async (emailId: string): Promise<{ storage: any; email: EmailRecord }> => {
    if (typeof emailId !== 'string' || !emailId) {
      throw new Error('mail: an email id is required');
    }
    const storage = findStorageForEmail(emailId);
    // Deliberately the same message whether the id is unknown or belongs to a
    // closed account: an extension learning WHICH is true would learn something
    // about mailboxes the reader has not opened to it.
    if (!storage) throw new Error(`mail: no message '${emailId}'`);
    const email = await storage.getEmail(emailId);
    if (!email) throw new Error(`mail: no message '${emailId}'`);
    return { storage, email };
  };

  return {
    async get(_extensionId: string, emailId: string): Promise<EmailRecord | null> {
      const storage = findStorageForEmail(emailId);
      if (!storage) return null;
      return (await storage.getEmail(emailId)) ?? null;
    },

    async folders(_extensionId: string, accountId?: string): Promise<ExtensionMailFolder[]> {
      const storage = accountId ? getStorageFor(accountId) : getStorage();
      if (!storage) return [];
      const folders = await storage.getFolders();
      return (folders ?? []).map((folder: any) => toExtensionFolder(folder, accountId));
    },

    /**
     * Apply label and flag changes through the workflow-effect planner.
     *
     * Routing them through the planner rather than writing tags directly is
     * what makes an extension's on-demand change behave exactly like the same
     * change asked for by a workflow: the same sanitisation of the tag name,
     * the same refusal of a flag with no sync path, the same suppression of a
     * server round trip when the message already has the flag.
     */
    async applyLabels(
      extensionId: string,
      emailId: string,
      changes: { add?: string[]; remove?: string[] }
    ): Promise<void> {
      const { storage, email } = await locate(emailId);

      const plan = planWorkflowEffects(email.tags || '||', [
        {
          extensionId,
          permissions: permissionsFor(extensionId),
          result: {
            success: true,
            labelsToAdd: changes.add ?? [],
            labelsToRemove: changes.remove ?? [],
          },
        },
      ]);

      // A refusal here means the planner disagreed with the wrapper that let
      // the call through — a real bug, not extension misbehaviour, so it is
      // raised rather than logged and swallowed.
      for (const rejection of plan.rejected) {
        throw new Error(
          `mail: ${extensionId} may not apply '${rejection.label}' (${rejection.reason})`
        );
      }

      if (plan.changed) {
        await storage.updateEmail(email.id, { tags: plan.tags });
      }
      for (const change of plan.flagChanges) {
        await pushFlagToServer(storage, email, change);
      }

      if (plan.changed) {
        // After the write, never before: a row the renderer paints read while
        // storage still says unread is the optimistic-revert problem again, and
        // main has no revert path — the click that caused it is long gone.
        const payload: EmailTagsUpdatedPayload = {
          emailId: email.id,
          accountId: getAccountIdForStorage(storage),
          tags: plan.tags,
        };
        sendToWindow(EMAIL_TAGS_UPDATED_CHANNEL, payload);
      }

      if (plan.changed || plan.flagChanges.length > 0) {
        logger.info(
          `${extensionId} changed ${email.id}: ` +
            `+[${(changes.add ?? []).join(',')}] -[${(changes.remove ?? []).join(',')}]`
        );
      }
    },

    async move(extensionId: string, emailId: string, folderId: string): Promise<void> {
      const { storage, email } = await locate(emailId);
      if (typeof folderId !== 'string' || !folderId) {
        throw new Error('mail.move: a destination folder id is required');
      }

      const result = await moveOrCopyOne(
        storage,
        getSyncEngineForStorage(storage),
        email.id,
        folderId,
        'move'
      );
      if (!result.ok) throw new Error(`mail.move: ${result.error}`);

      logger.info(`${extensionId} moved ${email.id} to folder ${folderId}`);
      try {
        await storage.recalculateFolderCounts();
      } catch (error) {
        // A recount hiccup must never fail the move — the counts self-correct
        // on the next sync, and the message has already arrived.
        logger.warn('Folder recount after an extension move failed:', error);
      }
    },

    /**
     * Move to the account's trash folder.
     *
     * Never an expunge, and never a local-only deletion: an extension can put a
     * message in the bin, and only the reader empties it. An extension able to
     * destroy mail outright would be one bug away from an unrecoverable
     * mailbox, which no amount of permission prompting makes acceptable.
     */
    async trash(extensionId: string, emailId: string): Promise<void> {
      const { storage, email } = await locate(emailId);

      const folders = await storage.getFolders();
      const trash = (folders ?? []).find((folder: any) => folder?.type === 'trash');
      if (!trash) throw new Error('mail.trash: this account has no trash folder');
      if (email.folderId === trash.id) return;

      const result = await moveOrCopyOne(
        storage,
        getSyncEngineForStorage(storage),
        email.id,
        trash.id,
        'move'
      );
      if (!result.ok) throw new Error(`mail.trash: ${result.error}`);

      logger.info(`${extensionId} moved ${email.id} to trash`);
      try {
        await storage.recalculateFolderCounts();
      } catch (error) {
        logger.warn('Folder recount after an extension trash failed:', error);
      }
    },
  };
}
