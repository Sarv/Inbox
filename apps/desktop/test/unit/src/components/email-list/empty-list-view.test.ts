import { describe, expect, it } from 'vitest';

import {
  EMPTY_LIST_MESSAGES,
  emptyListReason,
} from '../../../../../src/components/email-list/empty-list-view';

// ---------------------------------------------------------------------------
// What an empty list SAYS.
//
// The field report this guards: connect a fresh account and the mail list read
// "No emails in this folder" for the whole first sync, while mail was landing
// in the DB a folder at a time. The spinner state keyed off `syncingFolders`
// alone — a map only `syncSingleFolder` writes to — and an account's FIRST pass
// runs through `syncEmails`, which never touches it.
// ---------------------------------------------------------------------------
describe('emptyListReason', () => {
  // THE REGRESSION: a first sync (global `syncing`, folder never synced) must
  // read as "on its way", not as "this folder is empty".
  it('says syncing while a never-synced folder is still being fetched', () => {
    expect(emptyListReason({ syncing: true, neverSynced: true })).toBe('syncing');
  });

  // Breaks: a folder that HAS synced and is genuinely empty would claim to be
  // syncing on every background pass — a quiet mailbox that looks permanently
  // busy and never tells the user it is simply empty.
  it('does not claim to be syncing a folder that has already synced', () => {
    expect(emptyListReason({ syncing: true, neverSynced: false })).toBe('no-emails');
  });

  // Breaks: a never-synced folder the user opened while nothing is running
  // would spin forever with no sync behind it.
  it('does not spin when nothing is syncing', () => {
    expect(emptyListReason({ syncing: false, neverSynced: true })).toBe('no-emails');
  });

  // Breaks: the syncing state must OUTRANK the "nothing here" wordings — a
  // search or a category opened mid-first-sync would report a definitive
  // "No results found" over mail that simply has not arrived yet.
  it.each([
    ['a search', { searching: true }],
    ['the snoozed view', { snoozed: true }],
    ['an AI category', { aiCategory: 'needs-response' }],
  ])('reports syncing over %s while the first sync runs', (_case, view) => {
    expect(emptyListReason({ syncing: true, neverSynced: true, ...view })).toBe('syncing');
  });

  // Breaks: every empty view says "No emails in this folder" — wrong for a
  // search with no hits, and wrong for the snoozed and AI-category lists, which
  // are not folders at all.
  it.each([
    ['a search with no hits', { searching: true }, 'no-results'],
    ['an empty snoozed list', { snoozed: true }, 'no-snoozed'],
    ['an empty AI category', { aiCategory: 'needs-response' }, 'no-category'],
    ['a genuinely empty folder', {}, 'no-emails'],
  ])('names %s', (_case, view, expected) => {
    expect(emptyListReason(view)).toBe(expected);
  });

  // Breaks: search is the view the user is actively looking at; a stale snoozed
  // or category flag underneath it would relabel their results.
  it('lets a search outrank a leftover snoozed or category flag', () => {
    expect(emptyListReason({ searching: true, snoozed: true, aiCategory: 'reminders' }))
      .toBe('no-results');
  });

  // Breaks: an absent flag (undefined, not false) reads as truthy somewhere and
  // a plain empty folder gets another view's wording.
  it('treats absent flags as not set', () => {
    expect(emptyListReason({ aiCategory: null })).toBe('no-emails');
  });
});

describe('EMPTY_LIST_MESSAGES', () => {
  // Breaks: a reason with no wording renders `undefined` into the list — a
  // blank panel where an explanation should be.
  it('has wording for every reason but the spinner', () => {
    for (const reason of ['no-results', 'no-snoozed', 'no-category', 'no-emails'] as const) {
      expect(EMPTY_LIST_MESSAGES[reason]).toBeTruthy();
    }
    expect('syncing' in EMPTY_LIST_MESSAGES).toBe(false);
  });
});
