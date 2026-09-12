// Folder Mapping Configuration (Browser-safe copy)
// Mirrors @sarvinbox/core/config/folder-mapping.ts for the renderer process.
//
// Resolution strategy: IMAP SPECIAL-USE (RFC 6154) → known path → name
// heuristic. Use classifyFolder/findFolderByType to identify Drafts/Sent/
// Trash/Spam/Archive across Gmail, Outlook/Exchange, iCloud, Fastmail, Yahoo,
// and generic IMAP servers rather than hardcoding "[Gmail]/..." paths.

export type StandardFolderType =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'archive'
  | 'starred'
  | 'important';

export const SPECIAL_USE_TO_TYPE: Record<string, StandardFolderType> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'spam',
  '\\Flagged': 'starred',
  '\\Archive': 'archive',
  '\\All': 'archive',
  '\\Important': 'important',
};

export const STANDARD_FOLDER_MAP: Record<StandardFolderType, string[]> = {
  inbox: ['INBOX', 'Inbox'],
  sent: ['[Gmail]/Sent Mail', 'Sent Items', 'Sent Messages', 'Sent'],
  drafts: ['[Gmail]/Drafts', 'Drafts', 'Draft'],
  trash: ['[Gmail]/Trash', '[Gmail]/Bin', 'Deleted Items', 'Deleted Messages', 'Trash', 'Deleted'],
  spam: ['[Gmail]/Spam', 'Junk E-mail', 'Junk Email', 'Bulk Mail', 'Spam', 'Junk'],
  archive: ['[Gmail]/All Mail', 'Archive', 'All Mail', 'Archives'],
  starred: ['[Gmail]/Starred', 'Starred', 'Flagged'],
  important: ['[Gmail]/Important', 'Important'],
};

const NAME_HEURISTICS: Array<{ type: StandardFolderType; test: (lc: string) => boolean }> = [
  { type: 'drafts',    test: (n) => n === 'drafts' || n === 'draft' },
  { type: 'sent',      test: (n) => n === 'sent' || n === 'sent mail' || n === 'sent items' || n === 'sent messages' },
  { type: 'trash',     test: (n) => n === 'trash' || n === 'bin' || n === 'deleted' || n === 'deleted items' || n === 'deleted messages' },
  { type: 'spam',      test: (n) => n === 'spam' || n === 'junk' || n === 'junk email' || n === 'junk e-mail' || n === 'bulk mail' },
  { type: 'archive',   test: (n) => n === 'archive' || n === 'archives' || n === 'all mail' },
  { type: 'starred',   test: (n) => n === 'starred' || n === 'flagged' },
  { type: 'important', test: (n) => n === 'important' },
  { type: 'inbox',     test: (n) => n === 'inbox' },
];

export interface ClassifiableFolder {
  path: string;
  name?: string;
  specialUse?: string | null;
  // Optional sync state, present on a stored FolderRecord and absent on a bare
  // LIST entry — see isSamePhysicalMailbox.
  uidValidity?: number | null;
  /** Rows TAGGED with this folder — counts a shared message under every name. */
  totalCount?: number | null;
  /**
   * Rows FILED here (primary `folder_id`), counted once. Attached by the main
   * process for contested roles only; absent means "not measured". Mirrors
   * core's ClassifiableFolder.ownedCount — the count that separates two names
   * for one mailbox, where the tag count reads full under both.
   */
  ownedCount?: number | null;
  serverMessageCount?: number | null;
}

export function classifyFolder(folder: ClassifiableFolder): StandardFolderType | null {
  if (folder.specialUse) {
    const type = SPECIAL_USE_TO_TYPE[folder.specialUse];
    if (type) return type;
  }
  for (const [type, paths] of Object.entries(STANDARD_FOLDER_MAP)) {
    if (paths.some(p => p === folder.path)) return type as StandardFolderType;
  }
  const lastSeg = (folder.path.split('/').pop() || folder.name || '').toLowerCase().trim();
  if (lastSeg) {
    for (const h of NAME_HEURISTICS) {
      if (h.test(lastSeg)) return h.type;
    }
  }
  return null;
}

/**
 * How strongly a folder matches a standard type — LOWER is stronger, `null`
 * when it isn't that type at all. Mirrors core's folderTypeMatchStrength:
 * SPECIAL-USE (0) beats a known provider path (1 + its preference index) beats
 * a name that merely looks the part. A provider exposing two mailboxes for one
 * role (Sarv lists both `Sent` and an alias `Sent Mail`) then resolves to the
 * real one instead of to whichever the server listed first.
 */
export function folderTypeMatchStrength(folder: ClassifiableFolder, type: StandardFolderType): number | null {
  if (classifyFolder(folder) !== type) return null;
  if (folder.specialUse && SPECIAL_USE_TO_TYPE[folder.specialUse] === type) return 0;
  const knownPaths = STANDARD_FOLDER_MAP[type] ?? [];
  const knownIndex = knownPaths.indexOf(folder.path);
  return knownIndex >= 0 ? 1 + knownIndex : 1 + knownPaths.length;
}

const localRowCount = (folder: ClassifiableFolder): number =>
  folder.ownedCount ?? folder.totalCount ?? 0;

/**
 * Mirrors core: a folder is FULL when it holds essentially everything the
 * server says that mailbox contains, and two names that are EACH full are two
 * different mailboxes whatever the server reports. One store is filed under
 * one name — dedup keeps a single row and tags the other name — so of two names
 * for one mailbox exactly one is full and the other starved.
 */
const POPULATED_FRACTION = 0.9;

const isFullyPopulated = (folder: ClassifiableFolder): boolean =>
  !!folder.serverMessageCount &&
  localRowCount(folder) >= folder.serverMessageCount * POPULATED_FRACTION;

const bothHoldTheirOwnMail = (a: ClassifiableFolder, b: ClassifiableFolder): boolean =>
  isFullyPopulated(a) && isFullyPopulated(b);

/**
 * Two names for one store are SELECTed at different moments, so their stored
 * EXISTS are snapshots that rarely match to the message (the live account:
 * 1,713 and 1,718). Allow the drift a genuinely distinct pair could not fit in.
 */
const SERVER_COUNT_SLACK_ROWS = 32;
const SERVER_COUNT_SLACK_FRACTION = 0.02;

function serverCountsAgree(a: ClassifiableFolder, b: ClassifiableFolder): boolean {
  if (a.serverMessageCount == null || b.serverMessageCount == null) return false;
  const larger = Math.max(a.serverMessageCount, b.serverMessageCount);
  const slack = Math.max(SERVER_COUNT_SLACK_ROWS, larger * SERVER_COUNT_SLACK_FRACTION);
  return Math.abs(a.serverMessageCount - b.serverMessageCount) <= slack;
}

/**
 * Are these two folder records the same physical mailbox under two names?
 * Mirrors core's isSamePhysicalMailbox: UIDVALIDITY identifies a mailbox and
 * two names for one store report the same EXISTS. Both come from a SELECT, so
 * this is `false` until each has synced once — unsure means "different
 * mailboxes", and different mailboxes are never merged.
 */
export function isSamePhysicalMailbox(a: ClassifiableFolder, b: ClassifiableFolder): boolean {
  if (bothHoldTheirOwnMail(a, b)) return false;
  if (!a.uidValidity || !b.uidValidity) return false;
  if (a.uidValidity !== b.uidValidity) return false;
  return serverCountsAgree(a, b);
}

/**
 * The weaker question: do these two LOOK like one mailbox? Same message count
 * on the server, and no UIDVALIDITY saying otherwise. It decides only which of
 * two folders to SHOW, so it may be satisfied by a server that never reports
 * UIDVALIDITY; core's isSamePhysicalMailbox stays strict because it governs
 * dropping a mailbox from sync.
 */
function looksLikeSameMailbox(a: ClassifiableFolder, b: ClassifiableFolder): boolean {
  // Both names filled to their own server count settles it first.
  if (bothHoldTheirOwnMail(a, b)) return false;
  // Equal UIDVALIDITY is the server saying both names address the same UID
  // space, and while one of the two has stopped being synced it is the ONLY
  // evidence that stays current — a mailbox nobody selects never refreshes its
  // message count. Demanding the counts agree as well deadlocks precisely the
  // case this rule exists for: the empty name wins the role, so it is the only
  // one the app syncs, so the name holding the mail keeps a frozen count, so
  // the two are never recognised as one, so the empty name keeps winning.
  // Counts remain the fallback for servers that report no UIDVALIDITY.
  if (a.uidValidity && b.uidValidity) return a.uidValidity === b.uidValidity;
  if (!a.serverMessageCount || !b.serverMessageCount) return false;
  return a.serverMessageCount === b.serverMessageCount;
}

/**
 * Best match for a standard type; equally-strong candidates keep list order.
 *
 * Except among names the server proves are ONE mailbox, where the folder
 * holding the local mail wins however weakly it matches. Mail is filed under
 * the name it was first synced from and is never inserted twice, so the other
 * name stays empty forever — showing it hands the user an empty folder under a
 * server-sized count. Mirrors core's findFolderByType; the two must agree, or
 * the sidebar lists a folder the sync engine isn't filling.
 */
export function findFolderByType<F extends ClassifiableFolder>(folders: F[], type: StandardFolderType): F | null {
  let best: F | null = null;
  let bestStrength = Number.POSITIVE_INFINITY;
  for (const folder of folders) {
    const strength = folderTypeMatchStrength(folder, type);
    if (strength !== null && strength < bestStrength) {
      best = folder;
      bestStrength = strength;
    }
  }
  if (!best) return null;

  let winner = best;
  for (const folder of folders) {
    if (folder === best) continue;
    if (folderTypeMatchStrength(folder, type) === null) continue;
    if (!looksLikeSameMailbox(folder, best)) continue;
    if (localRowCount(folder) > localRowCount(winner)) winner = folder;
  }
  return winner;
}

export const isInboxFolder   = (f: ClassifiableFolder) => classifyFolder(f) === 'inbox';
export const isSentFolder    = (f: ClassifiableFolder) => classifyFolder(f) === 'sent';
export const isDraftsFolder  = (f: ClassifiableFolder) => classifyFolder(f) === 'drafts';
export const isTrashFolder   = (f: ClassifiableFolder) => classifyFolder(f) === 'trash';
export const isSpamFolder    = (f: ClassifiableFolder) => classifyFolder(f) === 'spam';
export const isArchiveFolder = (f: ClassifiableFolder) => classifyFolder(f) === 'archive';

/**
 * Canonical sidebar labels for the standard folder roles, so a mailbox shows
 * under its role's name rather than whatever the server calls it: "Sent" for
 * Gmail's "[Gmail]/Sent Mail", and "Inbox" for the inbox — IMAP reserves the
 * literal name `INBOX` (RFC 3501 §5.1), so every server returns it in caps and
 * the raw name shouted in a list of normally-cased folders.
 */
const STANDARD_FOLDER_LABELS: Partial<Record<StandardFolderType, string>> = {
  inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', spam: 'Spam', trash: 'Trash',
};

/**
 * What to show the user for a folder: its role's canonical label when it has
 * one, otherwise the server's own name minus Gmail's "[Gmail]/" prefix.
 */
export function folderDisplayName(folder: ClassifiableFolder & { name: string }): string {
  const type = classifyFolder(folder);
  return (type && STANDARD_FOLDER_LABELS[type]) || folder.name.replace('[Gmail]/', '');
}

/**
 * Provider folder patterns to hide from UI
 * These folders are synced but not shown in sidebar
 */
export const HIDDEN_PROVIDER_FOLDERS: string[] = [
  // Gmail
  '[Gmail]/All Mail',
  '[Gmail]/Important',
  '[Gmail]/Starred',

  // Outlook
  'Archive',

  // Generic patterns (case-insensitive matching)
  'All Mail',
  'Important',
];

/**
 * Our own AI-category labels are mirrored to the server under the "Sarv Inbox"
 * parent (SARV_LABEL_PARENT in core — kept as a browser-safe local copy here,
 * like the rest of this config). They're surfaced at the TOP of the app as AI
 * categories, so we hide the mirrored server folders from the sidebar's FOLDERS
 * list — only the user's real folders and user-created labels belong there.
 * Matches the parent itself and anything nested under it (any delimiter).
 */
export const AI_LABEL_PARENT = 'Sarv Inbox';
export function isAiLabelFolder(path: string): boolean {
  return path === AI_LABEL_PARENT || /^Sarv Inbox[\\/.]/.test(path);
}

/**
 * Virtual folder definitions
 * These are computed locally, not from IMAP
 */
export interface VirtualFolder {
  id: string;
  name: string;
  icon: string;
  type: 'all' | 'important' | 'starred' | 'unread' | 'ai-category';
  query?: {
    aiCategory?: string;
    tags?: string[];
    isUnread?: boolean;
  };
  priority: number;
}

export const VIRTUAL_FOLDERS: VirtualFolder[] = [
  {
    id: 'virtual-all',
    name: 'All Email',
    icon: 'mail',
    type: 'all',
    priority: 1,
  },
  {
    id: 'virtual-important',
    name: 'Important',
    icon: 'alert-circle',
    type: 'important',
    query: {
      aiCategory: 'is_important',
    },
    priority: 2,
  },
  {
    id: 'virtual-starred',
    name: 'Starred',
    icon: 'star',
    type: 'starred',
    query: {
      tags: ['starred'],
    },
    priority: 3,
  },
];

/**
 * Check if a folder path should be hidden from UI
 */
export function shouldHideFolder(folderPath: string): boolean {
  const lowerPath = folderPath.toLowerCase();

  return HIDDEN_PROVIDER_FOLDERS.some(pattern => {
    const lowerPattern = pattern.toLowerCase();
    return lowerPath === lowerPattern || lowerPath.endsWith('/' + lowerPattern);
  });
}
