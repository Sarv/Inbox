// What an EMPTY list says — pure, so the wording is tested without rendering a
// list. Kept out of EmailList.tsx to keep the business logic separate from the
// framework code, same as list-header-view.ts beside it.

/** The states an empty list can be in, in the order they override one another. */
export interface EmptyListView {
  /**
   * Mail for this view is still resolving — the GLOBAL sync (`syncing`) as well
   * as this folder's own (`syncingFolders`). The global one matters most: a
   * brand-new account's first pass runs through `syncEmails`, which never
   * touches `syncingFolders`, so keying off that alone told a first-run user
   * "No emails in this folder" for the whole of their first sync.
   */
  syncing?: boolean;
  /** The folder has no `lastSyncTime` — it has never finished a sync. */
  neverSynced?: boolean;
  searching?: boolean;
  snoozed?: boolean;
  /** `viewingAICategory` slug, e.g. "needs-response". */
  aiCategory?: string | null;
}

/**
 * Which empty-state message an empty list should show.
 *
 * 'syncing' wins over every "nothing here" wording, and ONLY for a folder that
 * has never completed a sync: a folder that HAS synced and is empty is
 * genuinely empty, and saying "Syncing emails..." over it every time a
 * background pass runs would make a quiet mailbox look permanently busy.
 */
export type EmptyListReason =
  | 'syncing'
  | 'no-results'
  | 'no-snoozed'
  | 'no-category'
  | 'no-emails';

export function emptyListReason(view: EmptyListView): EmptyListReason {
  if (view.syncing && view.neverSynced) return 'syncing';
  if (view.searching) return 'no-results';
  if (view.snoozed) return 'no-snoozed';
  if (view.aiCategory) return 'no-category';
  return 'no-emails';
}

/** The wording for every non-spinner reason. 'syncing' renders a spinner instead. */
export const EMPTY_LIST_MESSAGES: Record<Exclude<EmptyListReason, 'syncing'>, string> = {
  'no-results': 'No results found',
  'no-snoozed': 'No snoozed emails',
  'no-category': 'No emails in this category',
  'no-emails': 'No emails in this folder',
};
