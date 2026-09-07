// Category-label strategies — mirror an AI category onto the mail server so it
// is visible in the provider's own UI (Gmail, sarv webmail, Thunderbird, …),
// WITHOUT duplicating mail or removing it from the Inbox where the server
// allows. The right mechanism is chosen from live capabilities, not the
// provider name:
//
//   A. Keyword   — STORE +FLAGS (<slug>) in place. Servers with `\*` in
//                  PERMANENTFLAGS (sarv confirmed, Fastmail, most Dovecot).
//                  In-place, no move, no copy, no duplication.
//   B. Gmail     — COPY to `Sarv Inbox/<Category>` label mailbox. Gmail treats
//                  copy-to-a-label as "add label": the message keeps its INBOX
//                  label and is NOT duplicated. (Colors are applied separately,
//                  main-side, via the Gmail REST API when the account is OAuth.)
//   C. Folder    — no keyword support and not Gmail (Outlook, Yahoo, iCloud web,
//                  unknown servers): create `Sarv Inbox/<Category>` and MOVE
//                  (leaves Inbox) or COPY (keeps Inbox, but a real duplicate) —
//                  the user picks the trade-off via a setting.
//
// Pure IMAP: works with password OR OAuth. Idempotent at the IMAP layer
// (re-applying a keyword / re-copying to an existing Gmail label is a no-op);
// the caller additionally guards re-runs with a local "mirrored" marker.

import type { IIMAPClient } from '../types/imap';
import { logger } from '../utils/logger';
import { detectProvider } from '../utils/provider';

export type FolderLabelMode = 'copy' | 'move';

export interface CategoryLabel {
  /** Keyword-safe identifier, e.g. `finance`, `needs_response`. */
  slug: string;
  /** Human display name, e.g. `Finance`, `Needs Response`. */
  name: string;
}

/** Parent label/folder everything nests under. */
export const SARV_LABEL_PARENT = 'Sarv Inbox';

/** IMAP keyword atom (no spaces / specials) for the keyword strategy. */
export function keywordForCategory(cat: CategoryLabel): string {
  const base = (cat.slug || cat.name || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return base || 'label';
}

/** `Sarv Inbox<delim><Category>` path for the Gmail/folder strategies. */
export function folderPathForCategory(cat: CategoryLabel, delimiter: string): string {
  const leaf = (cat.name || cat.slug || 'Label').replace(new RegExp(`[\\\\${delimiter}]`, 'g'), '-').trim();
  return `${SARV_LABEL_PARENT}${delimiter}${leaf}`;
}

export interface LabelStrategy {
  readonly kind: 'keyword' | 'gmail' | 'folder';
  /** Apply the category to the given messages (in `folderPath`). */
  apply(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void>;
  /** Remove the category from the given messages. Best-effort. */
  remove(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void>;
  /**
   * Register the label up front, without applying it to any message. For the
   * folder/Gmail strategies this CREATEs the label mailbox; for the keyword
   * strategy it CREATEs the top-level registering folder (named == keyword) that
   * Sarv needs to surface keyword-tagged mail under that label.
   */
  ensure(cat: CategoryLabel): Promise<void>;
  /**
   * Rename the label in place when a category's display name changes. No-op for
   * the keyword strategy (its label is keyed on the stable slug, not the name).
   */
  rename(oldCat: CategoryLabel, newCat: CategoryLabel): Promise<void>;
}

// ---- A: in-place keyword ---------------------------------------------------
// The category is applied as an IMAP keyword (STORE +FLAGS) — in place, no move,
// no copy. On most keyword-capable servers (Fastmail, Dovecot) that keyword
// renders as a label on its own, so no folder is registered there. Sarv is the
// exception: it only surfaces our category labels once a matching folder has been
// registered via CREATE. So ONLY for Sarv accounts (`registerLabelFolder`) do we
// register that folder — NESTED under the "Sarv Inbox" parent (e.g.
// "Sarv Inbox/finance"), so all our category labels group tidily under one node
// in the webmail sidebar instead of littering the top level. The mail is still
// tagged in place with the keyword slug; the nested folder is purely the
// label's registration/organisation. An earlier scheme registered these folders
// flat at the top level — `ensure()` deletes any such leftover so the sidebar
// converges on the nested layout (the flat folders never hold mail, so the
// best-effort DELETE can't lose anything).
class KeywordStrategy implements LabelStrategy {
  readonly kind = 'keyword' as const;
  private delimiter?: string;
  constructor(private client: IIMAPClient, private registerLabelFolder = false) {}
  async apply(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    await this.ensure(cat); // Sarv: register the label so the keyword surfaces
    await this.client.selectFolder(folderPath);
    await this.client.addFlags(uids, [keywordForCategory(cat)]);
  }
  async remove(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    await this.client.selectFolder(folderPath);
    await this.client.removeFlags(uids, [keywordForCategory(cat)]);
  }
  async ensure(cat: CategoryLabel): Promise<void> {
    // Only Sarv needs a registering folder; other keyword servers render the
    // keyword natively, so creating a folder there would just be clutter.
    if (!this.registerLabelFolder) return;
    if (this.delimiter === undefined) this.delimiter = (await this.client.getHierarchyDelimiter?.()) ?? '/';
    // Register the label NESTED under "Sarv Inbox" (e.g. "Sarv Inbox/finance").
    // Best-effort + idempotent — the parent and leaf usually already exist after
    // the first provision.
    const nested = folderPathForCategory(cat, this.delimiter);
    try {
      await this.client.createMailbox(SARV_LABEL_PARENT); // parent so the leaf nests
    } catch {
      /* parent already exists */
    }
    try {
      await this.client.createMailbox(nested);
      logger.info(`[LabelStrategy] Sarv keyword-label registered — CREATE "${nested}"`);
    } catch (e) {
      // Usually "already exists"; log at debug so a genuine denial is still visible.
      logger.debug(`[LabelStrategy] CREATE "${nested}" skipped (exists/denied): ${(e as Error).message}`);
    }
    // Migrate away from the earlier flat top-level folder (name == keyword slug).
    // Keyword labels never copy mail into the folder, so it's always empty — the
    // DELETE is safe and no-ops once it's gone. Non-category folders (user labels
    // like "Access"/"Interviews") never match a slug, so they're left untouched.
    const flat = keywordForCategory(cat);
    if (this.client.deleteMailbox) {
      try {
        await this.client.deleteMailbox(flat);
        logger.info(`[LabelStrategy] removed legacy flat label "${flat}" (now nested under "${SARV_LABEL_PARENT}")`);
      } catch {
        /* absent already, or non-empty — leave it */
      }
    }
  }
  async rename(_oldCat: CategoryLabel, _newCat: CategoryLabel): Promise<void> {
    // The keyword (and thus the registered folder name) is the stable slug, not
    // the display name, so a rename doesn't change it. No-op.
  }
}

// ---- B: Gmail label (copy = add label, stays in Inbox, no dupe) ------------
class GmailLabelStrategy implements LabelStrategy {
  readonly kind = 'gmail' as const;
  private delimiter?: string;
  constructor(private client: IIMAPClient) {}
  private async path(cat: CategoryLabel): Promise<string> {
    if (this.delimiter === undefined) this.delimiter = (await this.client.getHierarchyDelimiter?.()) ?? '/';
    return folderPathForCategory(cat, this.delimiter);
  }
  async apply(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    // Create the PARENT label first so Gmail nests the children under it
    // (`Sarv Inbox` ▸ `Meetings`) instead of showing flat `Sarv Inbox/Meetings`.
    await this.client.createMailbox(SARV_LABEL_PARENT);
    const label = await this.path(cat);
    await this.client.createMailbox(label); // idempotent
    await this.client.selectFolder(folderPath);
    await this.client.copyMessages(uids, label); // Gmail: adds the label, keeps INBOX, no duplicate
  }
  async remove(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    // Remove the Gmail label in place via STORE -X-GM-LABELS (no delete, message
    // stays in All Mail). Works off the INBOX uid — no need for the label
    // mailbox's own uid. No-op on a client without Gmail-label support.
    if (!this.client.removeGmailLabels) return;
    await this.client.selectFolder(folderPath);
    await this.client.removeGmailLabels(uids, [await this.path(cat)]);
  }
  async ensure(cat: CategoryLabel): Promise<void> {
    await this.client.createMailbox(SARV_LABEL_PARENT);
    await this.client.createMailbox(await this.path(cat));
  }
  async rename(oldCat: CategoryLabel, newCat: CategoryLabel): Promise<void> {
    if (!this.client.renameMailbox) return;
    await this.client.renameMailbox(await this.path(oldCat), await this.path(newCat));
  }
}

// ---- C: folder (move or copy per setting) ----------------------------------
class FolderStrategy implements LabelStrategy {
  readonly kind = 'folder' as const;
  private delimiter?: string;
  constructor(private client: IIMAPClient, private mode: FolderLabelMode) {}
  private async path(cat: CategoryLabel): Promise<string> {
    if (this.delimiter === undefined) this.delimiter = (await this.client.getHierarchyDelimiter?.()) ?? '/';
    return folderPathForCategory(cat, this.delimiter);
  }
  async apply(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    await this.client.createMailbox(SARV_LABEL_PARENT); // parent so it nests
    const dest = await this.path(cat);
    await this.client.createMailbox(dest);
    await this.client.selectFolder(folderPath);
    if (this.mode === 'move') {
      await this.client.moveMessages(uids, dest); // leaves the inbox, no duplicate
    } else {
      await this.client.copyMessages(uids, dest); // keeps the inbox, but a real duplicate
    }
  }
  async remove(_folderPath: string, _uids: number[], _cat: CategoryLabel): Promise<void> {
    logger.debug('[LabelStrategy] folder remove is a no-op in v1');
  }
  async ensure(cat: CategoryLabel): Promise<void> {
    const dest = await this.path(cat);
    // Provisioning path (once per category per account per session) — log the
    // exact CREATE commands we send so the Sarv/IMAP label setup is visible.
    logger.info(`[LabelStrategy] Sarv IMAP ensure — CREATE "${SARV_LABEL_PARENT}"; CREATE "${dest}" (category "${cat.slug}")`);
    await this.client.createMailbox(SARV_LABEL_PARENT);
    await this.client.createMailbox(dest);
  }
  async rename(oldCat: CategoryLabel, newCat: CategoryLabel): Promise<void> {
    if (!this.client.renameMailbox) return;
    await this.client.renameMailbox(await this.path(oldCat), await this.path(newCat));
  }
}

/**
 * Pick the best label mechanism for this account. Gmail → native labels;
 * else a server that accepts custom keywords → in-place keyword; else folders
 * (move/copy per the user's setting).
 */
export async function resolveLabelStrategy(
  client: IIMAPClient,
  host: string,
  folderMode: FolderLabelMode,
): Promise<LabelStrategy> {
  const provider = detectProvider(host);
  if (provider === 'gmail' || client.supportsGmailLabels?.()) {
    return new GmailLabelStrategy(client);
  }
  if (client.supportsKeywords && (await client.supportsKeywords('INBOX'))) {
    // Sarv (and only Sarv) needs each label registered as a top-level folder for
    // the keyword to surface. Match the sarv.com IMAP domain EXACTLY — anchored
    // so `mysarv.com` / `sarvodaya.com` etc. never trip it — since that folder
    // registration should happen for our own servers, nowhere else.
    const isSarv = /(^|\.)sarv\.com$/i.test((host || '').trim().toLowerCase());
    return new KeywordStrategy(client, isSarv);
  }
  return new FolderStrategy(client, folderMode);
}
