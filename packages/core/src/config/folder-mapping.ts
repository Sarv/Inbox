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
 * Find a folder of a given type from a list. Returns the first match, with
 * SPECIAL-USE results preferred over path/name-based ones.
 */
export function findFolderByType(
  folders: ClassifiableFolder[],
  type: StandardFolderType,
): ClassifiableFolder | null {
  // Pass 1: SPECIAL-USE match
  for (const f of folders) {
    if (f.specialUse && SPECIAL_USE_TO_TYPE[f.specialUse] === type) return f;
  }
  // Pass 2: path/name match
  for (const f of folders) {
    if (classifyFolder(f) === type) return f;
  }
  return null;
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
