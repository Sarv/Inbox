import { emailMatchesRule, type EmailRecord, type FilterCondition, type FilterRule } from '@sarvinbox/core';
import { cleanBodyExpression } from '@sarvinbox/storage-node';

/**
 * Which stored emails a filter rule matches: the "N matching emails" preview,
 * "apply to existing", and the Inbox Agent's own filters and sender blocks all
 * read the same scan, so they cannot disagree about what a rule covers.
 */

/** Newest first, so the most relevant mail is always covered on a huge mailbox. */
export const FILTER_SCAN_CAP = 5000;

/** The fields filter conditions read, for one stored email. */
export type FilterScanRow = Pick<EmailRecord, 'id' | 'folderId' | 'uid' | 'tags' | 'subject' | 'fromAddress' | 'fromName' | 'toAddress' | 'ccAddress' | 'cleanBody'>;

/** Newest-first slice of one account's stored emails. Empty when the store has no database. */
export function scanEmailsForFilter(storage: unknown): FilterScanRow[] {
  const db = (storage as { db?: { prepare?: (sql: string) => { all(): unknown[] } } }).db;
  if (!db?.prepare) return [];
  return db
    .prepare(`
      SELECT id, folder_id AS folderId, uid, tags, subject,
             from_address AS fromAddress, from_name AS fromName,
             to_address AS toAddress, cc_address AS ccAddress,
             -- Through email_bodies, never the inline column: migration 73 empties
             -- it, and a filter rule matching on body text would silently stop
             -- matching anything.
             ${cleanBodyExpression()} AS cleanBody
      FROM emails
      ORDER BY date DESC
      LIMIT ${FILTER_SCAN_CAP}
    `)
    .all() as FilterScanRow[];
}

/** An unsaved rule's conditions as a rule the matcher accepts. */
export function previewRule(input: { matchType: 'all' | 'any'; conditions: FilterCondition[] }): FilterRule {
  return {
    id: '', name: '', enabled: true, priority: 0,
    matchType: input.matchType, conditions: input.conditions, actions: [],
    stopProcessing: false, createdAt: 0, updatedAt: 0,
  };
}

/** The scanned emails a rule's conditions match, newest first. */
export function emailsMatchingRule(storage: unknown, input: { matchType: 'all' | 'any'; conditions: FilterCondition[] }): FilterScanRow[] {
  const rule = previewRule(input);
  return scanEmailsForFilter(storage).filter(email => emailMatchesRule(email as EmailRecord, rule));
}

/** The scanned emails from exactly this sender address (a filter's "from" also matches the display name). */
export function emailsFromSender(storage: unknown, address: string): FilterScanRow[] {
  const wanted = address.trim().toLowerCase();
  return scanEmailsForFilter(storage).filter(email => (email.fromAddress ?? '').trim().toLowerCase() === wanted);
}
