import { fnv1a32Hex } from './fnv1a';

/**
 * Stand-ins a log line uses for names that belong to the user: the account
 * (whose id spells out the address), folders and labels they created, and AI
 * categories they named. Each is a short hash, so lines about the same thing
 * still read as the same thing and `grep` still finds them, but the name
 * itself never reaches app.log or a crash report.
 *
 * A hash of a guessable name can be confirmed by someone who already has the
 * name (the per-account database file name, a truncated SHA-256 of the same
 * id, has the same property); it can never be read back. That is the line
 * drawn here: a log a user attaches to a bug report must not tell a reader
 * whose mailbox it is or what its folders are called.
 *
 * Pure, and imports only `fnv1a` (itself import-free), so the renderer
 * deep-imports it as `@sarvinbox/core/log-labels` and labels the same names
 * the same way main does.
 */

const label = (kind: string, value: string): string => `${kind}#${fnv1a32Hex(value)}`;

/**
 * An account id for a log line: `acct#` and 8 hex digits. An id is built from
 * the address and the server (`acct-<local part>-<domain>--<host>`, see
 * accountIdFor), so writing it as is names the account's owner on every line
 * that mentions it. A missing id is written as `missing` (`acct#none` unless
 * the caller says what no id means there, such as `active`).
 */
export function accountLogLabel(id: unknown, missing = 'acct#none'): string {
  if (typeof id !== 'string' || id.length === 0) return missing;
  return label('acct', id);
}

// What accountIdFor produces: `acct-` and the normalised address and host,
// which are lower-case letters, digits and dashes only. One character class
// with one quantifier, so the scan is linear however the text is built.
const ACCOUNT_ID = /\bacct-[a-z0-9-]+/g;

/**
 * Every account id in `text` replaced by its {@link accountLogLabel}: the
 * backstop for a line that wrote an id without labelling it. A label is not
 * matched again (`acct#…` is not `acct-…`), so running this twice changes
 * nothing. An id followed by more dashes and letters (`${id}-backfill`) is
 * labelled with them, which only makes that one label differ.
 */
export function redactAccountIds(text: string): string {
  return text.replace(ACCOUNT_ID, (id) => accountLogLabel(id));
}

// Folder names every server or provider uses for its own folders. They name
// nothing the user typed, and a log line that says "Sent Items" or
// "[Gmail]/All Mail" is far easier to debug than a hash, so they stay as
// written. Compared case-insensitively. Anything else is a folder the user
// (or someone sharing it with them) named: a client, a person, a project.
const SYSTEM_FOLDER_NAMES = new Set(
  [
    'INBOX', 'Outbox', 'Archive', 'Archives', 'All Mail', 'Notes', 'Starred', 'Important',
    'Sent', 'Sent Items', 'Sent Messages', 'Sent Mail',
    'Drafts', 'Draft',
    'Trash', 'Deleted', 'Deleted Items', 'Deleted Messages', 'Bin',
    'Spam', 'Junk', 'Junk Email', 'Junk E-mail', 'Bulk Mail',
    '[Gmail]', '[Google Mail]',
    'Conversation History', 'Scheduled', 'Snoozed',
  ].map((name) => name.toLowerCase()),
);
const PROVIDER_ROOTS = ['[gmail]/', '[google mail]/'];
// The app's own views and ids: `virtual-starred`, a generated `folder-<16 hex>`
// id (already a hash of the path), `section:inbox`. Ours, so as written.
const APP_FOLDER_ID = /^(?:virtual-[a-z-]{1,32}|folder-[a-f0-9]{16}|section:[a-z0-9_-]{1,32})$/;

function isSystemFolderName(path: string): boolean {
  const lower = path.toLowerCase();
  if (SYSTEM_FOLDER_NAMES.has(lower)) return true;
  // `[Gmail]/Sent Mail`, `INBOX.Sent`, `INBOX/Drafts`: a provider root or the
  // inbox, then one system name. `INBOX/Acme` is the user's.
  for (const root of [...PROVIDER_ROOTS, 'inbox/', 'inbox.']) {
    if (lower.startsWith(root)) return SYSTEM_FOLDER_NAMES.has(lower.slice(root.length));
  }
  return false;
}

/**
 * A folder path for a log line: a system folder (`INBOX`, `Sent Items`,
 * `[Gmail]/All Mail`) and the app's own view ids (`virtual-starred`) as
 * written, any other folder as `folder#` and 8 hex digits. Folder names are
 * typed by the user (often a person's or a client's name), so they are user
 * text. `folder#none` for a missing path.
 */
export function folderLogLabel(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) return 'folder#none';
  if (path.length <= 64 && (isSystemFolderName(path) || APP_FOLDER_ID.test(path))) return path;
  return label('folder', path);
}

/**
 * A label or tag name the user created (a Gmail label, a local tag) for a log
 * line: `label#` and 8 hex digits. `label#none` for a missing name.
 */
export function labelLogLabel(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) return 'label#none';
  return label('label', name);
}

/**
 * An AI category for a log line: a built-in category's slug as written (the
 * app named it), a category the user created as `category#` and 8 hex digits
 * (its slug is made from the name they typed). `system` is the definition's
 * `is_system` flag; when the caller does not know it, pass a set of the
 * built-in slugs instead.
 */
export function categoryLogLabel(slug: unknown, system: boolean | ReadonlySet<string>): string {
  if (typeof slug !== 'string' || slug.length === 0) return 'category#none';
  const builtIn = typeof system === 'boolean' ? system : system.has(slug);
  return builtIn ? slug : label('category', slug);
}
