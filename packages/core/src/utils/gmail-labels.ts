/**
 * Gmail label → local tag mapping.
 *
 * Gmail's IMAP is labels wearing a folder costume: ONE message with labels
 * `Inbox` + `Promotions` appears in three mailboxes (`INBOX`, `Promotions`,
 * `[Gmail]/All Mail`) as the same message with a different UID in each. The
 * historical download therefore runs over the All Mail SUPERSET once, instead of
 * fetching a message again for every label it carries.
 *
 * That optimisation only works if the labels come with it. Without them every
 * backfilled message is tagged `|[Gmail]/All Mail|` and nothing else, so it is
 * invisible in INBOX, Starred and every label view even though it is on disk —
 * which is exactly what "Gmail stuck at 88 mails" was.
 *
 * This module is the pure mapping half (no IMAP, no storage) so the rules are
 * unit-testable:
 *
 *   \\Inbox, \\Sent, \\Draft, \\Trash, \\Junk   → the FOLDER path for that role
 *   \\Starred                                   → a FLAG tag (never a folder!)
 *   \\Important                                 → DROPPED (this app's AI owns
 *                                                 importance; see below)
 *   "Sarv Inbox/Promotions"                     → the CATEGORY slug it mirrors
 *   "access", "Work/Clients"                    → the user's own label, verbatim
 */

import { SARV_LABEL_PARENT } from '../imap/label-strategy';

/**
 * Gmail's system labels. These arrive backslash-prefixed (`\\Inbox`) and must
 * NOT be treated as user labels — tagging a message `|\\Starred|` would invent a
 * folder named "\Starred" and still leave the star missing.
 *
 * `\\Starred` maps to a FLAG tag because that is how this app models a star; the
 * rest map to a folder ROLE the caller resolves to a real path (a mailbox's path
 * differs per account: `[Gmail]/Sent Mail` vs `Sent`).
 *
 * `\\Important` is DELIBERATELY ABSENT — do not add it back. This app's AI is the
 * sole source of the `important` tag, which is why `getSelectableFolders` also
 * skips the `[Gmail]/Important` mailbox. Mapping the label here re-admitted
 * Gmail's own guess through the label path, so mail arriving while the AI was
 * down still wore an "Important" chip nothing in this app had decided on.
 * Unlisted `\\System` labels fall through to the drop branch in `mapGmailLabels`.
 */
const SYSTEM_LABEL_FLAGS: Record<string, string> = {
  '\\starred': 'starred',
};

/** Folder ROLES a system label denotes, resolved to a path by the caller. */
export type GmailFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';

const SYSTEM_LABEL_ROLES: Record<string, GmailFolderRole> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\draft': 'drafts',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'spam',
  '\\spam': 'spam',
  '\\all': 'archive',
};

export interface GmailLabelMapping {
  /** Folder roles this message belongs to (`\\Inbox` → 'inbox'). */
  roles: GmailFolderRole[];
  /** Plain label paths, as the user sees them (`access`, `Work/Clients`). */
  labels: string[];
  /** Flag tags implied by system labels (`starred`, `important`). */
  flags: string[];
  /**
   * Category slugs recovered from this app's OWN mirror labels
   * (`Sarv Inbox/Promotions` → `promotions`). Recovering these is what lets old
   * mail regain its category chips without paying an LLM to re-classify it.
   */
  categories: string[];
}

/**
 * Normalise one raw label. Gmail may send it quoted, with escaped quotes, or
 * with the `[Gmail]/` prefix on the system mailboxes.
 */
function normalizeLabel(raw: string): string {
  let label = String(raw ?? '').trim();
  if (label.startsWith('"') && label.endsWith('"') && label.length >= 2) {
    label = label.slice(1, -1);
  }
  // Gmail escapes embedded quotes and backslashes inside a quoted label.
  return label.replace(/\\(["\\])/g, '$1').trim();
}

/** A category as the app knows it — used to resolve a mirror label exactly. */
export interface KnownCategory {
  slug: string;
  name?: string;
}

/**
 * Slug form of a category's display name: trimmed, lowercased, runs of spaces
 * and dashes collapsed to `_`. "Needs Response" and "needs-response" both land
 * on `needs_response`, which is how definitions store their slug.
 */
export const categoryNameSlug = (name: string): string =>
  String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * Resolve a BARE category label — a leaf with no `Sarv Inbox` parent — against
 * the app's own category definitions. Matched by display NAME first, then by
 * slug, because the mirror leaf is built from the display name
 * (`folderPathForCategory`) while everything else keys off the slug.
 *
 * Returns the definition's slug, or null when nothing matches — an unresolved
 * leaf is the user's own label, never an invented category.
 */
export function matchKnownCategory(
  leaf: string,
  knownCategories: readonly KnownCategory[] | null | undefined,
): string | null {
  if (!knownCategories?.length) return null;
  const target = categoryNameSlug(leaf);
  if (!target) return null;
  const match = knownCategories.find(
    (c) => (c.name && categoryNameSlug(c.name) === target) || categoryNameSlug(c.slug) === target,
  );
  return match ? match.slug : null;
}

/**
 * Turn a mirror label into its category slug, or null when it isn't one.
 *
 * `folderPathForCategory` builds the leaf from the category's DISPLAY NAME and
 * replaces the delimiter with `-`, so no string transform can invert it reliably
 * (a category named "A/B" is stored as "A-B"). Pass `knownCategories` and the
 * leaf is matched against real definitions — by name first, then slug. The
 * transform is only the fallback for when the caller has no definitions handy,
 * and an unresolved leaf returns null rather than inventing a category.
 */
export function categorySlugFromLabel(
  label: string,
  parent = SARV_LABEL_PARENT,
  knownCategories?: readonly KnownCategory[],
): string | null {
  const lower = label.toLowerCase();
  const parentLower = parent.toLowerCase();
  if (!lower.startsWith(parentLower)) return null;
  // Any single delimiter may follow the parent ('/' on Gmail, '.' elsewhere).
  const rest = label.slice(parent.length);
  // Only a REAL hierarchy delimiter counts. Accepting any non-alphanumeric here
  // would swallow a user's own label such as "Sarv Inbox Archive" (space is not
  // a delimiter) and hide their mail under a category that doesn't exist.
  if (rest.length < 2 || !'/.\\'.includes(rest[0])) return null;
  const leaf = rest.slice(1).trim();
  if (!leaf) return null;

  if (knownCategories?.length) return matchKnownCategory(leaf, knownCategories);
  return categoryNameSlug(leaf);
}

/**
 * Classify a message's Gmail labels.
 *
 * Unknown backslash-prefixed labels are DROPPED rather than guessed at: a future
 * Gmail system label must not silently become a folder named `\Whatever`. Plain
 * labels are kept verbatim — a user label called `access` has to show the same
 * messages here as it does in Gmail.
 */
export function mapGmailLabels(
  rawLabels: readonly string[] | null | undefined,
  options: { categoryParent?: string; knownCategories?: readonly KnownCategory[] } = {},
): GmailLabelMapping {
  const roles: GmailFolderRole[] = [];
  const labels: string[] = [];
  const flags: string[] = [];
  const categories: string[] = [];
  if (!rawLabels) return { roles, labels, flags, categories };

  for (const raw of rawLabels) {
    const label = normalizeLabel(raw);
    if (!label) continue;

    if (label.startsWith('\\')) {
      const key = label.toLowerCase();
      const flag = SYSTEM_LABEL_FLAGS[key];
      if (flag) {
        if (!flags.includes(flag)) flags.push(flag);
        continue;
      }
      const role = SYSTEM_LABEL_ROLES[key];
      if (role) {
        if (!roles.includes(role)) roles.push(role);
      }
      // Unknown `\System` label: intentionally ignored (see doc above).
      continue;
    }

    const parent = options.categoryParent ?? SARV_LABEL_PARENT;
    const slug = categorySlugFromLabel(label, parent, options.knownCategories);
    if (slug) {
      if (!categories.includes(slug)) categories.push(slug);
      continue;
    }
    // A `Sarv Inbox/*` label we could NOT resolve to a known category is still
    // ours, not the user's — keep it out of their label list rather than
    // materialising a folder for a category that no longer exists.
    if (categorySlugFromLabel(label, parent) !== null) continue;

    if (!labels.includes(label)) labels.push(label);
  }

  return { roles, labels, flags, categories };
}
