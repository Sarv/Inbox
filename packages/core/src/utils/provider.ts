/**
 * Email Provider Detection and Configuration
 *
 * This module provides utilities for detecting email providers and
 * understanding their capabilities for multi-provider support.
 */

export type EmailProvider = 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'generic';

/**
 * Provider-specific folder paths
 */
export interface ProviderFolderPaths {
  important?: string;    // Gmail: [Gmail]/Important, Outlook: null
  starred?: string;      // Gmail: [Gmail]/Starred, Others: use \Flagged flag
  allMail?: string;      // Gmail: [Gmail]/All Mail, Others: null
  spam?: string;         // Gmail: [Gmail]/Spam, Outlook: Junk
  trash?: string;        // Gmail: [Gmail]/Trash, Outlook: Deleted Items
  sent?: string;         // Gmail: [Gmail]/Sent Mail, Outlook: Sent Items
  drafts?: string;       // Gmail: [Gmail]/Drafts, Outlook: Drafts
}

/**
 * Provider capabilities
 */
export interface ProviderCapabilities {
  hasImportantFolder: boolean;     // Gmail has dedicated Important folder
  hasStarredFolder: boolean;       // Gmail has dedicated Starred folder
  hasAllMailFolder: boolean;       // Gmail has All Mail folder
  hasFocusedInbox: boolean;        // Outlook has Focused/Other inbox
  supportsLabels: boolean;         // Gmail supports labels (folders as tags)
  supportsCategories: boolean;     // Gmail has categories (Primary, Social, etc.)
  flaggedAsStarred: boolean;       // \Flagged flag means starred
}

/**
 * Complete provider configuration
 */
export interface ProviderConfig {
  provider: EmailProvider;
  capabilities: ProviderCapabilities;
  folderPaths: ProviderFolderPaths;
}

/**
 * Host patterns per provider, in match order. Two shapes, both boundary-anchored:
 *
 * - a DOMAIN (contains a dot, e.g. `live.com`) matches the host itself or any
 *   SUBDOMAIN of it.
 * - a LABEL (no dot, e.g. `gmail`) matches a whole dot-separated host label, so
 *   `imap.gmail.com` and `imap-mail.outlook.com` match but `imap.gmailish.com`
 *   does not.
 *
 * This used to be a bare `host.includes(pattern)`, which mis-detected
 * self-hosted hosts: `imap.acme.com` became 'icloud' (via `me.com`) and
 * `mail.olive.com` became 'outlook' (via `live.com`) — handing those accounts
 * another provider's special-folder paths and hidden-folder list.
 *
 * Deliberately hand-rolled instead of using a public-suffix library: these are
 * exact, known domains (no eTLD+1 inference needed), and `tldts` is a
 * desktop-app dependency — core must stay importable without it.
 */
const PROVIDER_HOST_PATTERNS: ReadonlyArray<readonly [EmailProvider, readonly string[]]> = [
  ['gmail', ['gmail', 'googlemail', 'google.com']],
  ['outlook', ['outlook', 'office365', 'hotmail', 'live.com']],
  ['yahoo', ['yahoo', 'ymail']],
  ['icloud', ['icloud', 'me.com', 'mac.com']],
];

/** Lowercased, whitespace-trimmed host labels (empty labels dropped, so a
 * leading/trailing/doubled dot cannot change the outcome). */
function hostLabels(host: string): string[] {
  return (host || '')
    .trim()
    .toLowerCase()
    .split('.')
    .filter((label) => label.length > 0);
}

/** Whether `labels` (a split host) belongs to `pattern` — see PROVIDER_HOST_PATTERNS. */
function hostMatchesPattern(labels: string[], pattern: string): boolean {
  if (!pattern.includes('.')) return labels.includes(pattern);
  const host = labels.join('.');
  return host === pattern || host.endsWith(`.${pattern}`);
}

/**
 * Detect email provider from IMAP host
 */
export function detectProvider(host: string): EmailProvider {
  const labels = hostLabels(host);
  if (labels.length === 0) return 'generic';

  const match = PROVIDER_HOST_PATTERNS.find(([, patterns]) =>
    patterns.some((pattern) => hostMatchesPattern(labels, pattern)),
  );

  return match ? match[0] : 'generic';
}

/**
 * Whether a provider automatically files SMTP-submitted mail into its Sent
 * folder (so a client-side IMAP APPEND would create a DUPLICATE). Gmail is the
 * well-known one: mail sent through smtp.gmail.com is auto-saved to
 * "[Gmail]/Sent Mail". Generic IMAP/SMTP servers (sarv.com, most self-hosted
 * and hosting-provider mailboxes) do NOT — the client must APPEND the Sent copy
 * itself, else the sent message is lost off-device.
 *
 * When the provider is unknown we return FALSE (i.e. DO append): a missing Sent
 * copy is worse than a rare duplicate, and the append path dedupes by
 * Message-ID before uploading.
 */
export function providerAutoSavesSentCopy(host: string): boolean {
  return detectProvider(host) === 'gmail';
}

/**
 * Get provider configuration
 */
export function getProviderConfig(provider: EmailProvider): ProviderConfig {
  switch (provider) {
    case 'gmail':
      return {
        provider: 'gmail',
        capabilities: {
          hasImportantFolder: true,
          hasStarredFolder: true,
          hasAllMailFolder: true,
          hasFocusedInbox: false,
          supportsLabels: true,
          supportsCategories: true,
          flaggedAsStarred: true,
        },
        folderPaths: {
          important: '[Gmail]/Important',
          starred: '[Gmail]/Starred',
          allMail: '[Gmail]/All Mail',
          spam: '[Gmail]/Spam',
          trash: '[Gmail]/Trash',
          sent: '[Gmail]/Sent Mail',
          drafts: '[Gmail]/Drafts',
        },
      };

    case 'outlook':
      return {
        provider: 'outlook',
        capabilities: {
          hasImportantFolder: false,  // Outlook uses Focused Inbox instead
          hasStarredFolder: false,    // Uses \Flagged flag
          hasAllMailFolder: false,
          hasFocusedInbox: true,
          supportsLabels: false,
          supportsCategories: false,
          flaggedAsStarred: true,
        },
        folderPaths: {
          spam: 'Junk',
          trash: 'Deleted Items',
          sent: 'Sent Items',
          drafts: 'Drafts',
        },
      };

    case 'yahoo':
      return {
        provider: 'yahoo',
        capabilities: {
          hasImportantFolder: false,
          hasStarredFolder: false,
          hasAllMailFolder: false,
          hasFocusedInbox: false,
          supportsLabels: false,
          supportsCategories: false,
          flaggedAsStarred: true,
        },
        folderPaths: {
          spam: 'Bulk Mail',
          trash: 'Trash',
          sent: 'Sent',
          drafts: 'Draft',
        },
      };

    case 'icloud':
      return {
        provider: 'icloud',
        capabilities: {
          hasImportantFolder: false,
          hasStarredFolder: false,
          hasAllMailFolder: false,
          hasFocusedInbox: false,
          supportsLabels: false,
          supportsCategories: false,
          flaggedAsStarred: true,
        },
        folderPaths: {
          spam: 'Junk',
          trash: 'Deleted Messages',
          sent: 'Sent Messages',
          drafts: 'Drafts',
        },
      };

    default:
      return {
        provider: 'generic',
        capabilities: {
          hasImportantFolder: false,
          hasStarredFolder: false,
          hasAllMailFolder: false,
          hasFocusedInbox: false,
          supportsLabels: false,
          supportsCategories: false,
          flaggedAsStarred: true,
        },
        folderPaths: {
          spam: 'Spam',
          trash: 'Trash',
          sent: 'Sent',
          drafts: 'Drafts',
        },
      };
  }
}

/**
 * Check if a folder path is a provider's Important folder
 */
export function isProviderImportantFolder(folderPath: string, provider: EmailProvider): boolean {
  const config = getProviderConfig(provider);
  if (!config.capabilities.hasImportantFolder || !config.folderPaths.important) {
    return false;
  }
  return folderPath.toLowerCase() === config.folderPaths.important.toLowerCase();
}

/**
 * Check if a folder path is a provider's Starred folder
 */
export function isProviderStarredFolder(folderPath: string, provider: EmailProvider): boolean {
  const config = getProviderConfig(provider);
  if (!config.capabilities.hasStarredFolder || !config.folderPaths.starred) {
    return false;
  }
  return folderPath.toLowerCase() === config.folderPaths.starred.toLowerCase();
}

/**
 * Check if a folder path is a provider's All Mail folder
 */
export function isProviderAllMailFolder(folderPath: string, provider: EmailProvider): boolean {
  const config = getProviderConfig(provider);
  if (!config.capabilities.hasAllMailFolder || !config.folderPaths.allMail) {
    return false;
  }
  return folderPath.toLowerCase() === config.folderPaths.allMail.toLowerCase();
}

/**
 * Get list of provider folders that should be hidden from UI
 * (we use virtual folders instead)
 */
export function getHiddenProviderFolders(provider: EmailProvider): string[] {
  const config = getProviderConfig(provider);
  const hidden: string[] = [];

  if (config.folderPaths.important) hidden.push(config.folderPaths.important);
  if (config.folderPaths.starred) hidden.push(config.folderPaths.starred);
  if (config.folderPaths.allMail) hidden.push(config.folderPaths.allMail);

  return hidden;
}

/**
 * Importance source types
 */
export type ImportanceSource = 'none' | 'provider' | 'ai' | 'user' | 'rule';

// ========== Folder Normalization (Multi-Provider Support) ==========

/**
 * Normalized folder types (unified across all providers)
 */
export type NormalizedFolderType =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'archive'
  | 'important'
  | 'starred'
  | 'all_mail'
  | 'other';

/**
 * Provider folder patterns for normalization.
 *
 * A pattern must appear in exactly ONE list: the first matching type wins, so a
 * pattern listed twice makes the later type unreachable. `all mail` used to sit
 * in BOTH `archive` and `all_mail` (and `archive` in both too), which made
 * `all_mail` dead — `[Gmail]/All Mail` normalized to 'archive' and displayed as
 * "Archive". They are separate types on purpose (All Mail is Gmail's
 * everything-view, Archive is a real folder), even though both currently route
 * to the same `virtual-all` folder.
 */
const FOLDER_PATTERNS: Record<NormalizedFolderType, string[]> = {
  inbox: ['inbox'],
  sent: ['sent', 'sent mail', 'sent items', '[gmail]/sent mail', 'sent messages'],
  drafts: ['drafts', 'draft', '[gmail]/drafts'],
  trash: ['trash', 'deleted', 'deleted items', 'deleted messages', '[gmail]/trash', 'bin'],
  spam: ['spam', 'junk', 'junk mail', 'junk email', 'bulk mail', '[gmail]/spam'],
  archive: ['archive', 'archived'],
  important: ['important', '[gmail]/important', 'focused'], // Outlook's Focused Inbox
  starred: ['starred', '[gmail]/starred', 'flagged'],
  all_mail: ['all mail', '[gmail]/all mail'],
  other: [],
};

/**
 * Normalize folder path to a standard type
 */
export function normalizeFolderType(folderPath: string): NormalizedFolderType {
  const lowerPath = folderPath.toLowerCase();

  for (const [type, patterns] of Object.entries(FOLDER_PATTERNS)) {
    for (const pattern of patterns) {
      if (lowerPath === pattern || lowerPath.endsWith('/' + pattern)) {
        return type as NormalizedFolderType;
      }
    }
  }

  return 'other';
}

/**
 * Check if folder maps to a virtual folder
 */
export function mapToVirtualFolder(folderPath: string): string | null {
  const type = normalizeFolderType(folderPath);

  switch (type) {
    case 'important':
      return 'virtual-important';
    case 'starred':
      return 'virtual-starred';
    case 'all_mail':
    case 'archive':
      return 'virtual-all';
    default:
      return null;
  }
}

/**
 * Get display name for folder (normalized)
 */
export function getNormalizedFolderName(folderPath: string): string {
  const type = normalizeFolderType(folderPath);

  const displayNames: Record<NormalizedFolderType, string> = {
    inbox: 'Inbox',
    sent: 'Sent',
    drafts: 'Drafts',
    trash: 'Trash',
    spam: 'Spam',
    archive: 'Archive',
    important: 'Important',
    starred: 'Starred',
    all_mail: 'All Mail',
    other: folderPath.split('/').pop() || folderPath,
  };

  return displayNames[type];
}

/**
 * Check if folder should be synced to important flag
 * (emails in these folders should have is_important=1)
 */
export function isImportantSourceFolder(folderPath: string): boolean {
  const type = normalizeFolderType(folderPath);
  // Star is NOT important — they are separate tags
  return type === 'important';
}

/**
 * Check if folder should be synced to starred flag
 * (emails in these folders should have is_starred=1)
 */
export function isStarredSourceFolder(folderPath: string): boolean {
  const type = normalizeFolderType(folderPath);
  return type === 'starred';
}
