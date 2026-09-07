import type { SearchQuery } from '../services/ai-service';

/**
 * Live, client-side re-check of the STATE-based tokens of an active search
 * filter (`is:unread` / `is:read` / `is:starred`) against a row's CURRENT tags.
 *
 * The search list is a server/DB snapshot; optimistic actions (mark read,
 * unstar) mutate a row's tags in place but don't re-test membership, so a
 * mark-read row lingers under an `is:unread` filter. Running this predicate over
 * the snapshot drops such rows INSTANTLY on the next render — no IPC round-trip.
 *
 * Only the tokens whose truth an in-app action can flip are evaluated here
 * (read/unread, starred). Every other field (free text, from/to/subject,
 * attachments, labels, category, date, size) defines the SERVER query and can't
 * change from a user action, so it is passed through untouched — never filtered
 * client-side (that would wrongly hide rows the server already matched).
 */
export function emailMatchesLiveSearchFilter(
  email: { tags?: string | null },
  filter: SearchQuery,
): boolean {
  const tags = email.tags || '';
  const isRead = tags.includes('|read|');
  const isStarred = tags.includes('|starred|');

  if (filter.isUnread === true && isRead) return false;   // is:unread — dropped once read
  if (filter.isUnread === false && !isRead) return false; // is:read — dropped once marked unread
  if (filter.isFlagged === true && !isStarred) return false; // is:starred — dropped once unstarred

  return true;
}

/** True when a filter carries at least one live state token worth re-checking. */
export function hasLiveSearchFilterTokens(filter: SearchQuery | null | undefined): boolean {
  return !!filter && (filter.isUnread !== undefined || filter.isFlagged !== undefined);
}
