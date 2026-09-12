import { describe, expect, it } from 'vitest';

import {
  buildStandardFolderAliasMap,
  describeDuplicateRoles,
  classifyFolder,
  findFolderByType,
  folderTypeMatchStrength,
  isTrashFolder,
  isSpamFolder,
} from '../../../src/config/folder-mapping';

// Regression for the data-loss/mis-routing class where destructive paths matched
// folder TYPE by substring (`path.toLowerCase().includes('trash'|'spam'|'archive')`).
// A user folder whose name merely CONTAINS "trash"/"spam"/"archive" would then be
// treated as the real Trash/Spam/Archive — a bulk delete there expunged mail
// permanently, and moves mis-routed. classifyFolder/findFolderByType must match
// EXACTLY (special-use → known path → exact last-segment name), never a substring.

describe('folder classification is exact, not substring (no destructive mis-match)', () => {
  it('classifies the real Trash/Spam/Archive folders', () => {
    expect(classifyFolder({ path: 'Trash' })).toBe('trash');
    expect(classifyFolder({ path: '[Gmail]/Trash' })).toBe('trash');
    expect(classifyFolder({ path: 'Deleted Items' })).toBe('trash');
    expect(classifyFolder({ path: 'Spam' })).toBe('spam');
    expect(classifyFolder({ path: 'Junk Email' })).toBe('spam');
    expect(classifyFolder({ path: '[Gmail]/All Mail' })).toBe('archive');
  });

  it('does NOT misclassify custom folders that merely contain the substring', () => {
    // These are the folders the old `.includes(...)` logic would have wrongly
    // treated as Trash/Spam/Archive — and permanently expunged / mis-routed.
    expect(classifyFolder({ path: 'Trash Pandas' })).not.toBe('trash');
    expect(classifyFolder({ path: 'Notes/trashy-ideas' })).not.toBe('trash');
    expect(classifyFolder({ path: 'metrash' })).not.toBe('trash');
    expect(classifyFolder({ path: 'Spam Reports' })).not.toBe('spam');
    expect(classifyFolder({ path: 'My Archive 2023' })).not.toBe('archive');
    expect(isTrashFolder({ path: 'Trash Pandas' })).toBe(false);
    expect(isSpamFolder({ path: 'Spam Reports' })).toBe(false);
  });

  it('special-use wins and is authoritative regardless of the display name', () => {
    expect(classifyFolder({ path: 'Papelera', specialUse: '\\Trash' })).toBe('trash');
    expect(isTrashFolder({ path: 'Papelera', specialUse: '\\Trash' })).toBe(true);
  });

  it('findFolderByType picks the real folder, never a substring-collision one', () => {
    const folders = [
      { path: 'Trash Pandas' },        // decoy — contains "trash"
      { path: 'Archive of Spam' },     // decoy — contains "spam" AND "archive"
      { path: 'Trash' },               // the real Trash
      { path: 'Spam' },                // the real Spam
    ];
    expect(findFolderByType(folders, 'trash')?.path).toBe('Trash');
    expect(findFolderByType(folders, 'spam')?.path).toBe('Spam');
  });

  it('findFolderByType returns null when no real folder of that type exists', () => {
    // Only decoys present → must NOT fall back to a substring match.
    expect(findFolderByType([{ path: 'Trash Pandas' }, { path: 'Spam Reports' }], 'trash')).toBeNull();
  });
});

// Regression for the Sent folder that showed one message next to "of 1,719".
// Sarv's IMAP server lists TWO mailboxes for the same physical Sent store —
// `Sent` (the real one, where every sent copy lands) and an alias `Sent Mail`.
// findFolderByType used to return whichever the server listed first, so the
// sidebar, the sent-copy APPEND and the label role map all pointed at the
// alias: an empty list under a server-sized count, with "next" leading nowhere.
describe('two mailboxes for one role — the strongest match wins, not the first listed', () => {
  const sarvFolders = [
    { path: 'INBOX' },
    { path: 'Sent Mail' },  // alias, name-heuristic only — listed FIRST
    { path: 'Sent' },       // the real mailbox, a known provider path
  ];

  // Breaks: the user's Sent view lists an empty alias while their mail sits in
  // `Sent`, and new sent copies are appended to the alias too.
  it('prefers the known provider path over a folder that merely looks the part', () => {
    expect(findFolderByType(sarvFolders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: the server's own SPECIAL-USE answer stops being authoritative — the
  // one signal that cannot be a guess.
  it('still lets SPECIAL-USE beat every known path, wherever it is listed', () => {
    const flagged = [{ path: 'Sent' }, { path: 'Elküldött', specialUse: '\\Sent' }];
    expect(findFolderByType(flagged, 'sent')?.path).toBe('Elküldött');
  });

  // Breaks: the preference order inside STANDARD_FOLDER_MAP stops meaning
  // anything — e.g. Gmail's own `[Gmail]/Sent Mail` losing to a stray `Sent`.
  it('ranks known paths by their position in the provider list', () => {
    const gmail = [{ path: 'Sent' }, { path: '[Gmail]/Sent Mail' }];
    expect(findFolderByType(gmail, 'sent')?.path).toBe('[Gmail]/Sent Mail');
  });

  // Breaks: an equally-strong pair starts flip-flopping between syncs, so which
  // mailbox the app routes to depends on the server's listing order.
  it('keeps list order between equally strong candidates', () => {
    // Both match on the name alone ('Sent Messages' would NOT — it is a known
    // iCloud path, and would rightly outrank them).
    const twoHeuristics = [{ path: 'Sent Mail' }, { path: 'Old/Sent Mail' }];
    expect(findFolderByType(twoHeuristics, 'sent')?.path).toBe('Sent Mail');
  });

  // Breaks: the ranking widens or narrows the match set instead of only
  // ORDERING it — a folder that is not of this type must stay unrankable.
  it('scores by tier and refuses to score a folder of another type', () => {
    expect(folderTypeMatchStrength({ path: 'Sent', specialUse: '\\Sent' }, 'sent')).toBe(0);
    expect(folderTypeMatchStrength({ path: '[Gmail]/Sent Mail' }, 'sent'))
      .toBeLessThan(folderTypeMatchStrength({ path: 'Sent' }, 'sent')!);
    expect(folderTypeMatchStrength({ path: 'Sent' }, 'sent'))
      .toBeLessThan(folderTypeMatchStrength({ path: 'Sent Mail' }, 'sent')!);
    expect(folderTypeMatchStrength({ path: 'Trash' }, 'sent')).toBeNull();
    expect(folderTypeMatchStrength({ path: 'Work' }, 'sent')).toBeNull();
  });
});

// The other half of the same defect: out-ranking the alias fixes which mailbox
// the app ROUTES to, but the alias is still a folder — with its own sync state,
// its own backfill and its own counts, none of which anything can display. The
// alias map is what lets sync and backfill skip it entirely.
// Two names for ONE physical mailbox, as the server reports them: same
// UIDVALIDITY, same EXISTS. Without both, nothing below may be collapsed.
const twin = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  uidValidity: 7,
  serverMessageCount: 1718,
  totalCount: 0,
  ...extra,
});

describe('findFolderByType — two names for one mailbox', () => {
  // Breaks: THE bug this rule exists for, seen in production on 2026-09-11.
  // Sarv puts SPECIAL-USE `\\Sent` on `Sent Mail` while all 1,713 sent messages
  // are filed under `Sent`; dedup by message-id means `Sent Mail` can never gain
  // a row. Ranking alone picked `Sent Mail`, so the sidebar showed an empty
  // folder under a 1,719 count with a next page that was always blank.
  it('prefers the folder holding the mail over its empty SPECIAL-USE twin', () => {
    const folders = [
      twin('Sent Mail', { specialUse: '\\Sent' }),
      twin('Sent', { totalCount: 1713 }),
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: THE live account, as the log and the sidebar showed it on
  // 2026-09-12. `total_count` counts membership TAGS, so BOTH names read ~1,718
  // and the tag count can no longer tell them apart — the earlier fix read that
  // as "both hold their own mail" and left the role on the empty `Sent Mail`,
  // whose listing hides every row also tagged `|Sent|`: one message under a
  // header saying 1,719. Primary filing (`emails.folder_id`) is the count that
  // still separates them, 1,718 against 1.
  it('follows the filed mail when both names are fully TAGGED', () => {
    const folders = [
      {
        path: 'Sent Mail', specialUse: '\\Sent', uidValidity: 7,
        serverMessageCount: 1718, totalCount: 1718, ownedCount: 1,
      },
      {
        path: 'Sent', uidValidity: 7,
        serverMessageCount: 1713, totalCount: 1719, ownedCount: 1718,
      },
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // KNOWN LIMITATION, deliberately pinned: with only tag counts, this account is
  // undecidable — a shared message is tagged under BOTH names, so both read full
  // and the rail correctly says "these look like two real mailboxes", handing the
  // role to the SPECIAL-USE name that happens to be empty. Nothing in the counts
  // can do better; the fix is that every caller (sync engine, list-folders IPC)
  // attaches filed counts for contested roles BEFORE asking. If this ever starts
  // returning `Sent`, the discriminator changed — check the test above still
  // covers the measured case rather than loosening this one.
  it('cannot tell the two apart from tag counts alone (known limitation)', () => {
    const folders = [
      twin('Sent Mail', { specialUse: '\\Sent', totalCount: 1718 }),
      twin('Sent', { totalCount: 1719 }),
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent Mail');
  });

  // Breaks: a fresh account, where nothing has been synced and both are empty.
  // The row count decides nothing there, so the ranking must still apply —
  // and once mail lands the winner keeps winning, which is what makes the
  // choice stable rather than flapping folder to folder.
  it('falls back to the ranking when neither twin holds mail yet', () => {
    const folders = [twin('Sent Mail'), twin('Sent', { specialUse: '\\Sent' })];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: the safety rail. Two mailboxes that merely share a role are NOT
  // interchangeable — an account can have a real `Sent` and a real `Sent Items`
  // with different mail — so a bigger row count must not move the role onto a
  // folder the server never said was the same store.
  it('ignores the row count when the two are different mailboxes', () => {
    const folders = [
      { path: 'Sent', specialUse: '\\Sent', uidValidity: 7, serverMessageCount: 3, totalCount: 3 },
      { path: 'Sent Items', uidValidity: 9, serverMessageCount: 900, totalCount: 900 },
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: the same rail, for the server that reuses one UIDVALIDITY across
  // every mailbox — so the server's own evidence cannot be trusted to separate
  // them. Mail under BOTH names does it instead: a message is filed once and
  // never inserted twice, so one store can only ever fill one of its names.
  it('ignores the row count when both names hold mail of their own', () => {
    const folders = [
      { path: 'Sent', specialUse: '\\Sent', uidValidity: 7, serverMessageCount: 3, totalCount: 3 },
      { path: 'Sent Items', uidValidity: 7, serverMessageCount: 900, totalCount: 900 },
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: the reader on a server that does not report UIDVALIDITY being left
  // on the empty name forever. Showing a folder is not dropping one, so equal
  // server counts are proof enough HERE — the collapse below still refuses.
  it('follows the mail when the counts match and the server gave no UIDVALIDITY', () => {
    const folders = [
      { path: 'Sent Mail', specialUse: '\\Sent', serverMessageCount: 1718, totalCount: 0 },
      { path: 'Sent', serverMessageCount: 1718, totalCount: 1713 },
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
    // …and nothing is dropped from sync on that weaker evidence.
    expect(buildStandardFolderAliasMap(folders).size).toBe(0);
  });

  // Breaks: a LIST entry (no sync state at all) being read as "same mailbox" —
  // every field would be null/absent on both sides and compare equal.
  it('ignores the row count when the server has proven nothing', () => {
    const folders = [{ path: 'Sent', specialUse: '\\Sent' }, { path: 'Sent Mail', totalCount: 1713 }];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });
});

describe('buildStandardFolderAliasMap — collapsing a role the server published twice', () => {
  // Breaks: both mailboxes keep syncing, so the same mail is fetched twice and
  // the copy under the hidden name accrues counts the UI can never show.
  it('maps the duplicate mailbox to the canonical one', () => {
    const aliases = buildStandardFolderAliasMap([
      { path: 'INBOX' },
      twin('Sent Mail'),
      twin('Sent', { totalCount: 1713 }),
    ]);
    expect([...aliases]).toEqual([['Sent Mail', 'Sent']]);
  });

  // Breaks: the live account's collapse, which never fired. The two names are
  // SELECTed at different moments, so their stored EXISTS disagree (1,718 vs
  // 1,713) — demanding an exact match left both syncing and left the role on
  // the name whose listing shows nothing. Filed counts say which one holds the
  // mail; a few rows of drift must not veto the collapse.
  it('collapses the alias even when the two EXISTS snapshots drifted apart', () => {
    const aliases = buildStandardFolderAliasMap([
      { path: 'INBOX' },
      {
        path: 'Sent Mail', specialUse: '\\Sent', uidValidity: 7,
        serverMessageCount: 1718, totalCount: 1718, ownedCount: 1,
      },
      {
        path: 'Sent', uidValidity: 7,
        serverMessageCount: 1713, totalCount: 1719, ownedCount: 1718,
      },
    ]);
    expect([...aliases]).toEqual([['Sent Mail', 'Sent']]);
  });

  // Breaks: the drift tolerance swallowing a genuinely smaller mailbox. Two
  // names 200 messages apart are two stores, whatever else they share.
  it('still refuses to collapse when the counts are properly far apart', () => {
    const aliases = buildStandardFolderAliasMap([
      twin('Sent Mail', { specialUse: '\\Sent', totalCount: 1718, ownedCount: 1 }),
      twin('Sent', { serverMessageCount: 1500, totalCount: 1719, ownedCount: 1718 }),
    ]);
    expect(aliases.size).toBe(0);
  });

  // Breaks: the ordinary account (one mailbox per role) paying for a collapse it
  // does not need — worse, losing a folder to it.
  it('is empty for an account with one mailbox per role', () => {
    const aliases = buildStandardFolderAliasMap([
      { path: 'INBOX' }, { path: 'Sent' }, { path: 'Drafts' }, { path: 'Trash' }, { path: 'Spam' },
    ]);
    expect(aliases.size).toBe(0);
  });

  // Breaks: THE data-loss risk of collapsing at all. A folder the USER made and
  // happens to have named like a system one must never be folded into the
  // account's Sent — its mail would stop syncing and show under a name that is
  // not its own. Only a top-level (or known provider) mailbox can be an alias,
  // however identical the server makes the two look.
  it('never collapses a nested folder the user made', () => {
    const aliases = buildStandardFolderAliasMap([
      twin('Sent'), twin('Archive/Sent'), twin('Clients/Drafts'), twin('Drafts'),
    ]);
    expect(aliases.size).toBe(0);
  });

  // Breaks: Gmail's `[Gmail]/Sent Mail` — a known provider path, nested under
  // the `[Gmail]` namespace — being treated as a user folder, so a stray
  // top-level `Sent` label keeps syncing beside it.
  it('collapses a known provider path into the canonical mailbox', () => {
    const aliases = buildStandardFolderAliasMap([
      twin('[Gmail]/Sent Mail'), twin('Sent'),
    ]);
    expect(aliases.get('Sent')).toBe('[Gmail]/Sent Mail');
  });

  // Breaks: Gmail accounts losing their own Archive folder. `[Gmail]/All Mail`
  // and `Archive` both classify as archive but are genuinely different
  // mailboxes — this is why archive is excluded from the collapse.
  it('leaves archive alone — All Mail and Archive are not the same mailbox', () => {
    const aliases = buildStandardFolderAliasMap([
      twin('[Gmail]/All Mail'), twin('Archive'),
    ]);
    expect(aliases.size).toBe(0);
  });

  // DELIBERATE REVERSAL of an earlier assertion here, which expected the
  // SPECIAL-USE mailbox to win outright. Shipping that stopped the sync of the
  // one folder that held the user's sent mail, because Sarv flags the EMPTY
  // name. Among names proven to be one store, the mail decides — and every
  // alias must still resolve to whatever findFolderByType returns, never to
  // each other.
  it('collapses every duplicate onto the mailbox holding the mail, SPECIAL-USE or not', () => {
    const aliases = buildStandardFolderAliasMap([
      twin('Sent Mail'),
      twin('Sent', { totalCount: 1713 }),
      twin('Elküldött', { specialUse: '\\Sent' }),
    ]);
    expect([...aliases.values()].every((p) => p === 'Sent')).toBe(true);
    expect([...aliases.keys()].sort()).toEqual(['Elküldött', 'Sent Mail']);
  });

  // Breaks: the worst case of a server that reuses UIDVALIDITY and reports the
  // same count for both names — two REAL mailboxes look like one, and the
  // smaller would stop syncing. Each name being FULL against its own server
  // count vetoes the collapse: that is the one signal a lying server cannot
  // forge, because a message is filed once and never inserted twice, so one
  // store can only ever fill one of its names.
  it('collapses nothing when both names are full of their own mail', () => {
    const aliases = buildStandardFolderAliasMap([
      twin('Sent', { totalCount: 1713 }),
      twin('Sent Items', { totalCount: 1700 }),
    ]);
    expect(aliases.size).toBe(0);
  });

  // Breaks: a role with two aliases (a server exposing Trash + Deleted + Bin)
  // silently keeping one of them.
  it('collapses every duplicate of a role, not just the first', () => {
    const aliases = buildStandardFolderAliasMap([
      twin('Trash'), twin('Deleted'), twin('Bin'),
    ]);
    expect([...aliases.keys()].sort()).toEqual(['Bin', 'Deleted']);
  });

  // Breaks: the rail that makes collapsing safe at all. Sharing a role is not
  // evidence of sharing a store; dropping a mailbox on a guess stops its mail
  // from ever arriving. Before both have been selected once there is no proof,
  // so both must keep syncing.
  it('collapses nothing until the server has proven the two are one mailbox', () => {
    expect(buildStandardFolderAliasMap([{ path: 'Sent Mail' }, { path: 'Sent' }]).size).toBe(0);
    expect(
      buildStandardFolderAliasMap([
        twin('Sent'),
        twin('Sent Items', { uidValidity: 9 }),
      ]).size,
    ).toBe(0);
    expect(
      buildStandardFolderAliasMap([
        twin('Sent'),
        twin('Sent Items', { serverMessageCount: 12 }),
      ]).size,
    ).toBe(0);
  });
});

/**
 * The log line that makes this diagnosable. Both the sync engine and the folder
 * IPC print it, so what the log says and what the sidebar shows are decided by
 * one function — the previous version of this bug was invisible in the log and
 * got "fixed" twice on a guess.
 */
describe('describeDuplicateRoles', () => {
  // Breaks: silence on the ordinary account, which is what makes the line
  // readable when it does appear.
  it('says nothing when every role has one mailbox', () => {
    expect(describeDuplicateRoles([{ path: 'INBOX' }, { path: 'Sent' }, { path: 'Trash' }])).toBeNull();
  });

  // Breaks: a report that names the winner but not why — the sync state IS the
  // evidence, and without it the next reader is guessing again.
  it('names every candidate, its sync state and the winner', () => {
    const summary = describeDuplicateRoles([
      { path: 'Sent Mail', specialUse: '\\Sent', uidValidity: 7, serverMessageCount: 1718, totalCount: 0 },
      { path: 'Sent', uidValidity: 7, serverMessageCount: 1718, totalCount: 1713 },
    ]);
    expect(summary).toBe(
      'sent: Sent Mail (uidValidity=7, tagged=0, filed=unmeasured, server=1718, specialUse=\\Sent) | ' +
        'Sent (uidValidity=7, tagged=1713, filed=unmeasured, server=1718) -> Sent',
    );
  });

  // Breaks: the case that actually needs explaining — a duplicate that was NOT
  // collapsed. "uidValidity=none" in the line is the whole answer.
  it('shows the missing evidence when a mailbox has never been selected', () => {
    const summary = describeDuplicateRoles([{ path: 'Sent Mail' }, { path: 'Sent' }]);
    expect(summary).toContain('uidValidity=none');
    expect(summary).toContain('server=unknown');
  });
});
