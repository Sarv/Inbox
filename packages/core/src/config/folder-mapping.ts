// Folder Mapping Configuration
// Maps provider folders to virtual folders and controls visibility

/**
 * Provider folder patterns to hide from UI
 * These folders are synced but not shown in sidebar
 */
export const HIDDEN_PROVIDER_FOLDERS: string[] = [
  // Gmail
  '[Gmail]/All Mail',
  '[Gmail]/Important',
  '[Gmail]/Starred', // We use local starred based on flags

  // Outlook
  'Archive',

  // Generic patterns (case-insensitive matching)
  'All Mail',
  'Important',
];

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
    flags?: string[];
    isUnread?: boolean;
  };
  priority: number; // Lower = higher in sidebar
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
      flags: ['\\Flagged'],
    },
    priority: 3,
  },
];

/**
 * Standard folder types — provider-agnostic identifiers used throughout the
 * app. Resolution order for any given folder:
 *   1. IMAP SPECIAL-USE attribute (RFC 6154) — the authoritative source when
 *      the server advertises it (Gmail, most modern IMAP servers, Outlook).
 *   2. Exact path match against STANDARD_FOLDER_MAP.
 *   3. Name-based substring heuristic (last resort, case-insensitive).
 */
export type StandardFolderType =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'archive'
  | 'starred'
  | 'important';

/**
 * IMAP \special-use attribute → StandardFolderType
 * (RFC 6154 — advertised by Gmail, Outlook/Exchange, iCloud, Fastmail, etc.)
 */
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

/**
 * Standard folder mappings (provider folder path -> standard type).
 * Used as the fallback when SPECIAL-USE isn't advertised.
 */
export const STANDARD_FOLDER_MAP: Record<StandardFolderType, string[]> = {
  inbox: ['INBOX', 'Inbox'],
  sent: [
    // Gmail
    '[Gmail]/Sent Mail',
    // Outlook / Exchange
    'Sent Items',
    // iCloud
    'Sent Messages',
    // Yahoo / generic
    'Sent',
  ],
  drafts: [
    '[Gmail]/Drafts',
    'Drafts',
    'Draft',
  ],
  trash: [
    '[Gmail]/Trash',
    '[Gmail]/Bin',
    'Deleted Items',  // Outlook
    'Deleted Messages', // iCloud
    'Trash',
    'Deleted',
  ],
  spam: [
    '[Gmail]/Spam',
    'Junk E-mail',  // Outlook
    'Junk Email',
    'Bulk Mail',    // Yahoo
    'Spam',
    'Junk',
  ],
  archive: [
    '[Gmail]/All Mail',
    'Archive',
    'All Mail',
    'Archives',
  ],
  starred: [
    '[Gmail]/Starred',
    'Starred',
    'Flagged',
  ],
  important: [
    '[Gmail]/Important',
    'Important',
  ],
};

/**
 * Name-based substring hints (case-insensitive, last-part-of-path).
 * Kept conservative so we don't false-match ("Archive-2024" etc.).
 */
const NAME_HEURISTICS: Array<{ type: StandardFolderType; test: (lc: string) => boolean }> = [
  { type: 'drafts',   test: (n) => n === 'drafts' || n === 'draft' },
  { type: 'sent',     test: (n) => n === 'sent' || n === 'sent mail' || n === 'sent items' || n === 'sent messages' },
  { type: 'trash',    test: (n) => n === 'trash' || n === 'bin' || n === 'deleted' || n === 'deleted items' || n === 'deleted messages' },
  { type: 'spam',     test: (n) => n === 'spam' || n === 'junk' || n === 'junk email' || n === 'junk e-mail' || n === 'bulk mail' },
  { type: 'archive',  test: (n) => n === 'archive' || n === 'archives' || n === 'all mail' },
  { type: 'starred',  test: (n) => n === 'starred' || n === 'flagged' },
  { type: 'important',test: (n) => n === 'important' },
  { type: 'inbox',    test: (n) => n === 'inbox' },
];

/**
 * Minimum shape a folder needs to be classified — matches both `FolderRecord`
 * (DB shape) and `IMAPFolder` (wire shape).
 */
export interface ClassifiableFolder {
  path: string;
  name?: string;
  specialUse?: string | null;
  // Optional sync state, present on a stored FolderRecord and absent on a bare
  // LIST entry. Only used to tell two names for ONE mailbox apart from two
  // genuinely different ones — see isSamePhysicalMailbox.
  uidValidity?: number | null;
  /**
   * Local rows carrying this folder as a membership TAG (folders.total_count).
   * NOT a count of mail filed here: a message that belongs to two folders —
   * including two names for the same one — is tagged with both, so this counts
   * the same message under every name it appears in.
   */
  totalCount?: number | null;
  /**
   * Rows whose PRIMARY folder is this one (`emails.folder_id`) — the mail
   * actually FILED under this name, counted once. This is the only count that
   * separates two names for one store: dedup keeps one row and adds the second
   * name as a tag, so `totalCount` reads ~1,718 for BOTH names of a Sent
   * mailbox while the filed count reads 1,718 and 1. Attached for contested
   * roles only (it costs a query per folder); absent means "not measured", and
   * the tag count is used instead.
   */
  ownedCount?: number | null;
  /** What the server last reported this mailbox holds (EXISTS). */
  serverMessageCount?: number | null;
}

/**
 * Resolve a folder to a standard type using the three-tier strategy:
 * special-use → exact path → name heuristic.
 */
export function classifyFolder(folder: ClassifiableFolder): StandardFolderType | null {
  // 1. SPECIAL-USE (authoritative)
  if (folder.specialUse) {
    const type = SPECIAL_USE_TO_TYPE[folder.specialUse];
    if (type) return type;
  }
  // 2. Exact path match
  for (const [type, paths] of Object.entries(STANDARD_FOLDER_MAP)) {
    if (paths.some(p => p === folder.path)) return type as StandardFolderType;
  }
  // 3. Name heuristic on the last path segment
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
 * when it isn't that type at all. This is `classifyFolder`'s three-tier
 * strategy made comparable, so that a provider exposing TWO mailboxes for one
 * role can be resolved to the right one instead of to whichever the server
 * happened to list first:
 *
 *   0            SPECIAL-USE (RFC 6154) — the server said so, it is authoritative
 *   1 + i        an exact path the provider is known to use, `i` being its
 *                position in STANDARD_FOLDER_MAP[type] (that list is ordered
 *                by preference)
 *   last         a name that merely looks the part — the weakest signal
 *
 * Sarv's IMAP server lists both `Sent` (the real mailbox) and an alias
 * `Sent Mail`; only the former is a known path, so only the former can win.
 */
export function folderTypeMatchStrength(
  folder: ClassifiableFolder,
  type: StandardFolderType,
): number | null {
  // One rule for "is this folder of this type", shared with classifyFolder —
  // the ranking may order candidates, never widen or narrow the set.
  if (classifyFolder(folder) !== type) return null;
  if (folder.specialUse && SPECIAL_USE_TO_TYPE[folder.specialUse] === type) return 0;
  const knownPaths = STANDARD_FOLDER_MAP[type] ?? [];
  const knownIndex = knownPaths.indexOf(folder.path);
  return knownIndex >= 0 ? 1 + knownIndex : 1 + knownPaths.length;
}

const localRowCount = (folder: ClassifiableFolder): number =>
  folder.ownedCount ?? folder.totalCount ?? 0;

/**
 * A folder is FULL when it holds essentially everything the server says that
 * mailbox contains. Measured against its OWN server count, so a small mailbox
 * and a huge one are judged the same way.
 */
const POPULATED_FRACTION = 0.9;

const isFullyPopulated = (folder: ClassifiableFolder): boolean =>
  !!folder.serverMessageCount &&
  localRowCount(folder) >= folder.serverMessageCount * POPULATED_FRACTION;

/**
 * The rail that survives a lying server: two names that are EACH full are two
 * different mailboxes, whatever the server reports about UIDVALIDITY or counts.
 *
 * One physical store can only be filed under one name — dedup keeps a single
 * row and adds the other name as a tag — so of two names for one mailbox,
 * exactly one is full and the other is starved (the live case: `Sent` holds
 * 1,718 of its 1,713, `Sent Mail` holds 1 of its 1,718). Two names that have
 * each been filled to their own server count therefore hold DIFFERENT mail, and
 * must never be merged in the sidebar or, worse, one of them dropped from sync.
 * That is what keeps a real `Sent` and a real `Sent Items` apart even on a
 * server that hands every mailbox the same UIDVALIDITY.
 */
const bothHoldTheirOwnMail = (a: ClassifiableFolder, b: ClassifiableFolder): boolean =>
  isFullyPopulated(a) && isFullyPopulated(b);

/**
 * Two names for one store are SELECTed at different moments, so their stored
 * EXISTS are two snapshots of one mailbox and rarely match to the message (the
 * live account: 1,713 and 1,718). Demanding equality reads that drift as proof
 * of two mailboxes; this allows the drift a real pair of distinct mailboxes
 * could not plausibly fit inside.
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
 *
 * Names cannot answer this — a folder the user made and called `Sent` looks
 * exactly like a server alias — but the SERVER can: UIDVALIDITY identifies a
 * mailbox, and two names for one store report the same message count (give or
 * take the drift between two SELECTs — see serverCountsAgree). Both signals
 * come from a SELECT, so this is `false` until each has been synced at least
 * once, which is the safe direction: unsure means "different mailboxes", and
 * different mailboxes are never merged. Local filing overrides both: two names
 * each holding their own mail are never one store.
 */
export function isSamePhysicalMailbox(
  a: ClassifiableFolder,
  b: ClassifiableFolder,
): boolean {
  if (bothHoldTheirOwnMail(a, b)) return false;
  if (!a.uidValidity || !b.uidValidity) return false;
  if (a.uidValidity !== b.uidValidity) return false;
  return serverCountsAgree(a, b);
}

/**
 * The weaker question: do these two LOOK like one mailbox? Same role, same
 * message count on the server, and no UIDVALIDITY saying otherwise.
 *
 * Weaker on purpose, because it decides only which of the two to SHOW — a
 * display preference, where being wrong shows the fuller of two folders that
 * both remain in the list. {@link isSamePhysicalMailbox} governs the decision
 * that can lose mail (dropping a mailbox from sync) and stays strict. The
 * split matters for a server that does not report UIDVALIDITY: the reader still
 * gets the folder their mail is in, and nothing stops being synced.
 */
function looksLikeSameMailbox(a: ClassifiableFolder, b: ClassifiableFolder): boolean {
  // Both names filled to their own server count settles it before any server
  // claim about UIDVALIDITY is consulted.
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
 * Find the folder that best matches a standard type. Ranked by
 * {@link folderTypeMatchStrength}; equally-strong candidates keep list order.
 *
 * With ONE exception, which is the whole point: when the winner and another
 * candidate are provably the SAME mailbox (isSamePhysicalMailbox), the one
 * already holding the local mail wins. Mail is filed under the folder name it
 * was first synced from, and a message already on disk is not inserted again —
 * so the OTHER name can never accumulate a single row. Picking the "better"
 * name in that state hands the user an empty folder under a server-sized count,
 * which is exactly what Sarv did: it flags `Sent Mail` with SPECIAL-USE while
 * every one of the account's 1,713 sent messages is filed under `Sent`.
 *
 * Choosing between two names for one store is arbitrary; choosing the one the
 * mail is under is not. It is also stable — the winner keeps receiving the
 * mail, so it keeps winning — and it decides nothing on a fresh account, where
 * both are empty and the ranking alone picks.
 */
export function findFolderByType(
  folders: ClassifiableFolder[],
  type: StandardFolderType,
): ClassifiableFolder | null {
  let best: ClassifiableFolder | null = null;
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

/**
 * The roles a mail server has exactly ONE physical mailbox for. `archive` is
 * deliberately absent: Gmail's `[Gmail]/All Mail` and a user's own `Archive`
 * both classify as archive and are genuinely different mailboxes, so collapsing
 * them would merge two real folders into one.
 */
const COLLAPSIBLE_FOLDER_TYPES: StandardFolderType[] = ['sent', 'drafts', 'trash', 'spam'];

/**
 * Could the SERVER have published this mailbox, or did the user make it?
 * A top-level mailbox, or one at a path a provider is known to use, may be a
 * server alias. Anything nested (`Archive/Sent`, `Clients/Drafts`) is the
 * user's own folder and must never be folded into an account-level role —
 * that would hide real mail behind a name it does not belong to.
 */
function isServerLevelMailbox(folder: ClassifiableFolder, type: StandardFolderType): boolean {
  if ((STANDARD_FOLDER_MAP[type] ?? []).includes(folder.path)) return true;
  return !folder.path.includes('/');
}

/**
 * Map every DUPLICATE standard mailbox to the one the app actually uses:
 * `alias path -> canonical path`. Empty for the normal account that has one
 * mailbox per role.
 *
 * A server can publish two names for a single physical store — Sarv lists both
 * `Sent` and `Sent Mail`, same UID range, same messages. Treated as two folders
 * they each get their own sync state and counts, while the sidebar (which
 * collapses a role to one folder via {@link findFolderByType}) shows only one of
 * them: the other accumulates state nothing can display, which is how a Sent
 * folder ended up claiming 1,719 messages and showing one.
 *
 * Only {@link COLLAPSIBLE_FOLDER_TYPES} are collapsed, only across
 * {@link isServerLevelMailbox} candidates, and only where the SERVER proves the
 * two names are one store ({@link isSamePhysicalMailbox}). A shared name is not
 * evidence: an account can genuinely have both a `Sent` and a `Sent Items`
 * holding different mail, and skipping one of those stops mail from arriving.
 * The proof needs sync state, so a mailbox pair collapses only from the sync
 * AFTER both have been selected once — until then both sync, which costs a
 * little work and loses nothing.
 */
export function buildStandardFolderAliasMap(
  folders: ClassifiableFolder[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const type of COLLAPSIBLE_FOLDER_TYPES) {
    const canonical = findFolderByType(folders, type);
    if (!canonical) continue;
    for (const folder of folders) {
      if (folder.path === canonical.path) continue;
      if (classifyFolder(folder) !== type) continue;
      if (!isServerLevelMailbox(folder, type)) continue;
      if (!isSamePhysicalMailbox(folder, canonical)) continue;
      aliases.set(folder.path, canonical.path);
    }
  }
  return aliases;
}

/**
 * The roles this account publishes more than one server-level mailbox for,
 * with every candidate — for diagnosing a collapse that did NOT happen.
 *
 * Whether two names are one store is decided from sync state the folder list
 * does not carry, so "nothing was collapsed" has several very different causes:
 * the server withheld UIDVALIDITY, one mailbox has never been selected, or they
 * genuinely are two mailboxes. Printing the candidates tells them apart; the
 * alternative is guessing, which is how the wrong mailbox got picked twice.
 */
export function duplicateRoleCandidates(
  folders: ClassifiableFolder[],
): Array<{ type: StandardFolderType; candidates: ClassifiableFolder[] }> {
  const groups: Array<{ type: StandardFolderType; candidates: ClassifiableFolder[] }> = [];
  for (const type of COLLAPSIBLE_FOLDER_TYPES) {
    const candidates = folders.filter(
      (folder) => classifyFolder(folder) === type && isServerLevelMailbox(folder, type),
    );
    if (candidates.length > 1) groups.push({ type, candidates });
  }
  return groups;
}

/** One folder's sync state, for a log line: `Sent (uidValidity=…, local=…)`. */
export function describeFolderSyncState(folder: ClassifiableFolder): string {
  const parts = [
    `uidValidity=${folder.uidValidity ?? 'none'}`,
    // `tagged` and `filed` are different questions and the whole diagnosis
    // turns on the gap between them: an aliased mailbox reads the full store
    // under both names when tagged, and 1 vs 1,718 when filed.
    `tagged=${folder.totalCount ?? 0}`,
    `filed=${folder.ownedCount ?? 'unmeasured'}`,
    `server=${folder.serverMessageCount ?? 'unknown'}`,
  ];
  if (folder.specialUse) parts.push(`specialUse=${folder.specialUse}`);
  return `${folder.path} (${parts.join(', ')})`;
}

/**
 * Every role this account publishes more than one mailbox for, each candidate's
 * sync state, and which one wins — or `null` when no role is duplicated.
 *
 * The one line that makes this class of bug diagnosable from a log instead of a
 * guess. Which mailbox a role resolves to used to be invisible, and it was
 * wrong twice: the folder the mail was in stopped syncing, and the empty one
 * was shown under a count borrowed from its twin.
 */
export function describeDuplicateRoles(folders: ClassifiableFolder[]): string | null {
  const groups = duplicateRoleCandidates(folders);
  if (groups.length === 0) return null;
  return groups
    .map(({ type, candidates }) => {
      const chosen = findFolderByType(folders, type);
      return (
        `${type}: ${candidates.map(describeFolderSyncState).join(' | ')}` +
        ` -> ${chosen ? chosen.path : 'none'}`
      );
    })
    .join('; ');
}

export const isInboxFolder   = (f: ClassifiableFolder) => classifyFolder(f) === 'inbox';
export const isSentFolder    = (f: ClassifiableFolder) => classifyFolder(f) === 'sent';
export const isDraftsFolder  = (f: ClassifiableFolder) => classifyFolder(f) === 'drafts';
export const isTrashFolder   = (f: ClassifiableFolder) => classifyFolder(f) === 'trash';
export const isSpamFolder    = (f: ClassifiableFolder) => classifyFolder(f) === 'spam';
export const isArchiveFolder = (f: ClassifiableFolder) => classifyFolder(f) === 'archive';

/**
 * True for an RFC-6154 `\All` "all messages" folder — Gmail's `[Gmail]/All Mail`.
 * This is a SUPERSET: every non-Spam/Trash message lives there regardless of
 * label, so a single pass over it gives complete coverage. Distinct from the
 * DISJOINT `\Archive` folder (a plain archive), which `isArchiveFolder` also
 * matches — this checks the `\All` special-use specifically (with a Gmail path
 * fallback for servers that don't advertise SPECIAL-USE). Used by the historical
 * backfill to avoid re-downloading each message once per label it carries.
 */
export const isAllMailSuperset = (f: ClassifiableFolder): boolean => {
  if ((f.specialUse ?? '').toLowerCase() === '\\all') return true;
  return /(^|\/)(\[gmail\]\/)?all mail$/i.test(f.path ?? '');
};

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

/**
 * Get the standard folder type for a provider folder by path.
 * Thin wrapper around classifyFolder — prefer classifyFolder/findFolderByType
 * when you have the full folder record (they can consult special_use).
 */
export function getStandardFolderType(folderPath: string): string | null {
  return classifyFolder({ path: folderPath });
}

/**
 * Get display name for a folder (cleaned up)
 */
export function getFolderDisplayName(folderPath: string): string {
  // Remove [Gmail]/ prefix
  let name = folderPath.replace(/^\[Gmail\]\//i, '');

  // Get last part of path
  const parts = name.split('/');
  name = parts[parts.length - 1];

  return name;
}

/**
 * Folder visibility and ordering configuration
 */
export interface FolderConfig {
  // Folders to always show at top (in order)
  pinnedFolders: string[];

  // Folders to hide from sidebar
  hiddenFolders: string[];

  // Virtual folders to show
  virtualFolders: VirtualFolder[];
}

export const DEFAULT_FOLDER_CONFIG: FolderConfig = {
  pinnedFolders: ['INBOX'],
  hiddenFolders: HIDDEN_PROVIDER_FOLDERS,
  virtualFolders: VIRTUAL_FOLDERS,
};
