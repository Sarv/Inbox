import { parseTags } from './tags';

export interface SpamFolderMetadata {
  path?: string | null;
  type?: string | null;
  specialUse?: string | string[] | null;
}

const SPAM_PATHS = new Set(['spam', 'junk', 'junk mail', 'junk email', 'bulk mail', '[gmail]/spam', '[googlemail]/spam']);
const SPAM_FLAGS = new Set(['\\junk', '\\spam']);
const OTHER_SYSTEM_FLAGS = new Set(['\\inbox', '\\sent', '\\draft', '\\drafts', '\\trash', '\\all', '\\archive']);
const OTHER_SYSTEM_TYPES = new Set(['inbox', 'sent', 'drafts', 'trash', 'archive']);

function isProviderSpamFolder(folder: SpamFolderMetadata): boolean {
  const flags = (Array.isArray(folder.specialUse) ? folder.specialUse : (folder.specialUse ?? '').split(/\s+/)).map((flag) => flag.trim().toLowerCase());
  if (flags.some((flag) => SPAM_FLAGS.has(flag))) return true;
  if (flags.some((flag) => OTHER_SYSTEM_FLAGS.has(flag))) return false;
  const type = folder.type?.trim().toLowerCase() ?? '';
  if (type === 'spam' || type === 'junk') return true;
  if (OTHER_SYSTEM_TYPES.has(type)) return false;
  return SPAM_PATHS.has(folder.path?.trim().toLowerCase() ?? '');
}

/** Provider Spam/Junk remains protected until moved out; explicit ham overrides only local filter tags. */
export function isSpamProtectedEmail(
  email: { tags?: string | null; spamUserVerdict?: 'spam' | 'ham' | null },
  folder?: SpamFolderMetadata | string | null,
  folders?: readonly SpamFolderMetadata[],
): boolean {
  const metadata = typeof folder === 'string' ? { path: folder, type: folder } : folder;
  const tags = parseTags(email.tags ?? '');
  const membership = new Set(tags);
  if (metadata && isProviderSpamFolder(metadata)) return true;
  if (folders?.some((linked) => !!linked.path && membership.has(linked.path) && isProviderSpamFolder(linked))) return true;
  // Lowercase `spam` is the local filter/category tag. Named Spam/Junk
  // mailboxes and system labels are provider membership, even with ham set.
  if (tags.some((tag) => SPAM_FLAGS.has(tag.toLowerCase()) || (tag !== 'spam' && SPAM_PATHS.has(tag.toLowerCase())))) return true;
  if (email.spamUserVerdict === 'spam') return true;
  if (email.spamUserVerdict === 'ham') return false;
  return tags.includes('spam');
}
