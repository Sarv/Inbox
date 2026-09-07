// Unified tag-string helpers. Tags are stored as a `|a|b|c|` string and queried
// with `instr(tags, '|tag|')` (zero JOINs). Single source of truth — previously
// these were copied verbatim across email-repository, message-processor,
// realtime-manager and folder-repository.

/** IMAP system flags mapped to our lowercase tag names. */
export const FLAG_TAG_NAMES = ['read', 'starred', 'answered', 'draft', 'deleted'] as const;

const FLAG_TO_TAG: Record<string, string> = {
  '\\Seen': 'read',
  '\\Flagged': 'starred',
  '\\Answered': 'answered',
  '\\Draft': 'draft',
  '\\Deleted': 'deleted',
};

const TAG_TO_FLAG: Record<string, string> = {
  read: '\\Seen',
  starred: '\\Flagged',
  answered: '\\Answered',
  draft: '\\Draft',
  deleted: '\\Deleted',
};

/** The one character that may never appear INSIDE a tag name. */
const TAG_DELIMITER = '|';

/**
 * Make a tag name safe to store in the `|a|b|` encoding by replacing every
 * delimiter with `_`.
 *
 * Without this, a tag name that itself contains a `|` — a Gmail label, a
 * user-typed filter `applyLabel` value, a folder path — silently corrupts the
 * encoding: `addTag('||', 'a|b')` produced `|a|b|`, byte-identical to the two
 * tags `a` and `b`, so `hasTag(tags, 'a')` (and the equivalent SQL
 * `instr(tags, '|a|')`) then answered true for a message that was never tagged
 * `a`.
 *
 * SANITISE rather than THROW: this runs in the per-message sync hot path, where
 * an exception over one oddly-named label would abort the whole folder's sync.
 * Sanitising also cannot corrupt anything already stored — it rewrites no
 * existing tag string, and because it is applied identically on write and on
 * read (hasTag/addTag/removeTag all normalise their argument), a tag stored
 * under its sanitised name is still found by a lookup with the raw name.
 *
 * `_` and not `/`: `/` is the folder-hierarchy separator, so it would let a
 * label masquerade as a folder path tag.
 */
export function sanitizeTagName(tag: string): string {
  return (tag || '').split(TAG_DELIMITER).join('_');
}

/** Build a tags string from an array of tag names. */
export function buildTags(tagList: string[]): string {
  // Empty names are dropped too: they would emit a `||` run, which matches every
  // `instr(tags, '|x|')` probe against the sentinel.
  const safeList = tagList.map(sanitizeTagName).filter((tag) => tag.length > 0);
  if (safeList.length === 0) return '||';
  return `${TAG_DELIMITER}${safeList.join(TAG_DELIMITER)}${TAG_DELIMITER}`;
}

/** Parse a tags string into an array of tag names. */
export function parseTags(tags: string): string[] {
  if (!tags || tags === '||') return [];
  return tags.split(TAG_DELIMITER).filter((t) => t.length > 0);
}

/** Check if a tags string contains a specific tag. */
export function hasTag(tags: string, tag: string): boolean {
  const safeTag = sanitizeTagName(tag);
  if (!safeTag) return false;
  return (tags || '').includes(`${TAG_DELIMITER}${safeTag}${TAG_DELIMITER}`);
}

/** Add a tag to a tags string (idempotent). */
export function addTag(tags: string, tag: string): string {
  const safeTag = sanitizeTagName(tag);
  if (!safeTag || hasTag(tags, safeTag)) return tags;
  return buildTags([...parseTags(tags), safeTag]);
}

/** Remove a tag from a tags string. */
export function removeTag(tags: string, tag: string): string {
  const safeTag = sanitizeTagName(tag);
  return buildTags(parseTags(tags).filter((t) => t !== safeTag));
}

/** Convert IMAP flags to our tag names (unknown custom `\Flags` kept lowercased). */
export function imapFlagsToTags(flags: string[]): string[] {
  const tags: string[] = [];
  for (const flag of flags) {
    const mapped = FLAG_TO_TAG[flag];
    if (mapped) tags.push(mapped);
    else if (flag.startsWith('\\')) tags.push(flag.slice(1).toLowerCase());
  }
  return tags;
}

/** Convert our tag names back to IMAP flags (folder/category tags are skipped). */
export function tagsToImapFlags(tags: string[]): string[] {
  const flags: string[] = [];
  for (const tag of tags) {
    const flag = TAG_TO_FLAG[tag];
    if (flag) flags.push(flag);
  }
  return flags;
}
