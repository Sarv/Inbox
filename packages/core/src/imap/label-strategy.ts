// Category-label strategies — mirror an AI category onto the mail server so it
// is visible in the provider's own UI (Gmail, sarv webmail, Thunderbird, …),
// WITHOUT duplicating mail or removing it from the Inbox where the server
// allows. The mechanism is chosen by WHOSE server it is first, capability
// second:
//
//   A. Keyword   — OUR OWN HOST ONLY (sarv.com). STORE +FLAGS (<slug>) in
//                  place: no move, no copy, no duplication, and NOTHING
//                  created — the bare category name IS the label and the sarv
//                  webmail team owns creating and rendering it. No
//                  `Sarv Inbox/` prefix is ever sent to our own server.
//   B. Gmail     — COPY to `Sarv Inbox/<Category>` label mailbox. Gmail treats
//                  copy-to-a-label as "add label": the message keeps its INBOX
//                  label and is NOT duplicated. (Colors are applied separately,
//                  main-side, via the Gmail REST API when the account is OAuth.)
//   C. Folder    — EVERY other host (Outlook, Yahoo, iCloud, Fastmail,
//                  Dovecot, unknown servers): create `Sarv Inbox/<Category>`
//                  and MOVE (leaves Inbox) or COPY (keeps Inbox, but a real
//                  duplicate) — the user picks the trade-off via a setting.
//
// So the `Sarv Inbox/` prefix is sent to EVERY host except our own. On a
// third-party server nobody is going to create our categories for us, and the
// prefix is what keeps the labels we do create from passing as the user's own
// folders. A bare keyword there would land in whatever corner of that webmail
// shows custom flags, named by no one — which is why keyword capability alone
// no longer earns the keyword strategy.
//
// Pure IMAP: works with password OR OAuth. Idempotent at the IMAP layer
// (re-applying a keyword / re-copying to an existing Gmail label is a no-op);
// the caller additionally guards re-runs with a local "mirrored" marker.
import type { IIMAPClient } from '../types/imap';
import { logger } from '../utils/logger';
import { detectProvider } from '../utils/provider';

import { withFolderSelected } from './with-folder';

export type FolderLabelMode = 'copy' | 'move';

export interface CategoryLabel {
  /** Keyword-safe identifier, e.g. `finance`, `needs_response`. */
  slug: string;
  /** Human display name, e.g. `Finance`, `Needs Response`. */
  name: string;
}

/** Parent label/folder everything nests under. */
export const SARV_LABEL_PARENT = 'Sarv Inbox';

/**
 * Is this account on OUR OWN mail server?
 *
 * The single question the label mechanism turns on: our host gets bare
 * keywords (the sarv webmail team creates and renders the categories), every
 * other host gets the `Sarv Inbox/` prefix. It also gates the one-time cleanup
 * of the leftover `Sarv Inbox/*` folders an earlier scheme created, because
 * nothing else's mailboxes are ours to remove.
 *
 * Matched against the sarv.com domain EXACTLY — anchored so `mysarv.com`,
 * `sarvodaya.com` and `sarv.com.evil.test` can never trip it.
 */
export function isSarvHost(host: string): boolean {
  return /(^|\.)sarv\.com$/i.test((host || '').trim().toLowerCase());
}

/**
 * Matches the shared parent itself and anything nested under it, whatever the
 * server's hierarchy delimiter. The one definition of "this mailbox is one of
 * ours" for the providers that get the `Sarv Inbox/` prefix.
 */
export function isSarvLabelPath(path: string): boolean {
  return path === SARV_LABEL_PARENT || /^Sarv Inbox[\\/.]/.test(path);
}

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

/**
 * DELETE a mailbox, but ONLY once the server has confirmed it holds no mail.
 *
 * IMAP's DELETE destroys the messages in the mailbox, so "I think it's empty"
 * is not good enough: an unreadable STATUS and an empty mailbox are the same
 * silence and opposite facts. A probe that fails — gone already, denied, a
 * connection blip — means "leave it alone", never "it was empty". Returns true
 * only when a mailbox was actually deleted.
 */
async function deleteIfEmpty(client: IIMAPClient, path: string): Promise<boolean> {
  if (!client.deleteMailbox) return false;
  try {
    const status = await client.getFolderStatus(path);
    // A malformed answer is not a zero: no count means we never learned the
    // count, which is the same "unreadable is not empty" rule as the catch.
    if (typeof status?.messages !== 'number' || status.messages > 0) return false;
  } catch {
    return false; // absent, denied, or unreachable — all mean "don't touch it"
  }
  try {
    await client.deleteMailbox(path);
    return true;
  } catch {
    return false; // non-empty children, or denied — the server said no
  }
}

export interface LabelStrategy {
  readonly kind: 'keyword' | 'gmail' | 'folder';
  /** Apply the category to the given messages (in `folderPath`). */
  apply(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void>;
  /** Remove the category from the given messages. Best-effort. */
  remove(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void>;
  /**
   * Register the label up front, without applying it to any message. For the
   * folder/Gmail strategies this CREATEs the `Sarv Inbox/<Category>` mailbox.
   * A no-op for the keyword strategy: there the keyword IS the label, so there
   * is nothing to create — we flag the mail and the server renders it.
   */
  ensure(cat: CategoryLabel): Promise<void>;
  /**
   * One-time cleanup of a label scheme we no longer use, for THIS category.
   * Called from the provisioning pass only (never from `apply`), so it may cost
   * extra round-trips. Optional: a strategy with nothing to migrate omits it.
   */
  migrate?(cat: CategoryLabel): Promise<void>;
  /**
   * Rename the label in place when a category's display name changes. No-op for
   * the keyword strategy (its label is keyed on the stable slug, not the name).
   */
  rename(oldCat: CategoryLabel, newCat: CategoryLabel): Promise<void>;
}

// ---- A: in-place keyword — OUR OWN HOST ONLY -------------------------------
// The category is applied as an IMAP keyword (STORE +FLAGS) — in place, no move,
// no copy, and NOTHING is created. The label is the bare category name
// (`important`, `needs_response`, `invoices`) with NO `Sarv Inbox/` prefix,
// because on our own server the webmail team creates those categories and
// renders the keyword against them. We flag the mail; they show it.
//
// Every OTHER provider goes through the Gmail or folder strategy, where the
// label IS a mailbox and carries the `Sarv Inbox/` prefix — there the prefix is
// what stops our labels from passing as the user's own folders, and there is no
// one on the far side to name a bare keyword.
//
// Reached only via `resolveLabelStrategy`, which constructs this strategy for a
// sarv host and nothing else — so every method here may assume it is on ours.
//
// An interim scheme did CREATE registration folders on Sarv, nested under
// "Sarv Inbox" (e.g. "Sarv Inbox/Finance"). They matched no keyword, so they
// surfaced nothing and only littered the sidebar. `migrate()` prunes that tree
// — but only mailboxes the server CONFIRMS are empty (see deleteIfEmpty).
class KeywordStrategy implements LabelStrategy {
  readonly kind = 'keyword' as const;
  private delimiter?: string;
  constructor(private client: IIMAPClient) {}
  async apply(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    // UIDs are only meaningful in the mailbox they came from, so the STORE must
    // land in the mailbox this select opened — hence the held selection rather
    // than select-then-store (a concurrent re-select in the gap would flag
    // whatever messages happen to hold those UIDs in some other folder).
    await withFolderSelected(this.client, folderPath, () =>
      this.client.addFlags(uids, [keywordForCategory(cat)]));
  }
  async remove(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    await withFolderSelected(this.client, folderPath, () =>
      this.client.removeFlags(uids, [keywordForCategory(cat)]));
  }
  async ensure(_cat: CategoryLabel): Promise<void> {
    // Nothing to provision: the keyword IS the label. Creating a mailbox to
    // "register" it only adds a folder the user then has to look at.
  }
  /**
   * Undo the interim nested scheme on our own host: drop `Sarv Inbox/<Category>`
   * and, once the last one is gone, the now-childless `Sarv Inbox` parent.
   *
   * Runs from the provisioning pass only — NOT from `apply()` — so tagging a
   * message stays a single STORE and never pays for a one-time cleanup.
   */
  async migrate(cat: CategoryLabel): Promise<void> {
    if (this.delimiter === undefined) this.delimiter = (await this.client.getHierarchyDelimiter?.()) ?? '/';
    const nested = folderPathForCategory(cat, this.delimiter);
    if (await deleteIfEmpty(this.client, nested)) {
      logger.info(`[LabelStrategy] removed nested label "${nested}" (keyword labels need no folder)`);
    }
    // The parent goes only once nothing is left under it — CHECKED, not assumed.
    // Plenty of servers will happily DELETE a mailbox that still has inferiors
    // and take the whole subtree with it, so "the last category just migrated"
    // is not a safe stand-in for "this node is childless".
    if (await this.parentIsChildless() && await deleteIfEmpty(this.client, SARV_LABEL_PARENT)) {
      logger.info(`[LabelStrategy] removed the now-empty "${SARV_LABEL_PARENT}" parent`);
    }
  }
  /** True only when the server LISTS nothing under the parent. Unknown → false. */
  private async parentIsChildless(): Promise<boolean> {
    if (!this.client.listMailboxPaths) return false;
    try {
      const paths = await this.client.listMailboxPaths();
      return !paths.some((p) => p !== SARV_LABEL_PARENT && isSarvLabelPath(p));
    } catch {
      return false;
    }
  }
  async rename(_oldCat: CategoryLabel, _newCat: CategoryLabel): Promise<void> {
    // The keyword is the stable slug, not the display name, so a rename doesn't
    // change it. No-op.
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
    await withFolderSelected(this.client, folderPath, () =>
      this.client.copyMessages(uids, label)); // Gmail: adds the label, keeps INBOX, no duplicate
  }
  async remove(folderPath: string, uids: number[], cat: CategoryLabel): Promise<void> {
    // Remove the Gmail label in place via STORE -X-GM-LABELS (no delete, message
    // stays in All Mail). Works off the INBOX uid — no need for the label
    // mailbox's own uid. No-op on a client without Gmail-label support.
    if (!this.client.removeGmailLabels) return;
    const label = await this.path(cat); // resolved outside the section — no round-trip held
    await withFolderSelected(this.client, folderPath, () =>
      this.client.removeGmailLabels!(uids, [label]));
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
    await withFolderSelected(this.client, folderPath, async () => {
      if (this.mode === 'move') {
        await this.client.moveMessages(uids, dest); // leaves the inbox, no duplicate
      } else {
        await this.client.copyMessages(uids, dest); // keeps the inbox, but a real duplicate
      }
    });
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
 * Pick the label mechanism for this account: Gmail → native labels; OUR OWN
 * host → in-place keyword, no prefix; every other host → `Sarv Inbox/` folders
 * (move/copy per the user's setting).
 *
 * The keyword strategy is gated on the HOST, not on `supportsKeywords`. Plenty
 * of third-party servers accept custom keywords (Fastmail, most Dovecot), but
 * only our own webmail turns one into a category the user can see — anywhere
 * else the keyword is a flag nobody named, so those accounts get the prefixed
 * mailbox instead. `supportsKeywords` stays on the client as a capability
 * probe; the label choice no longer consults it.
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
  if (isSarvHost(host)) {
    return new KeywordStrategy(client);
  }
  return new FolderStrategy(client, folderMode);
}
