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

export function findFolderByType<F extends ClassifiableFolder>(folders: F[], type: StandardFolderType): F | null {
  for (const f of folders) {
    if (f.specialUse && SPECIAL_USE_TO_TYPE[f.specialUse] === type) return f;
  }
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
